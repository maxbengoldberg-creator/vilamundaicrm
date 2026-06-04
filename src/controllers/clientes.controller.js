import * as Cliente from '../models/cliente.model.js';
import { hospedin } from '../services/hospedin.service.js';
import { zapi } from '../services/zapi.service.js';
import * as Setting from '../models/setting.model.js';

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
    await Cliente.update(cliente.id, { boas_vindas_enviada: true });
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
