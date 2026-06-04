import { callClaude, buildSystemPrompt } from './claude.service.js';
import { TOOLS } from '../tools/index.js';
import { HANDLERS } from '../tools/handlers.js';
import { zapi } from './zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';

const MAX_TOOL_ROUNDS = 6;

const ABERTURA = `Boa tarde,

Eu sou o Max, Host da Vila Mundaí, tudo bem?

Como posso ajudar?`;

function isMsgCurta(text) {
  return text.trim().split(/\s+/).length <= 6;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toClaudeMessages(rows) {
  const msgs = [];
  for (const r of rows) {
    if (r.raw) msgs.push(r.raw);
    else if (r.role === 'user' || r.role === 'assistant') msgs.push({ role: r.role, content: r.content });
  }
  return msgs;
}

export async function handleIncoming({ phone, text, pushName }) {
  let lead = await Lead.findByPhone(phone);
  if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });

  if (!lead.ai_enabled) {
    await persistInbound(lead, phone, text);
    return { skipped: true, reason: 'ia_pausada' };
  }

  let conv = await Conversation.findOpenByPhone(phone);
  const isFirstMessage = !conv;

  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  // Delay: 15s para mensagens curtas, 5s para mensagens longas
  if (isMsgCurta(text)) await delay(15000);
  else await delay(5000);

  // Primeira mensagem: envia abertura padrão
  if (isFirstMessage) {
    await zapi.sendText(phone, ABERTURA);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: ABERTURA, sender: 'ia' });
    await Conversation.touch(conv.id, ABERTURA);
    return { ok: true, reply: ABERTURA };
  }

  const history = await Message.listByConversation(conv.id);
  let messages = toClaudeMessages(history);

  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const system = buildSystemPrompt(lead);

    const resp = await callClaude({ system, messages, tools: TOOLS });

    const assistantMsg = { role: 'assistant', content: resp.content };
    messages.push(assistantMsg);
    await Message.create({
      conversation_id: conv.id,
      role: 'assistant',
      content: textOf(resp.content),
      raw: assistantMsg,
      sender: 'ia',
    });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try {
          result = handler ? await handler(block.input || {}, { lead, phone }) : { ok: false, erro: `ferramenta ${block.name} não implementada` };
        } catch (e) {
          result = { ok: false, erro: e.message };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      const toolMsg = { role: 'user', content: toolResults };
      messages.push(toolMsg);
      await Message.create({ conversation_id: conv.id, role: 'user', content: '[resultado de ferramentas]', raw: toolMsg, sender: 'ia' });
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

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function persistInbound(lead, phone, text) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });
  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);
}
