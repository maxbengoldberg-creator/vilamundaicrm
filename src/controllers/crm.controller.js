import * as Lead from '../models/lead.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as Message from '../models/message.model.js';
import * as Automation from '../models/automation.model.js';
import { zapi } from '../services/zapi.service.js';
import { hospedin } from '../services/hospedin.service.js';
import { anthropic } from '../services/claude.service.js';
import { query } from '../config/db.js';

/* ---- RESUMO DA CONVERSA (visão do robô + chance de conversão) ----
   Gera com Haiku e guarda em cache: só chama a IA se houver mensagens
   novas desde o último resumo (ou se force=true). */
export async function resumoConversa(req, res) {
  try {
    const convId = req.params.id;
    const force = !!req.body?.force;
    const conv = await Conversation.findById(convId);
    if (!conv) return res.status(404).json({ ok: false, erro: 'conversa não encontrada' });

    const totalMsgs = await Message.countByConversation(convId);
    if (!force && conv.resumo && Number(conv.resumo_msgs) === totalMsgs) {
      return res.json({ ok: true, cached: true, resumo: conv.resumo, conversao: conv.conversao, conversao_pct: conv.conversao_pct, resumo_at: conv.resumo_at });
    }
    if (totalMsgs < 2) return res.json({ ok: false, erro: 'conversa muito curta para resumir' });

    const msgs = await Message.listForPanel(convId);
    const transcript = msgs.slice(-40)
      .map(m => `${m.sender === 'lead' ? 'LEAD' : m.sender === 'humano' ? 'ATENDENTE' : 'AGENTE IA'}: ${m.content}`)
      .join('\n');
    const ficha = `Lead: ${conv.nome || 'sem nome'} | etapa do funil: ${conv.stage || '-'} | checkin: ${conv.checkin || '-'} | checkout: ${conv.checkout || '-'} | hóspedes: ${conv.guests || '-'} | valor cotado: ${conv.valor_cotado || '-'} | tags: ${(conv.tags || []).join(', ') || '-'}`;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: `Você é analista de vendas de uma hospedagem (Vila Mundaí, Porto Seguro). Analise a conversa entre o lead e o atendimento e responda APENAS com JSON válido, sem markdown, no formato:
{"resumo":["bullet curto 1","bullet curto 2","bullet curto 3"],"proximo_passo":"ação objetiva sugerida","conversao":"alta|media|baixa","pct":55}
Regras: 3 a 5 bullets, frases curtas e diretas (o que o lead quer, datas/pessoas, o que já foi feito, objeções/pendências). "pct" é sua estimativa de chance de fechar (0-100) com base no engajamento, etapa e sinais da conversa.`,
      messages: [{ role: 'user', content: ficha + '\n\nCONVERSA:\n' + transcript }],
    });

    const rawTxt = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let j;
    try { j = JSON.parse(rawTxt.replace(/^```json\s*|```\s*$/g, '').trim()); }
    catch { return res.status(502).json({ ok: false, erro: 'IA não retornou JSON válido' }); }

    const bullets = Array.isArray(j.resumo) ? j.resumo : [];
    const resumoTxt = bullets.map(b => `• ${b}`).join('\n') + (j.proximo_passo ? `\n→ Próximo passo: ${j.proximo_passo}` : '');
    const conversao = ['alta', 'media', 'baixa'].includes(String(j.conversao).toLowerCase()) ? String(j.conversao).toLowerCase() : 'media';
    const pct = Math.max(0, Math.min(100, parseInt(j.pct, 10) || 0));

    await Conversation.saveResumo(convId, { resumo: resumoTxt, conversao, conversao_pct: pct, resumo_msgs: totalMsgs });
    res.json({ ok: true, cached: false, resumo: resumoTxt, conversao, conversao_pct: pct, resumo_at: new Date().toISOString() });
  } catch (e) {
    console.error('[resumo] erro:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
}

/* ---- STATUS DA CONEXÃO COM A Z-API (diagnóstico) ---- */
export async function zapiStatus(req, res) {
  const { env } = await import('../config/env.js');
  const out = { instance_configurada: env.zapi.instanceId };
  try { out.status = await zapi.status(); }
  catch (e) { out.status_erro = e.response?.data || e.message; }
  try { out.webhooks = await zapi.webhooks(); }
  catch (e) { out.webhooks_erro = e.response?.data || e.message; }
  out.webhook_esperado = `${req.protocol}://${req.get('host')}/webhooks/whatsapp`;
  res.json(out);
}

/* ---- CANCELAR RESERVA NO PMS ---- */
export async function cancelarReservaPms(req, res) {
  try {
    const r = await hospedin.cancelarReserva(req.params.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
}

/* ---- COTAÇÃO PMS (preço nativo com desconto por ocupação) ---- */
export async function cotacaoPms(req, res) {
  try {
    const { checkin, checkout, guests, place_type_id } = req.body;
    if (!checkin || !checkout || !guests || !place_type_id) {
      return res.status(400).json({ error: 'checkin, checkout, guests e place_type_id são obrigatórios' });
    }
    const r = await hospedin.cotarNativo({ checkin, checkout, guests, place_type_id });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
}

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
  try {
    // Regra do CEO: lead em GANHO fica sem IA (atendimento humano).
    // Vale para qualquer caminho que mova o stage: Kanban, modal, chat.
    const patch = { ...req.body };
    if (patch.stage === 'ganho') patch.ai_enabled = false;
    res.json(await Lead.update(req.params.id, patch));
  } catch (e) { next(e); }
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
  try { res.json(await Message.listForPanel(req.params.id)); } catch (e) { next(e); }
}
export async function markConversationRead(req, res, next) {
  try { await Conversation.markRead(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
}
export async function finishConversation(req, res, next) {
  try { await Conversation.finish(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
}

// Envio manual pelo atendente humano — salva no histórico e envia via Z-API.
// Não passa pelo agente nem verifica robot_enabled.
export async function sendManual(req, res, next) {
  try {
    const { text } = req.body;
    const convId = req.params.id;
    if (!text?.trim()) return res.status(400).json({ error: 'text é obrigatório' });

    const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [convId]);
    const conv = rows[0];
    if (!conv) return res.status(404).json({ error: 'conversa não encontrada' });

    await Message.create({ conversation_id: convId, role: 'assistant', content: text, sender: 'humano' });
    await Conversation.touch(convId, text);
    await zapi.sendText(conv.phone, text);

    res.json({ ok: true });
  } catch (e) { next(e); }
}
// Vincula manualmente um LID (@lid) a um lead de telefone real e funde o
// contato provisório (mensagens passam para a conversa real).
export async function vincularLid(req, res, next) {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
    const lid = String(req.body?.lid || '').replace(/\D/g, '');
    if (!lid) return res.status(400).json({ error: 'lid é obrigatório (só dígitos)' });
    await Lead.update(lead.id, { lid });
    const { mergeLidOrphans } = await import('../services/agent.service.js');
    const r = await mergeLidOrphans({ ...lead, lid }, lid);
    res.json({ ok: true, lead_id: lead.id, lid, ...r });
  } catch (e) { next(e); }
}

// Backfill: busca o LID (telefone -> LID via Z-API) de todos os leads que
// ainda não têm, grava o mapa e funde contatos provisórios "@lid".
export async function backfillLids(req, res, next) {
  try {
    const { rows: leads } = await query(
      `SELECT id, phone, nome, lid FROM leads
        WHERE lid IS NULL AND phone NOT LIKE '%@%' ORDER BY id DESC LIMIT 200`);
    const { mergeLidOrphans } = await import('../services/agent.service.js');
    const report = { mapeados: 0, fundidos: 0, sem_lid: 0, erros: 0 };
    for (const l of leads) {
      try {
        const r = await zapi.phoneExists(l.phone);
        const lid = String(r?.lid || '').replace(/\D/g, '');
        if (!lid) { report.sem_lid++; continue; }
        await Lead.update(l.id, { lid });
        const m = await mergeLidOrphans({ ...l, lid }, lid);
        report.mapeados++;
        if (m.merged) report.fundidos++;
        await new Promise(r2 => setTimeout(r2, 350)); // gentil com a Z-API
      } catch { report.erros++; }
    }
    res.json({ ok: true, total_processados: leads.length, ...report });
  } catch (e) { next(e); }
}

// Backfill: funde leads duplicados que diferem só pelo 9º dígito (12 vs 13).
// Mantém o mais antigo (canônico) e move conversas/mensagens para ele.
export async function backfillTelefones(req, res, next) {
  try {
    const Lead = await import('../models/lead.model.js');
    const { mergePhoneDuplicates } = await import('../services/agent.service.js');
    const { rows: leads } = await query(
      `SELECT id, phone FROM leads WHERE phone NOT LIKE '%@%' ORDER BY id ASC`
    );
    const vistos = new Set();        // ids já fundidos (não reprocessar)
    const report = { grupos: 0, fundidos: 0, mensagens: 0 };
    for (const l of leads) {
      if (vistos.has(l.id)) continue;
      const full = await Lead.findById(l.id);
      if (!full) continue;
      const r = await mergePhoneDuplicates(full);
      if (r.merged) { report.grupos++; report.fundidos += r.dups; report.mensagens += r.mensagens; }
    }
    res.json({ ok: true, total_leads: leads.length, ...report });
  } catch (e) { next(e); }
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

export async function deleteLead(req, res, next) {
  try { await Lead.remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
}
