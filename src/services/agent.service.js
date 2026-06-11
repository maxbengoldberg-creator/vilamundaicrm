import { callClaude, buildSystemPrompt } from './claude.service.js';
import { getStageModel } from './stage.prompts.js';
import { buildReceptionPrompt } from './reception.prompt.js';
import { TOOLS } from '../tools/index.js';
import { HANDLERS } from '../tools/handlers.js';
import { zapi } from './zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Cliente from '../models/cliente.model.js';
import * as Setting from '../models/setting.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';
import * as AutomationStage from '../models/automation_stage.model.js';

// O fechamento da venda encadeia até 6 ferramentas numa única resposta do lead
// (extrair dados, salvar condições, 2x mover funil, criar reserva, escalar).
const MAX_TOOL_ROUNDS = 10;

// Resolve qual stage de prompt realmente usar, aplicando condicionais por tag.
// Item 1: tag "ganho" auto-corrige o stage no banco se necessário.
// Item 3: blocked_tags da etapa atual desviam para "ganho".
async function resolveEffectiveStage(lead) {
  const tags = Array.isArray(lead.tags) ? lead.tags : [];

  if (tags.includes('ganho') && lead.stage !== 'ganho') {
    await Lead.update(lead.id, { stage: 'ganho' });
    return 'ganho';
  }

  try {
    const stageData = await AutomationStage.getByStage(lead.stage);
    const blocked = stageData?.trigger_conditions?.blocked_tags || [];
    if (blocked.length > 0 && blocked.some(t => tags.includes(t))) {
      return 'ganho';
    }
  } catch {
    // Se o banco falhar, segue com o stage atual sem bloquear o atendimento
  }

  return lead.stage;
}

function saudacao() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' })).getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

// Contexto extra injetado no system prompt apenas na primeira mensagem da
// conversa: dá ao Claude a saudação certa pelo horário e a instrução de
// responder tudo — apresentação + o que o lead trouxer — em uma única
// mensagem, em vez de mandar uma abertura fixa e esperar a próxima resposta.
function primeiraMensagemContexto() {
  return `\n\nCONTEXTO — PRIMEIRA MENSAGEM DESTA CONVERSA:
O lead ainda não te conhece. Use a saudação "${saudacao()}" e apresente-se brevemente como Max, host da Vila Mundaí.
Na MESMA mensagem, responda também ao que o lead trouxer (pergunta, pedido, comentário) — nunca mande só a saudação/apresentação e deixe o resto para a próxima resposta. O lead não pode ficar sem resposta ao que ele perguntou.`;
}

// Mensagem do operador (botão Prompt do funil), anexada como turno do usuário.
// Deixa explícito que é uma ORDEM, não fala do lead, e que o histórico é só contexto.
function instrucaoOperadorUser(text) {
  return `[INSTRUÇÃO DO OPERADOR — isto NÃO é o lead falando]
${text}

Execute exatamente esta instrução agora. Use o histórico da conversa só para entender o contexto e manter coerência: NÃO reresponda perguntas antigas, NÃO reenvie fotos, vídeos nem mapa, NÃO refaça orçamento ou disponibilidade. Apenas cumpra a instrução acima e dê continuidade de forma natural.`;
}

// Bloco anexado ao system prompt quando a ação parte do operador.
function instrucaoOperadorSystem() {
  return `\n\nPRIORIDADE MÁXIMA — ORDEM DO OPERADOR: a última mensagem é uma ordem de um operador humano, não do lead. Faça SOMENTE o que ela pede. O histórico serve apenas para você entender o que já aconteceu e não repetir nem contradizer. Não execute a rotina padrão da etapa e não use ferramentas de envio de mídia, orçamento ou disponibilidade, a menos que a ordem peça isso explicitamente.`;
}

// Mensagem fixa de abertura para leads de anúncio (Meta Ads) na primeira mensagem.
function aberturaAnuncio() {
  return `${saudacao()}, eu sou o Max, host da Vila Mundaí, tudo bem? Me conta, já tem datas pra viagem?`;
}

// Detecta a mensagem automática de anúncio "Click to WhatsApp" do Meta.
// Ex.: "Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.
//       nome_completo: ... email: ... telefone: ..."
function pareceAnuncio(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (/preenchi\s+(seu|o)\s+formul[aá]rio/.test(t)) return true;
  // padrão de campos do formulário colados na mensagem
  const campos = [/nome_completo\s*:/, /telefone\s*:/, /e-?mail\s*:/];
  return campos.filter(re => re.test(t)).length >= 2;
}

function isMsgCurta(text) {
  return text.trim().split(/\s+/).length <= 6;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lock por telefone: evita dois handleIncoming concorrentes para o mesmo lead.
// Se uma segunda mensagem chega enquanto a primeira ainda processa, ela é salva
// no banco (Message.create acontece antes do lock) e o invocation em andamento
// já a lê via listRecent depois do delay.
const _processing = new Map();
function acquireLock(phone) {
  if (_processing.has(phone)) return false;
  _processing.set(phone, true);
  return true;
}
function releaseLock(phone) { _processing.delete(phone); }

function toClaudeMessages(rows) {
  let msgs = [];
  for (const r of rows) {
    if (r.raw) msgs.push(r.raw);
    else if (r.role === 'user' || r.role === 'assistant') msgs.push({ role: r.role, content: r.content });
  }

  // Remove órfãos iterativamente até estabilizar.
  // O bug original: os dois while separados rodavam uma vez cada — o segundo
  // removia um assistant:tool_use do início, expondo um user:tool_result que o
  // primeiro while já não ia mais remover.
  let stable = false;
  while (!stable) {
    stable = true;

    // 1. Remove leading non-user
    while (msgs.length && msgs[0].role !== 'user') {
      msgs.shift();
      stable = false;
    }

    // 2. Remove leading user:tool_result (sem assistant:tool_use precedente)
    while (msgs.length) {
      const first = msgs[0];
      const hasToolResult = Array.isArray(first.content) && first.content.some(b => b?.type === 'tool_result');
      if (first.role === 'user' && hasToolResult) {
        console.log('[toClaudeMessages] tool_result orfao no inicio da janela, removendo');
        msgs.shift();
        stable = false;
      } else {
        break;
      }
    }

    // 3. Varredura completa: tool_result cujo tool_use_id não existe no assistant anterior
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      const toolResults = msg.content.filter(b => b?.type === 'tool_result');
      if (toolResults.length === 0) continue;

      const prev = msgs[i - 1];
      const prevToolUseIds = new Set(
        (prev?.role === 'assistant' && Array.isArray(prev.content) ? prev.content : [])
          .filter(b => b?.type === 'tool_use').map(b => b.id)
      );
      const orphans = toolResults.filter(b => !prevToolUseIds.has(b.tool_use_id));

      if (orphans.length > 0) {
        const ids = orphans.map(b => b.tool_use_id).join(', ');
        if (prev?.role === 'assistant') {
          console.log(`[toClaudeMessages] par orfao tool_use/tool_result ids=[${ids}], removendo posicoes ${i - 1} e ${i}`);
          msgs.splice(i - 1, 2);
        } else {
          console.log(`[toClaudeMessages] tool_result orfao ids=[${ids}] sem assistant anterior, removendo posicao ${i}`);
          msgs.splice(i, 1);
        }
        stable = false;
        break; // reinicia a varredura
      }
    }
  }

  return msgs;
}

export async function handleIncoming({ phone, text, pushName, operador = false }) {
  const robotOn = await Setting.get('robot_enabled', true);
  // Ordem do operador roda mesmo com o robô desligado ou a IA pausada no lead.
  if (!operador && robotOn === false) {
    // Robô geral desligado: a IA não responde, mas a mensagem do lead ainda
    // precisa ser gravada para aparecer no painel (atendimento humano).
    const cli = await Cliente.findByPhone(phone);
    let leadId = null;
    if (!cli) {
      let lead = await Lead.findByPhone(phone);
      if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });
      leadId = lead.id;
    }
    await persistInbound(leadId, phone, text);
    return { skipped: true, reason: 'robot_desligado_geral' };
  }
  const cliente = await Cliente.findByPhone(phone);
  if (cliente) {
    return handleClienteMessage({ cliente, phone, text });
  }

  let lead = await Lead.findByPhone(phone);
  if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });

  if (!operador && !lead.ai_enabled) {
    await persistInbound(lead.id, phone, text);
    return { skipped: true, reason: 'ia_pausada' };
  }

  let conv = await Conversation.findOpenByPhone(phone);
  const isFirstMessage = !conv;
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });

  // Anúncio Click-to-WhatsApp: detecta pelo texto automático do formulário.
  // Marca a origem no lead (pra refletir no CRM) já que não passa pelo webhook do Meta.
  if (!operador && isFirstMessage && lead.origem !== 'meta_ads' && pareceAnuncio(text)) {
    await Lead.update(lead.id, { origem: 'meta_ads' });
    lead.origem = 'meta_ads';
    console.log(`[agente] lead ${phone} detectado como anúncio pelo texto — origem marcada como meta_ads`);
  }

  // A ordem do operador NÃO é gravada como mensagem do lead (não polui o painel
  // nem o histórico). Só a resposta do agente será persistida.
  if (!operador) {
    await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
    await Conversation.touch(conv.id, text);
  }

  // Se já há um processamento em andamento para este lead, a mensagem já está
  // salva no banco e será lida pelo invocation ativo via listRecent após o delay.
  if (!acquireLock(phone)) {
    console.log(`[agente] lead ${phone} — mensagem enfileirada (outro processamento em curso)`);
    return { skipped: true, reason: 'processamento_em_curso' };
  }

  try {
  // Lead de anúncio (Meta Ads) na primeira mensagem: abertura fixa, 10s de delay,
  // sem chamar o Claude. A mensagem do lead é o texto automático do formulário.
  if (!operador && isFirstMessage && lead.origem === 'meta_ads') {
    await delay(10000);
    const abertura = aberturaAnuncio();
    await zapi.sendText(phone, abertura);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: abertura, raw: { role: 'assistant', content: abertura }, sender: 'ia' });
    await Conversation.touch(conv.id, abertura);
    console.log(`[agente] lead ${phone} anúncio — abertura fixa enviada (delay 10s)`);
    return { ok: true, reply: abertura, modo: 'abertura_anuncio' };
  }

  // Ordem do operador é imediata (sem delay de digitação).
  if (!operador) {
    if (isFirstMessage) await delay(40000);
    else if (isMsgCurta(text)) await delay(15000);
    else await delay(5000);
  }

  const history = await Message.listRecent(conv.id, 20);
  let messages = toClaudeMessages(history);
  // Anexa a ordem do operador como último turno do usuário (não foi persistida).
  if (operador) messages.push({ role: 'user', content: instrucaoOperadorUser(text) });
  console.log(`[agente] lead ${phone} historico=${history.length}msgs janela=${messages.length}msgs primeira_role=${messages[0]?.role || '-'} ultima_role=${messages[messages.length-1]?.role || '-'}`);

  // Texto que o Claude emite ao longo das rodadas. O modelo costuma mandar texto
  // JUNTO com um tool_use (stop_reason=tool_use); esse texto precisa ser enviado
  // ao lead, senão a fala se perde e na rodada seguinte o modelo não repete (retorna ~vazio).
  const partes = [];
  let lastStop = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const effectiveStage = await resolveEffectiveStage(lead);
    let [system, model] = await Promise.all([
      buildSystemPrompt({ ...lead, stage: effectiveStage }),
      getStageModel(effectiveStage),
    ]);
    if (isFirstMessage && !operador) {
      system += primeiraMensagemContexto();
      console.log(`[agente] lead ${phone} primeira mensagem da conversa — contexto de abertura injetado no system prompt`);
    }
    if (operador) system += instrucaoOperadorSystem();
    if (!system || !system.trim()) {
      console.error(`[agente] ALERTA prompt VAZIO para stage=${effectiveStage} (cache/banco?). lead ${phone}`);
    }
    console.log(`[agente] lead ${phone} round=${round} stage=${lead.stage} prompt=${effectiveStage} model=${model} system_len=${system?.length || 0} msgs=${messages.length}`);
    const resp = await callClaude({ system, messages, tools: TOOLS, model, lead_id: lead.id });
    lastStop = resp.stop_reason;

    const tipos = Array.isArray(resp.content) ? resp.content.map(b => b.type) : [typeof resp.content];
    const texto = textOf(resp.content);
    const tools = Array.isArray(resp.content) ? resp.content.filter(b => b.type === 'tool_use').map(b => b.name) : [];
    console.log(`[agente] lead ${phone} round=${round} stop=${resp.stop_reason} blocos=[${tipos.join(',')}] texto_len=${texto.length} tools=[${tools.join(',')}]`);

    const assistantMsg = { role: 'assistant', content: resp.content };
    // Claude às vezes devolve content vazio (array []). Não empilha nem salva
    // mensagem em branco — só registra respostas com texto ou tool_use.
    const temConteudo = Array.isArray(resp.content) && resp.content.length > 0;
    if (temConteudo) {
      messages.push(assistantMsg);
      await Message.create({ conversation_id: conv.id, role: 'assistant', content: texto, raw: assistantMsg, sender: 'ia' });
    } else {
      console.warn(`[agente] lead ${phone} round=${round} resposta SEM conteudo (content vazio) — nada salvo/enviado.`);
    }

    // Guarda qualquer texto desta rodada (inclusive o que veio junto com tool_use).
    if (texto && texto.trim()) partes.push(texto.trim());

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try { result = handler ? await handler(block.input || {}, { lead, phone }) : { ok: false, erro: `ferramenta ${block.name} nao existe` }; }
        catch (e) { result = { ok: false, erro: e.message }; console.error(`[agente] lead ${phone} ERRO handler ${block.name}:`, e.message); }
        const okFlag = result && typeof result === 'object' ? result.ok : undefined;
        console.log(`[agente] lead ${phone} tool=${block.name} ok=${okFlag} input=${JSON.stringify(block.input || {})}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      const toolMsg = { role: 'user', content: toolResults };
      messages.push(toolMsg);
      await Message.create({ conversation_id: conv.id, role: 'user', content: '[ferramentas]', raw: toolMsg, sender: 'ia' });
      continue;
    }
    break;
  }

  // Se as rodadas estouraram com o modelo ainda encadeando ferramentas, o texto
  // de fechamento nunca foi gerado e o lead ficaria no vácuo. Força uma última
  // resposta SÓ de texto (tool_choice none) para encerrar a fala.
  if (lastStop === 'tool_use') {
    console.warn(`[agente] lead ${phone} rodadas esgotadas em tool_use — forçando resposta final de texto`);
    try {
      lead = await Lead.findByPhone(phone);
      const effectiveStage = await resolveEffectiveStage(lead);
      const [system, model] = await Promise.all([
        buildSystemPrompt({ ...lead, stage: effectiveStage }),
        getStageModel(effectiveStage),
      ]);
      const resp = await callClaude({ system, messages, tools: TOOLS, tool_choice: { type: 'none' }, model, lead_id: lead.id });
      const texto = textOf(resp.content);
      if (texto && texto.trim()) {
        partes.push(texto.trim());
        const assistantMsg = { role: 'assistant', content: resp.content };
        messages.push(assistantMsg);
        await Message.create({ conversation_id: conv.id, role: 'assistant', content: texto, raw: assistantMsg, sender: 'ia' });
      }
    } catch (e) {
      console.error(`[agente] lead ${phone} ERRO no fechamento forçado:`, e.message);
    }
  }

  // Junta tudo que o Claude falou nas rodadas (texto solto + texto junto a tool_use).
  const finalText = partes.join('\n\n');
  if (finalText && finalText.trim()) {
    const blocos = finalText.split(/\n\n+/).map(b => b.trim()).filter(Boolean);
    console.log(`[agente] lead ${phone} ENVIANDO ${blocos.length} bloco(s), total_len=${finalText.length}`);
    for (let i = 0; i < blocos.length; i++) {
      if (i > 0) await delay(4000);
      await zapi.sendText(phone, blocos[i]);
    }
    await Conversation.touch(conv.id, finalText);
  } else {
    console.warn(`[agente] lead ${phone} NADA a enviar (nenhum texto nas ${MAX_TOOL_ROUNDS} rodadas).`);
  }
  return { ok: true, reply: finalText };
  } finally {
    releaseLock(phone);
  }
}

async function handleClienteMessage({ cliente, phone, text }) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: null, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  if (!cliente.ai_enabled) {
    return { skipped: true, reason: 'ia_pausada_cliente' };
  }

  if (isMsgCurta(text)) await delay(15000); else await delay(5000);

  const history = await Message.listRecent(conv.id, 20);
  let messages = toClaudeMessages(history);
  const system = buildReceptionPrompt(cliente);

  const resp = await callClaude({ system, messages, tools: TOOLS });
  let finalText = textOf(resp.content);

  if (finalText && finalText.trim()) {
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: finalText, sender: 'ia' });
    await zapi.sendText(phone, finalText);
    await Conversation.touch(conv.id, finalText);
  }
  return { ok: true, reply: finalText, modo: 'recepcao' };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function persistInbound(leadId, phone, text) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: leadId, phone });
  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);
}

// Grava no painel uma mensagem que NÓS enviamos (fromMe): pode ter vindo do app
// do celular, da IA ou do envio manual pelo CRM. Para o operador, tudo que sai
// do nosso número aparece como atendimento humano. Deduplica para não duplicar
// o que a IA (sender 'ia') ou o envio pelo CRM (sender 'humano') já gravaram.
export async function persistOutboundHuman({ phone, text }) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) {
    // Sem conversa aberta: cria vinculada ao lead (ou cliente) se existir.
    const cli = await Cliente.findByPhone(phone);
    let leadId = null;
    if (!cli) {
      const lead = await Lead.findByPhone(phone);
      if (lead) leadId = lead.id;
    }
    conv = await Conversation.create({ lead_id: leadId, phone });
  }
  // Dedup: mesma mensagem já gravada nos últimos 120s (eco da IA ou do CRM).
  const jaExiste = await Message.existsRecentByContent(conv.id, text, 120);
  if (jaExiste) return { skipped: true, reason: 'duplicada' };
  await Message.create({ conversation_id: conv.id, role: 'assistant', content: text, sender: 'humano' });
  await Conversation.touch(conv.id, text);
  return { ok: true };
}
