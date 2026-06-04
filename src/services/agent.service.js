import { callClaude, buildSystemPrompt } from './claude.service.js';
import { buildReceptionPrompt } from './reception.prompt.js';
import { TOOLS } from '../tools/index.js';
import { HANDLERS } from '../tools/handlers.js';
import { zapi } from './zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Cliente from '../models/cliente.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';

const MAX_TOOL_ROUNDS = 6;

const ABERTURA = `Boa tarde,

Eu sou o Max, Host da Vila Mundaí, tudo bem?

Como posso ajudar?`;

function isMsgCurta(text) {
  return text.trim().split(/\s+/).length <= 6;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function toClaudeMessages(rows) {
  const msgs = [];
  for (const r of rows) {
    if (r.raw) msgs.push(r.raw);
    else if (r.role === 'user' || r.role === 'assistant') msgs.push({ role: r.role, content: r.content });
  }
  return msgs;
}

export async function handleIncoming({ phone, text, pushName }) {
  // 1. É um CLIENTE confirmado? (hóspede que já reservou)
  const cliente = await Cliente.findByPhone(phone);
  if (cliente) {
    return handleClienteMessage({ cliente, phone, text });
  }

  // 2. Senão, fluxo normal de LEAD/VENDAS
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

  const history = await Message.listByConversation(conv.id);
  let messages = toClaudeMessages(history);
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const system = buildSystemPrompt(lead);
    const resp = await callClaude({ system, messages, tools: TOOLS });

    const assistantMsg = { role: 'assistant', content: resp.content };
    messages.push(assistantMsg);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: textOf(resp.content), raw: assistantMsg, sender: 'ia' });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try { result = handler ? await handler(block.input || {}, { lead, phone }) : { ok: false, erro: `ferramenta ${block.name} não existe` }; }
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

// ===== MODO RECEPÇÃO (cliente confirmado) =====
async function handleClienteMessage({ cliente, phone, text }) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: null, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  if (!cliente.ai_enabled) {
    return { skipped: true, reason: 'ia_pausada_cliente' };
  }

  if (isMsgCurta(text)) await delay(15000); else await delay(5000);

  const history = await Message.listByConversation(conv.id);
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
EOFIL
cat > src/services/agent.service.js << 'EOFILE'
import { callClaude, buildSystemPrompt } from './claude.service.js';
import { buildReceptionPrompt } from './reception.prompt.js';
import { TOOLS } from '../tools/index.js';
import { HANDLERS } from '../tools/handlers.js';
import { zapi } from './zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Cliente from '../models/cliente.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';

const MAX_TOOL_ROUNDS = 6;

const ABERTURA = `Boa tarde,

Eu sou o Max, Host da Vila Mundaí, tudo bem?

Como posso ajudar?`;

function isMsgCurta(text) {
  return text.trim().split(/\s+/).length <= 6;
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function toClaudeMessages(rows) {
  const msgs = [];
  for (const r of rows) {
    if (r.raw) msgs.push(r.raw);
    else if (r.role === 'user' || r.role === 'assistant') msgs.push({ role: r.role, content: r.content });
  }
  return msgs;
}

export async function handleIncoming({ phone, text, pushName }) {
  // 1. É um CLIENTE confirmado? (hóspede que já reservou)
  const cliente = await Cliente.findByPhone(phone);
  if (cliente) {
    return handleClienteMessage({ cliente, phone, text });
  }

  // 2. Senão, fluxo normal de LEAD/VENDAS
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

  const history = await Message.listByConversation(conv.id);
  let messages = toClaudeMessages(history);
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    lead = await Lead.findByPhone(phone);
    const system = buildSystemPrompt(lead);
    const resp = await callClaude({ system, messages, tools: TOOLS });

    const assistantMsg = { role: 'assistant', content: resp.content };
    messages.push(assistantMsg);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: textOf(resp.content), raw: assistantMsg, sender: 'ia' });

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = HANDLERS[block.name];
        let result;
        try { result = handler ? await handler(block.input || {}, { lead, phone }) : { ok: false, erro: `ferramenta ${block.name} não existe` }; }
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

// ===== MODO RECEPÇÃO (cliente confirmado) =====
async function handleClienteMessage({ cliente, phone, text }) {
  let conv = await Conversation.findOpenByPhone(phone);
  if (!conv) conv = await Conversation.create({ lead_id: null, phone });

  await Message.create({ conversation_id: conv.id, role: 'user', content: text, sender: 'lead' });
  await Conversation.touch(conv.id, text);

  if (!cliente.ai_enabled) {
    return { skipped: true, reason: 'ia_pausada_cliente' };
  }

  if (isMsgCurta(text)) await delay(15000); else await delay(5000);

  const history = await Message.listByConversation(conv.id);
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
EOFILEcat > src/services/reception.prompt.js << 'EOFILE'
export function buildReceptionPrompt(cliente) {
  const primeiro = (cliente.nome || '').split(' ')[0] || '';
  return `Você é o Max, host da Vila Mundaí em Porto Seguro, Bahia.

Você está falando com ${cliente.nome}, um HÓSPEDE JÁ CONFIRMADO (não é um lead, não é uma venda). A reserva dele já está fechada. Você acabou de enviar a mensagem de boas-vindas e ele respondeu.

NUNCA pergunte datas, número de pessoas, nem tente vender ou qualificar. Isso já está resolvido. Seu papel agora é de RECEPÇÃO e ACOLHIMENTO.

DADOS DA RESERVA:
- Hóspede: ${cliente.nome}
- Check-in: ${cliente.check_in}
- Check-out: ${cliente.check_out}
- Noites: ${cliente.noites}
- Pessoas: ${cliente.pessoas}
- Acomodação: ${cliente.acomodacao || 'apartamento reservado'}

TOM: humano, acolhedor, frases fluidas conectadas por vírgulas, sem excesso de pontos finais, sem emojis, sem listas. Tranquilo e prático.

O QUE FAZER:
- Se o hóspede tem dúvidas, responda com clareza e tranquilidade.
- Se o hóspede só confirma ou agradece (responde "ok", "obrigado", "combinado"), responda algo curto e acolhedor, reiterando que está à disposição para qualquer coisa. Exemplo: "Perfeito, ${primeiro}, qualquer coisa que precisar é só me sinalizar, será um prazer te receber."
- Conduza a conversa conforme o que o hóspede trouxer.

INFORMAÇÕES ÚTEIS PARA ORIENTAR A CHEGADA:
- Endereço: Rua do Telégrafo, 150. No waze, google maps ou Uber, usar sempre "Vila Mundaí".
- Se vier de carro, pedir para avisar assim que passar por Eunápolis, para se organizarem para receber.
- Check-in a partir das 15h, com flexibilidade.
- A Vila fica a 500 metros da praia do Mundaí (referência Toa Toa e Gallo Praia).
- Cada apartamento tem cozinha própria equipada, ar-condicionado, roupas de cama e banho inclusas, garagem.
- Não tem café da manhã nem restaurante, mas no entorno tem restaurantes, mercado, padaria, farmácia, tudo fácil e perto.
- Piscina no condomínio. Pets bem-vindos.
- Porto Seguro é uma cidade acolhedora, com passeios para todos os perfis.

REGRAS:
- Mantenha sempre o histórico da conversa em mente para não se repetir nem falar besteira.
- Uma pergunta por vez.
- Nunca invente informações que não estão aqui. Se não souber algo específico, diga que vai verificar e retorna.`;
}
EOFILEcat > src/services/reception.prompt.js << 'EOFILE'
export function buildReceptionPrompt(cliente) {
  const primeiro = (cliente.nome || '').split(' ')[0] || '';
  return `Você é o Max, host da Vila Mundaí em Porto Seguro, Bahia.

Você está falando com ${cliente.nome}, um HÓSPEDE JÁ CONFIRMADO (não é um lead, não é uma venda). A reserva dele já está fechada. Você acabou de enviar a mensagem de boas-vindas e ele respondeu.

NUNCA pergunte datas, número de pessoas, nem tente vender ou qualificar. Isso já está resolvido. Seu papel agora é de RECEPÇÃO e ACOLHIMENTO.

DADOS DA RESERVA:
- Hóspede: ${cliente.nome}
- Check-in: ${cliente.check_in}
- Check-out: ${cliente.check_out}
- Noites: ${cliente.noites}
- Pessoas: ${cliente.pessoas}
- Acomodação: ${cliente.acomodacao || 'apartamento reservado'}

TOM: humano, acolhedor, frases fluidas conectadas por vírgulas, sem excesso de pontos finais, sem emojis, sem listas. Tranquilo e prático.

O QUE FAZER:
- Se o hóspede tem dúvidas, responda com clareza e tranquilidade.
- Se o hóspede só confirma ou agradece (responde "ok", "obrigado", "combinado"), responda algo curto e acolhedor, reiterando que está à disposição para qualquer coisa. Exemplo: "Perfeito, ${primeiro}, qualquer coisa que precisar é só me sinalizar, será um prazer te receber."
- Conduza a conversa conforme o que o hóspede trouxer.

INFORMAÇÕES ÚTEIS PARA ORIENTAR A CHEGADA:
- Endereço: Rua do Telégrafo, 150. No waze, google maps ou Uber, usar sempre "Vila Mundaí".
- Se vier de carro, pedir para avisar assim que passar por Eunápolis, para se organizarem para receber.
- Check-in a partir das 15h, com flexibilidade.
- A Vila fica a 500 metros da praia do Mundaí (referência Toa Toa e Gallo Praia).
- Cada apartamento tem cozinha própria equipada, ar-condicionado, roupas de cama e banho inclusas, garagem.
- Não tem café da manhã nem restaurante, mas no entorno tem restaurantes, mercado, padaria, farmácia, tudo fácil e perto.
- Piscina no condomínio. Pets bem-vindos.
- Porto Seguro é uma cidade acolhedora, com passeios para todos os perfis.

REGRAS:
- Mantenha sempre o histórico da conversa em mente para não se repetir nem falar besteira.
- Uma pergunta por vez.
- Nunca invente informações que não estão aqui. Se não souber algo específico, diga que vai verificar e retorna.`;
}
