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

const MAX_TOOL_ROUNDS = 6;

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

function isMsgCurta(text) {
  return text.trim().split(/\s+/).length <= 6;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

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

export async function handleIncoming({ phone, text, pushName }) {
  const robotOn = await Setting.get('robot_enabled', true);
  if (robotOn === false) {
    return { skipped: true, reason: 'robot_desligado_geral' };
  }
  const cliente = await Cliente.findByPhone(phone);
  if (cliente) {
    return handleClienteMessage({ cliente, phone, text });
  }

  let lead = await Lead.findByPhone(phone);
  if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });

  if (!lead.ai_enabled) {
    await persistInbound(lead.id, phone, text);
    return { skipped: true, reason: 'ia_pausada' };
  }

  let conv = await Conversation.findOpenByPhone(phone);
  const isFirstMessage = !conv;
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  if (isFirstMessage) await delay(40000);
  else if (isMsgCurta(text)) await delay(15000);
  else await delay(5000);

  const history = await Message.listRecent(conv.id, 20);
  let messages = toClaudeMessages(history);
  console.log(`[agente] lead ${phone} historico=${history.length}msgs janela=${messages.length}msgs primeira_role=${messages[0]?.role || '-'} ultima_role=${messages[messages.length-1]?.role || '-'}`);

  // Texto que o Claude emite ao longo das rodadas. O modelo costuma mandar texto
  // JUNTO com um tool_use (stop_reason=tool_use); esse texto precisa ser enviado
  // ao lead, senão a fala se perde e na rodada seguinte o modelo não repete (retorna ~vazio).
  const partes = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const effectiveStage = await resolveEffectiveStage(lead);
    let [system, model] = await Promise.all([
      buildSystemPrompt({ ...lead, stage: effectiveStage }),
      getStageModel(effectiveStage),
    ]);
    if (isFirstMessage) {
      system += primeiraMensagemContexto();
      console.log(`[agente] lead ${phone} primeira mensagem da conversa — contexto de abertura injetado no system prompt`);
    }
    if (!system || !system.trim()) {
      console.error(`[agente] ALERTA prompt VAZIO para stage=${effectiveStage} (cache/banco?). lead ${phone}`);
    }
    console.log(`[agente] lead ${phone} round=${round} stage=${lead.stage} prompt=${effectiveStage} model=${model} system_len=${system?.length || 0} msgs=${messages.length}`);
    const resp = await callClaude({ system, messages, tools: TOOLS, model, lead_id: lead.id });

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
