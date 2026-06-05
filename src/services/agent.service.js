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

const ABERTURA = `Boa tarde,

Eu sou o Max, Host da Vila Mundaí, tudo bem?

Como posso ajudar?`;

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
  // Remove tool_results orfaos no inicio da janela (evita erro 400 da API)
  while (msgs.length) {
    const m = msgs[0];
    const hasToolResult = Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result');
    if (m.role === 'user' && hasToolResult) msgs.shift();
    else break;
  }
  // A janela deve comecar por mensagem do usuario
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
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

  if (isMsgCurta(text)) await delay(15000); else await delay(5000);

  if (isFirstMessage) {
    await zapi.sendText(phone, ABERTURA);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: ABERTURA, sender: 'ia' });
    await Conversation.touch(conv.id, ABERTURA);
    return { ok: true, reply: ABERTURA };
  }

  const history = await Message.listRecent(conv.id, 20);
  let messages = toClaudeMessages(history);
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const effectiveStage = await resolveEffectiveStage(lead);
    const [system, model] = await Promise.all([
      buildSystemPrompt({ ...lead, stage: effectiveStage }),
      getStageModel(effectiveStage),
    ]);
    console.log(`[agente] lead ${phone} stage=${lead.stage} prompt=${effectiveStage} model=${model}`);
    const resp = await callClaude({ system, messages, tools: TOOLS, model, lead_id: lead.id });

    const assistantMsg = { role: 'assistant', content: resp.content };
    messages.push(assistantMsg);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: textOf(resp.content), raw: assistantMsg, sender: 'ia' });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try { result = handler ? await handler(block.input || {}, { lead, phone }) : { ok: false, erro: `ferramenta ${block.name} nao existe` }; }
        catch (e) { result = { ok: false, erro: e.message }; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      const toolMsg = { role: 'user', content: toolResults };
      messages.push(toolMsg);
      await Message.create({ conversation_id: conv.id, role: 'user', content: '[ferramentas]', raw: toolMsg, sender: 'ia' });
      continue;
    }
    finalText = textOf(resp.content);
    break;
  }

  if (finalText && finalText.trim()) {
    await zapi.sendText(phone, finalText);
    await Conversation.touch(conv.id, finalText);
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

  await Message.create({ conversation_id: conv.id, role: 'assistant', content: finalText, sender: 'ia' });
  if (finalText && finalText.trim()) {
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
