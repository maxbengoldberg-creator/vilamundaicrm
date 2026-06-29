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
import { query } from '../config/db.js';

// O fechamento da venda encadeia até 6 ferramentas numa única resposta do lead
// (extrair dados, salvar condições, 2x mover funil, criar reserva, escalar).
const MAX_TOOL_ROUNDS = 10;

// Resolve qual stage de prompt realmente usar, aplicando condicionais por tag.
// Item 1: tag "ganho" auto-corrige o stage no banco se necessário.
// Item 3: blocked_tags da etapa atual desviam para "ganho".
async function resolveEffectiveStage(lead) {
  const tags = Array.isArray(lead.tags) ? lead.tags : [];

  if (tags.includes('ganho') && lead.stage !== 'ganho') {
    // GANHO = atendimento humano: corrige o stage e desliga a IA junto.
    await Lead.update(lead.id, { stage: 'ganho', ai_enabled: false });
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
// Personalizada com o primeiro nome quando o formulário trouxe.
function aberturaAnuncio(nome) {
  let primeiro = (nome || '').trim().split(/\s+/)[0] || '';
  // Capitaliza por garantia (formulários às vezes vêm em minúsculas).
  if (primeiro) primeiro = primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
  return `${saudacao()}${primeiro ? ' ' + primeiro : ''}, eu sou o Max, host da Vila Mundaí, tudo bem? Me conta, já tem datas pra viagem?`;
}

// Extrai nome, e-mail e telefone do texto do formulário de anúncio.
// Formatos vistos: "Full name: X / Email: Y / Phone number: +55..." e
// "nome_completo: ... email: ... telefone: ...".
function parseFormAnuncio(text) {
  const t = String(text || '');
  const nome = t.match(/(?:full[\s_]?name|nome(?:_completo)?)\s*:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const email = t.match(/e-?mail\s*:\s*([^\s\n]+@[^\s\n]+)/i)?.[1]?.trim() || null;
  const phoneRaw = t.match(/(?:phone[\s_]?number|telefone|whatsapp)\s*:\s*([+\d\s().-]+)/i)?.[1] || null;
  let phone = phoneRaw ? phoneRaw.replace(/\D/g, '') : null;
  if (phone && !phone.startsWith('55')) phone = '55' + phone;
  if (phone && phone.length < 12) phone = null;
  return { nome, email, phone };
}

// Funde lead/conversas provisórios criados sob "@lid" no lead REAL, assim que
// o vínculo lid->telefone é descoberto. Move as mensagens para a conversa real
// (painel unificado) e apaga o provisório.
// Escolhe o melhor nome entre o atual e um novo (pushName): prefere o mais
// completo (mais palavras), nunca troca um nome completo por um parcial.
export function melhorNome(atual, novo) {
  const a = (atual || '').trim(), n = (novo || '').trim();
  if (!n) return a; if (!a) return n; if (a === n) return a;
  const wc = s => s.split(/\s+/).filter(Boolean).length;
  return wc(n) > wc(a) ? n : a;
}

// Funde um lead duplicado no lead canônico: move conversas/mensagens, leva o
// melhor nome e o lid, e apaga o duplicado.
async function mergeLeadInto(dup, canonical) {
  let conv = await Conversation.findOpenByLead(canonical.id)
    || await Conversation.findOpenByPhone(canonical.phone)
    || await Conversation.create({ lead_id: canonical.id, phone: canonical.phone });
  const { rows: dupConvs } = await query('SELECT id FROM conversations WHERE lead_id = $1', [dup.id]);
  let movidas = 0;
  for (const dc of dupConvs) {
    if (String(dc.id) === String(conv.id)) continue;
    const r = await query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2', [conv.id, dc.id]);
    movidas += r.rowCount || 0;
    await query('DELETE FROM conversations WHERE id = $1', [dc.id]);
  }
  const nome = melhorNome(canonical.nome, dup.nome);
  if (nome && nome !== canonical.nome) { await Lead.update(canonical.id, { nome }); canonical.nome = nome; }
  // Preserva dados do duplicado que o canônico não tem (lid, datas, email, etc.).
  const fill = {};
  for (const k of ['lid', 'email', 'checkin', 'checkout', 'guests', 'acomodacao', 'cpf', 'data_nascimento']) {
    if (!canonical[k] && dup[k]) fill[k] = dup[k];
  }
  if (dup.origem && dup.origem !== 'whatsapp' && (!canonical.origem || canonical.origem === 'whatsapp')) fill.origem = dup.origem;
  if (Object.keys(fill).length) { await Lead.update(canonical.id, fill).catch(() => {}); Object.assign(canonical, fill); }
  await query('DELETE FROM leads WHERE id = $1', [dup.id]);
  return movidas;
}

// Funde duplicados do mesmo número que diferem só pelo 9º dígito (12 vs 13).
export async function mergePhoneDuplicates(lead) {
  if (!lead || String(lead.phone).includes('@')) return { merged: false };
  const formas = Lead.formasPhoneBR(lead.phone);
  if (formas.length < 2) return { merged: false };
  const { rows: dups } = await query(
    'SELECT * FROM leads WHERE phone = ANY($1::text[]) AND id <> $2 ORDER BY id ASC', [formas, lead.id]
  );
  let total = 0;
  for (const dup of dups) total += await mergeLeadInto(dup, lead);
  if (dups.length) console.log(`[merge-9dig] lead ${lead.id} (${lead.phone}) absorveu ${dups.length} duplicado(s), ${total} msgs`);
  return { merged: dups.length > 0, dups: dups.length, mensagens: total };
}

// Telefone BR válido: 55 + DDD (11-99) + 8/9 dígitos (12 ou 13 no total).
// Usado para não confiar em número de formulário inválido como identidade.
export function phoneValidoBR(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length !== 12 && d.length !== 13) return false;
  if (!d.startsWith('55')) return false;
  return /^[1-9][1-9]$/.test(d.slice(2, 4)); // DDD sem zero
}

// Funde no lead atual qualquer OUTRO lead com o mesmo lid (mesma pessoa que
// virou 2 contatos, ex.: número de formulário inválido + número real).
export async function mergeLidDuplicates(lead) {
  if (!lead || !lead.lid) return { merged: false };
  const { rows: dups } = await query(
    'SELECT * FROM leads WHERE lid = $1 AND id <> $2 ORDER BY id ASC', [lead.lid, lead.id]
  );
  let total = 0;
  for (const dup of dups) total += await mergeLeadInto(dup, lead);
  if (dups.length) console.log(`[merge-lid] lead ${lead.id} (${lead.phone}) absorveu ${dups.length} lead(s) com mesmo lid`);
  return { merged: dups.length > 0, dups: dups.length, mensagens: total };
}

// Funde TODOS os leads de um lid num único canônico — o que tem telefone BR
// válido (senão o mais antigo). Usado no backfill dos duplicados já existentes.
export async function mergeLidGroup(lid) {
  if (!lid) return { merged: false };
  const { rows } = await query('SELECT * FROM leads WHERE lid = $1 ORDER BY id ASC', [lid]);
  if (rows.length < 2) return { merged: false };
  const canonical = rows.find(l => phoneValidoBR(l.phone)) || rows[0];
  let total = 0, n = 0;
  for (const dup of rows) {
    if (String(dup.id) === String(canonical.id)) continue;
    total += await mergeLeadInto(dup, canonical); n++;
  }
  if (n) console.log(`[merge-lid] grupo lid ${lid}: canônico ${canonical.id} (${canonical.phone}) absorveu ${n} lead(s)`);
  return { merged: n > 0, canonical: canonical.id, dups: n, mensagens: total };
}

// Avisa o dono no WhatsApp pessoal quando um lead NOVO aparece. Configurável
// na aba Agente (settings notify_lead_enabled / notify_lead_phone). Fire-and-forget.
async function notificarNovoLead(lead, primeiraMsg) {
  try {
    const enabled = await Setting.get('notify_lead_enabled', false);
    const dest = String((await Setting.get('notify_lead_phone', '')) || '').replace(/\D/g, '');
    if (enabled !== true || !dest) return;
    // Não avisa se o "lead novo" é o próprio número de aviso (teste do dono).
    if (Lead.formasPhoneBR(lead.phone).includes(dest)) return;
    await zapi.sendText(dest, 'Novo Lead');
    console.log(`[notify] dono avisado de novo lead ${lead.id} (${lead.phone})`);
  } catch (e) {
    console.error('[notify] aviso de novo lead falhou:', e.message);
  }
}

export async function mergeLidOrphans(leadReal, lid) {
  try {
    const orphanPhone = `${lid}@lid`;
    const orphan = await Lead.findByPhone(orphanPhone);
    const { rows: orphanConvs } = await query(
      `SELECT id FROM conversations WHERE phone = $1 OR ($2::bigint IS NOT NULL AND lead_id = $2)`,
      [orphanPhone, orphan ? orphan.id : null]
    );
    if (!orphanConvs.length && !orphan) return { merged: false };

    let conv = await Conversation.findOpenByPhone(leadReal.phone);
    if (!conv) conv = await Conversation.create({ lead_id: leadReal.id, phone: leadReal.phone });

    let movidas = 0;
    for (const oc of orphanConvs) {
      if (String(oc.id) === String(conv.id)) continue;
      const r = await query(`UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2`, [conv.id, oc.id]);
      movidas += r.rowCount || 0;
      await query(`DELETE FROM conversations WHERE id = $1`, [oc.id]);
    }
    if (orphan && String(orphan.id) !== String(leadReal.id)) {
      if (!leadReal.nome && orphan.nome) await Lead.update(leadReal.id, { nome: orphan.nome });
      await query(`DELETE FROM leads WHERE id = $1`, [orphan.id]);
    }
    console.log(`[merge] @lid ${lid} fundido no lead ${leadReal.id} (${leadReal.phone}) — ${movidas} mensagens movidas`);
    return { merged: true, mensagens_movidas: movidas, conversa: conv.id };
  } catch (e) {
    console.error('[merge] falhou:', e.message);
    return { merged: false, erro: e.message };
  }
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

// Detecta o formulário de reserva preenchido NO SITE (texto estruturado que o
// site manda pelo WhatsApp). Diferente do anúncio do Meta.
function pareceSite(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  if (/gostaria de fazer uma reserva no vila mund/.test(t)) return true;
  if (/detalhes da reserva/.test(t) && /check-?in:/.test(t) && /h[oó]spedes?:/.test(t)) return true;
  return false;
}

// Detecta hóspede que JÁ TEM reserva por uma OTA (Airbnb/Booking) e está só
// falando com o CRM. Vai para o funil "reserva_ota" com a IA DESLIGADA —
// atendimento humano, fora do fluxo de vendas. Detecção por texto: exige
// mencionar a OTA E a palavra "reserva" (ou similar), pra evitar falso-positivo
// de quem só está perguntando se pode reservar pelo Airbnb.
function pareceOTA(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const temOTA = /\b(airbnb|air bnb|booking(\.com)?)\b/.test(t);
  if (!temOTA) return false;
  const temReserva = /reserv(a|ei|ado|amos)|hosped(agem|ei|ado)|minha estad|fiz pelo|fiz no|comprei pelo/.test(t);
  return temReserva;
}

function parseDataBR(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Extrai nome, datas e nº de hóspedes do formulário do site (para a ficha).
function parseFormSite(text) {
  const t = String(text || '');
  return {
    nome:     t.match(/Nome:\s*([^\n]+)/i)?.[1]?.trim() || null,
    checkin:  parseDataBR(t.match(/Check-?in:\s*([0-9/]+)/i)?.[1]),
    checkout: parseDataBR(t.match(/Check-?out:\s*([0-9/]+)/i)?.[1]),
    guests:   parseInt(t.match(/H[oó]spedes?:\s*(\d+)/i)?.[1] || '', 10) || null,
  };
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

    // 4. assistant com tool_use SEM tool_result na próxima mensagem (par quebrado
    // ou tool_use solto no fim da janela). A API exige tool_result logo depois;
    // sem ele, remove o assistant. Cobre o caso da instrução do operador colada
    // após um tool_use pendente.
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const toolUses = msg.content.filter(b => b?.type === 'tool_use');
      if (toolUses.length === 0) continue;

      const next = msgs[i + 1];
      const nextResultIds = new Set(
        (next?.role === 'user' && Array.isArray(next.content) ? next.content : [])
          .filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
      );
      const semResultado = toolUses.some(tu => !nextResultIds.has(tu.id));
      if (semResultado) {
        const ids = toolUses.map(tu => tu.id).join(', ');
        console.log(`[toClaudeMessages] tool_use sem tool_result ids=[${ids}] na posicao ${i}, removendo o assistant`);
        msgs.splice(i, 1);
        stable = false;
        break; // reinicia a varredura
      }
    }
  }

  return msgs;
}

export async function handleIncoming({ phone, text, pushName, lid = null, operador = false }) {
  const robotOn = await Setting.get('robot_enabled', true);

  // ANÚNCIO: o formulário traz nome/email/telefone no próprio texto. Usa o
  // telefone do form como identidade REAL — mesmo quando a mensagem chega
  // via "@lid" — e aproveita os dados para a ficha e a abertura com nome.
  let formAds = null;
  if (!operador && pareceAnuncio(text)) {
    formAds = parseFormAnuncio(text);
    if (String(phone).includes('@')) {
      if (!lid) lid = String(phone).replace(/\D/g, '') || null;
      // Só troca o @lid pelo número do formulário se ele for um telefone BR
      // VÁLIDO. Formulário às vezes traz número inválido (vira lead fragmentado);
      // nesse caso mantém o @lid e o merge por lid junta com o número real depois.
      if (formAds.phone && phoneValidoBR(formAds.phone)) {
        console.log(`[agente] anúncio via @lid: identidade resolvida pelo formulário ${phone} -> ${formAds.phone}`);
        phone = formAds.phone;
      } else if (formAds.phone) {
        console.warn(`[agente] anúncio: número do formulário inválido (${formAds.phone}), mantendo @lid ${phone}`);
      }
    }
  }

  // CLIENTE (hóspede confirmado): o handler persiste primeiro e decide depois.
  const cliente = await Cliente.findByPhone(phone);
  if (cliente) {
    return handleClienteMessage({ cliente, phone, text, robotOn });
  }

  // ===== INVARIANTE: registrar SEMPRE, antes de qualquer decisão. =====
  // Receber e registrar o lead é obrigação do CRM; responder é decisão da IA.
  // Nenhum estado (robô geral, IA do lead) pode impedir o lead de aparecer
  // no funil (qualificação) e em Atendimentos.
  // Identidade tolerante ao 9º dígito (12 vs 13): a mesma pessoa não vira 2 leads.
  let lead = await Lead.findByPhoneFlex(phone);
  const isNovoLead = !lead;
  if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });
  // Grava/atualiza o nome quando o pushName chega (ou é mais completo).
  if (pushName) {
    const novoNome = melhorNome(lead.nome, pushName);
    if (novoNome && novoNome !== lead.nome) { await Lead.update(lead.id, { nome: novoNome }).catch(() => {}); lead.nome = novoNome; }
  }
  // Funde qualquer duplicado do mesmo número que difere só pelo 9º dígito.
  await mergePhoneDuplicates(lead);
  // Funde qualquer outro lead com o MESMO lid (ex.: nº de formulário inválido +
  // nº real viraram 2 contatos). Consolida a conversa para a IA ler tudo.
  await mergeLidDuplicates(lead);
  // Lead novo (primeira mensagem): avisa o dono no WhatsApp pessoal.
  if (isNovoLead && !operador) notificarNovoLead(lead, text);

  // Guarda o LID no lead de telefone REAL e FUNDE qualquer contato provisório
  // "@lid" desta mesma pessoa (mensagens passam para a conversa real).
  if (lid && !String(phone).includes('@') && lead.lid !== lid) {
    await Lead.update(lead.id, { lid }).catch(() => {});
    lead.lid = lid;
    await mergeLidOrphans(lead, lid);
  } else if (!lead.lid && !String(phone).includes('@')) {
    // O webhook não trouxe o LID: busca proativa na Z-API (telefone -> LID),
    // 1x por lead, em segundo plano. Garante o mapa ANTES de o WhatsApp
    // resolver entregar alguma mensagem desta pessoa como "@lid".
    zapi.phoneExists(phone).then(async (r) => {
      const l = String(r?.lid || '').replace(/\D/g, '');
      if (!l) return;
      await Lead.update(lead.id, { lid: l }).catch(() => {});
      const m = await mergeLidOrphans({ ...lead, lid: l }, l);
      console.log(`[lid] lead ${lead.id} mapeado proativamente: ${phone} -> ${l}${m.merged ? ' (órfãos fundidos)' : ''}`);
    }).catch(() => {});
  }

  // Conversa do LEAD (consolidada): acha pela conversa do lead, depois pelo
  // telefone exato — assim o 9º dígito não cria uma segunda conversa.
  let conv = await Conversation.findOpenByLead(lead.id) || await Conversation.findOpenByPhone(phone);
  const isFirstMessage = !conv;
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone: lead.phone || phone });

  // Anúncio: marca origem e salva os dados do formulário na ficha.
  if (formAds) {
    const patch = {};
    if (lead.origem !== 'meta_ads') patch.origem = 'meta_ads';
    // O nome digitado no formulário é mais confiável que o apelido do perfil
    // do WhatsApp (pushName, ex: "ruthembergdias") — sobrescreve quando o nome
    // atual está vazio ou veio do pushName.
    if (formAds.nome && (!lead.nome || lead.nome === pushName)) patch.nome = formAds.nome;
    if (formAds.email && !lead.email) patch.email = formAds.email;
    if (Object.keys(patch).length) {
      await Lead.update(lead.id, patch).catch(() => {});
      Object.assign(lead, patch);
    }
    console.log(`[agente] lead ${phone} anúncio — ficha: nome=${lead.nome || '-'} email=${lead.email || '-'}`);
  }

  // A ordem do operador NÃO é gravada como mensagem do lead (não polui o painel
  // nem o histórico). Só a resposta do agente será persistida.
  if (!operador) {
    await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
    await Conversation.touch(conv.id, text);
  }

  // LEAD DO SITE: o formulário do site é só dado, sem conversa/rapport. Vai para
  // o funil "lead_site" e a IA fica DESLIGADA — atendimento humano, com calma.
  // Salva os dados do formulário na ficha (datas/pessoas/nome) para o operador.
  if (!operador && pareceSite(text)) {
    const f = parseFormSite(text);
    const patch = { stage: 'lead_site', ai_enabled: false, origem: 'site' };
    if (f.nome && (!lead.nome || lead.nome === pushName)) patch.nome = f.nome;
    if (f.checkin) patch.checkin = f.checkin;
    if (f.checkout) patch.checkout = f.checkout;
    if (f.guests) patch.guests = f.guests;
    await Lead.update(lead.id, patch).catch(() => {});
    console.log(`[agente] lead ${phone} veio do SITE — funil lead_site, IA desligada`);
    return { skipped: true, reason: 'lead_site' };
  }

  // RESERVA OTA: hóspede que já reservou por Airbnb/Booking. Não é um lead de
  // venda — vai para o funil "reserva_ota" com a IA DESLIGADA (atendimento
  // humano). Mesmo padrão do lead_site. Não dispara para quem já está num
  // estágio de fechamento (não rebaixa quem já é cliente em negociação).
  if (!operador && pareceOTA(text) && !['ganho', 'pagamento', 'assinatura', 'contrato'].includes(lead.stage)) {
    await Lead.update(lead.id, { stage: 'reserva_ota', ai_enabled: false }).catch(() => {});
    console.log(`[agente] lead ${phone} é RESERVA OTA (Airbnb/Booking) — funil reserva_ota, IA desligada`);
    return { skipped: true, reason: 'reserva_ota' };
  }

  // ===== Só agora a IA decide se responde. =====
  // Ordem do operador roda mesmo com o robô desligado ou a IA pausada no lead.
  if (!operador && robotOn === false) {
    return { skipped: true, reason: 'robot_desligado_geral' };
  }
  if (!operador && !lead.ai_enabled) {
    return { skipped: true, reason: 'ia_pausada' };
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
    const abertura = aberturaAnuncio(lead.nome);
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

async function handleClienteMessage({ cliente, phone, text, robotOn = true }) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: null, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  if (robotOn === false) {
    return { skipped: true, reason: 'robot_desligado_geral' };
  }
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

// Grava no painel uma mensagem que NÓS enviamos (fromMe): pode ter vindo do app
// do celular, da IA ou do envio manual pelo CRM. Para o operador, tudo que sai
// do nosso número aparece como atendimento humano. Deduplica para não duplicar
// o que a IA (sender 'ia') ou o envio pelo CRM (sender 'humano') já gravaram.
export async function persistOutboundHuman({ phone, text }) {
  // Identidade consolidada (tolerante ao 9º dígito).
  const cli = await Cliente.findByPhone(phone);
  const lead = cli ? null : await Lead.findByPhoneFlex(phone);
  let conv = (lead && await Conversation.findOpenByLead(lead.id)) || await Conversation.findOpenByPhone(phone);
  if (!conv) {
    conv = await Conversation.create({ lead_id: lead ? lead.id : null, phone: (lead && lead.phone) || phone });
  }
  // Dedup: mesma mensagem já gravada nos últimos 120s (eco da IA ou do CRM).
  const jaExiste = await Message.existsRecentByContent(conv.id, text, 120);
  if (jaExiste) return { skipped: true, reason: 'duplicada' };
  await Message.create({ conversation_id: conv.id, role: 'assistant', content: text, sender: 'humano' });
  await Conversation.touch(conv.id, text);
  return { ok: true };
}
