import * as Lead from '../models/lead.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';
import * as Automation from '../models/automation.model.js';

/* ---- LEADS ---- */
export async function listLeads(req, res, next) {
  try { res.json(await Lead.list({ stage: req.query.stage })); } catch (e) { next(e); }
}
export async function createLead(req, res, next) {
  try {
    const { phone, nome, origem } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    res.status(201).json(await Lead.create({ phone, nome, origem }));
  } catch (e) { next(e); }
}
export async function updateLead(req, res, next) {
  try { res.json(await Lead.update(req.params.id, req.body)); } catch (e) { next(e); }
}
export async function getLead(req, res, next) {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
    res.json(lead);
  } catch (e) { next(e); }
}

/* ---- CONVERSAS ---- */
export async function listConversations(req, res, next) {
  try { res.json(await Conversation.list()); } catch (e) { next(e); }
}
export async function getConversationMessages(req, res, next) {
  try { res.json(await Message.listByConversation(req.params.id)); } catch (e) { next(e); }
}
export async function finishConversation(req, res, next) {
  try { await Conversation.finish(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
}
// Pausar/retomar a IA num lead (toggle manual da régua/atendimento humano).
export async function toggleAI(req, res, next) {
  try {
    const lead = await Lead.update(req.params.id, { ai_enabled: req.body.ai_enabled });
    res.json(lead);
  } catch (e) { next(e); }
}

/* ---- AUTOMAÇÕES ---- */
export async function listAutomations(req, res, next) {
  try { res.json(await Automation.list()); } catch (e) { next(e); }
}
export async function updateAutomation(req, res, next) {
  try { res.json(await Automation.update(req.params.id, req.body)); } catch (e) { next(e); }
}
