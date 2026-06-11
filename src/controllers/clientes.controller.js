import * as Cliente from '../models/cliente.model.js';
import * as Lead from '../models/lead.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';
import { hospedin } from '../services/hospedin.service.js';
import { zapi } from '../services/zapi.service.js';
import * as Setting from '../models/setting.model.js';
import { query } from '../config/db.js';

export async function importarChegadas(req, res, next) {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ error: 'start_date e end_date obrigatórios' });
    const chegadas = await hospedin.chegadas({ start_date, end_date });
    const salvos = [];
    for (const c of chegadas) salvos.push(await Cliente.upsertFromReserva(c));
    res.json({ ok: true, total: salvos.length, clientes: salvos });
  } catch (e) { next(e); }
}

export async function listClientes(req, res, next) {
  try { res.json(await Cliente.list()); } catch (e) { next(e); }
}

export async function updateCliente(req, res, next) {
  try { res.json(await Cliente.update(req.params.id, req.body)); } catch (e) { next(e); }
}

export async function deleteCliente(req, res, next) {
  try { await Cliente.remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
}

function montarBoasVindas(nome) {
  const primeiro = (nome || '').split(' ')[0] || '';
  return `Boa tarde ${primeiro},

Eu sou o Max, Host da Vila Mundaí, tudo bem?

Passando para confirmar a sua reserva, e perguntar se você tem alguma dúvida ou necessidade neste momento.

Vou te passar as orientações para a sua chegada.

A Vila fica no endereço Rua do Telégrafo, 150.

Se for usar waze, google maps ou Uber, use sempre Vila Mundaí.

Se vier de carro, peço por gentileza que me informe assim que passar por Eunápolis, assim nos organizamos aqui para te receber.

Qualquer dúvida, fico à disposição.`;
}

export async function enviarBoasVindas(req, res, next) {
  try {
    const cliente = await Cliente.findById(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'cliente não encontrado' });
    if (!cliente.phone) return res.status(400).json({ error: 'cliente sem telefone' });
    const msg = montarBoasVindas(cliente.nome);
    await zapi.sendText(cliente.phone, msg);

    // Desliga a IA na tabela clientes ANTES de marcar boas_vindas_enviada,
    // para que o webhook da resposta do cliente já encontre ai_enabled=false.
    await Cliente.update(cliente.id, { boas_vindas_enviada: true, ai_enabled: false });

    // Garante lead no funil GANHO com IA desligada e com os dados da reserva
    // (origem, datas, valor) para aparecer corretamente no painel Atendimentos.
    let lead = await Lead.findByPhone(cliente.phone);
    if (!lead) lead = await Lead.create({ phone: cliente.phone, nome: cliente.nome, origem: 'reserva' });
    const origemLead = cliente.canal === 'Airbnb' ? 'airbnb'
                     : cliente.canal === 'Booking.com' ? 'booking'
                     : 'reserva';
    const valorCotado = cliente.receita_cents ? Math.round(cliente.receita_cents / 100) : null;
    await Lead.update(lead.id, {
      stage: 'ganho',
      ai_enabled: false,
      nome: lead.nome || cliente.nome,
      origem: origemLead,
      ...(cliente.check_in ? { checkin: String(cliente.check_in).slice(0, 10) } : {}),
      ...(cliente.check_out ? { checkout: String(cliente.check_out).slice(0, 10) } : {}),
      ...(cliente.pessoas ? { guests: cliente.pessoas } : {}),
      ...(valorCotado ? { valor_cotado: valorCotado } : {}),
    });
    // Garante uma conversa aberta e grava a boas-vindas no painel (como humano).
    let conv = await Conversation.findOpenByPhone(cliente.phone);
    if (!conv) conv = await Conversation.create({ lead_id: lead.id, phone: cliente.phone });
    await query(`UPDATE conversations SET lead_id = $1 WHERE phone = $2 AND lead_id IS NULL`, [lead.id, cliente.phone]);
    await Message.create({ conversation_id: conv.id, role: 'assistant', content: msg, sender: 'humano' });
    await Conversation.touch(conv.id, msg);

    res.json({ ok: true, mensagem: msg });
  } catch (e) { next(e); }
}

// ===== INTERRUPTOR GERAL DO ROBÔ =====

export async function getRobotStatus(req, res, next) {
  try {
    const on = await Setting.get('robot_enabled', true);
    res.json({ enabled: on !== false });
  } catch (e) { next(e); }
}

export async function setRobotStatus(req, res, next) {
  try {
    const enabled = req.body.enabled !== false;
    await Setting.set('robot_enabled', enabled);
    res.json({ ok: true, enabled });
  } catch (e) { next(e); }
}
