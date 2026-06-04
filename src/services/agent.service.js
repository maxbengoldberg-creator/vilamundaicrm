import { callClaude, buildSystemPrompt } from './claude.service.js';
import { TOOLS } from '../tools/index.js';
import { HANDLERS } from '../tools/handlers.js';
import { zapi } from './zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';

const MAX_TOOL_ROUNDS = 6; // trava de segurança contra loops infinitos

// Reconstrói o histórico no formato esperado pela API da Claude.
// Mensagens "tool" guardam o bloco bruto (tool_use / tool_result) em `raw`.
function toClaudeMessages(rows) {
  const msgs = [];
  for (const r of rows) {
    if (r.raw) {
      // bloco já no formato Anthropic (assistant com tool_use, ou user com tool_result)
      msgs.push(r.raw);
    } else if (r.role === 'user' || r.role === 'assistant') {
      msgs.push({ role: r.role, content: r.content });
    }
  }
  return msgs;
}

// Processa uma mensagem recebida do lead e gera a resposta do agente.
export async function handleIncoming({ phone, text, pushName }) {
  // 1. Localiza/cria lead e conversa
  let lead = await Lead.findByPhone(phone);
  if (!lead) lead = await Lead.create({ phone, nome: pushName || null, origem: 'whatsapp' });

  // Se um humano assumiu, a IA não responde.
  if (!lead.ai_enabled) {
    await persistInbound(lead, phone, text);
    return { skipped: true, reason: 'ia_pausada' };
  }

  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });

  // 2. Salva a mensagem do lead
  await Message.create({
    conversation_id: conv.id,
    role: 'user',
    content: text,
    sender: 'lead',
  });
  await Conversation.touch(conv.id, text);

  // 3. Carrega o histórico salvo (continuidade da conversa)
  const history = await Message.listByConversation(conv.id);
  let messages = toClaudeMessages(history);

  // 4. Loop de tool use
  let finalText = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone); // recarrega contexto atualizado
    const system = buildSystemPrompt(lead);

    const resp = await callClaude({ system, messages, tools: TOOLS });

    // Persiste o turno do assistant (incluindo eventuais tool_use)
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
      // Executa todas as ferramentas pedidas neste turno
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try {
          result = handler
            ? await handler(block.input || {}, { lead, phone })
            : { ok: false, erro: `ferramenta ${block.name} não implementada` };
        } catch (e) {
          result = { ok: false, erro: e.message };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      const toolMsg = { role: 'user', content: toolResults };
      messages.push(toolMsg);
      await Message.create({
        conversation_id: conv.id,
        role: 'user',
        content: '[resultado de ferramentas]',
        raw: toolMsg,
        sender: 'ia',
      });
      continue; // volta ao topo para a Claude reagir aos resultados
    }

    // Sem mais ferramentas: temos a resposta final em texto
    finalText = textOf(resp.content);
    break;
  }

  // 5. Envia a resposta ao lead pelo WhatsApp
  if (finalText && finalText.trim()) {
    await zapi.sendText(phone, finalText);
    await Conversation.touch(conv.id, finalText);
  }

  return { ok: true, reply: finalText };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Quando a IA está pausada, ainda guardamos a mensagem do lead.
async function persistInbound(lead, phone, text) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone });
  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);
}
