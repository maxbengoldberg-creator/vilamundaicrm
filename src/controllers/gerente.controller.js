// ==========================================================
//  GERENTE MAX — Camada 1: Simulador (modo sandbox)
//  Nada aqui toca WhatsApp, PMS ou leads reais.
// ==========================================================

import * as Simulacao from '../models/simulacao.model.js';
import * as Message from '../models/message.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as AutomationStage from '../models/automation_stage.model.js';
import { invalidatePromptCache } from '../services/stage.prompts.js';
import { runSimTurn, avaliarSimulacao, gerarFalaLead } from '../services/simulador.service.js';
import { query } from '../config/db.js';

export async function criarSimulacao(req, res) {
  try {
    const { nome, usar_draft, from_conversation_id } = req.body || {};
    const sim = await Simulacao.create({ nome: nome || null, usar_draft: !!usar_draft });

    // Importa uma conversa real do Atendimentos como PERFIL: o ator-lead (IA)
    // vai imitar aquele lead de verdade (estilo, dúvidas, objeções).
    if (from_conversation_id) {
      const conv = await Conversation.findById(from_conversation_id);
      const msgs = await Message.listForPanel(from_conversation_id);
      const transcript = msgs.map(m =>
        `${m.sender === 'lead' ? 'LEAD' : 'ATENDENTE'}: ${m.content}`).join('\n');
      const perfil = { conversation_id: from_conversation_id, nome_lead: conv?.nome || null, transcript };
      await query(`UPDATE simulacoes SET perfil = $2, nome = COALESCE(nome, $3) WHERE id = $1`,
        [sim.id, JSON.stringify(perfil), conv?.nome ? `Réplica — ${conv.nome}` : null]);
    }
    res.status(201).json(await Simulacao.findById(sim.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function listarSimulacoes(req, res) {
  try { res.json(await Simulacao.list()); } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function obterSimulacao(req, res) {
  try {
    const sim = await Simulacao.findById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'simulação não encontrada' });
    res.json(sim);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function apagarSimulacao(req, res) {
  try { await Simulacao.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}

// Turno manual: CEO escreve como lead → Atendente Max responde em sandbox.
export async function mensagemSimulacao(req, res) {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text é obrigatório' });
    const sim = await Simulacao.findById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'simulação não encontrada' });

    const estado = {
      lead: sim.lead_json || {},
      messages: sim.messages_json || [],
      transcript: sim.transcript || [],
      usar_draft: sim.usar_draft,
    };
    const r = await runSimTurn(estado, text.trim());
    await Simulacao.saveState(sim.id, estado);
    res.json({ ok: true, resposta: r.resposta, tools: r.tools, eventos: r.eventos, lead: estado.lead, transcript: estado.transcript });
  } catch (e) {
    console.error('[gerente] turno falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// Ciclo automático (Fase 1.5): a IA-lead fala (imitando o perfil) e o
// Atendente Max responde. O front chama em loop para o modo automático.
export async function cicloIaLead(req, res) {
  try {
    const sim = await Simulacao.findById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'simulação não encontrada' });

    const fala = await gerarFalaLead(sim);
    if (!fala || /\[FIM\]/i.test(fala)) {
      return res.json({ ok: true, fim: true, transcript: sim.transcript, lead: sim.lead_json });
    }
    const estado = {
      lead: sim.lead_json || {},
      messages: sim.messages_json || [],
      transcript: sim.transcript || [],
      usar_draft: sim.usar_draft,
    };
    const r = await runSimTurn(estado, fala);
    await Simulacao.saveState(sim.id, estado);
    res.json({ ok: true, fim: false, fala_lead: fala, resposta: r.resposta, tools: r.tools, eventos: r.eventos, lead: estado.lead, transcript: estado.transcript });
  } catch (e) {
    console.error('[gerente] ciclo IA-lead falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// Avaliação pós-simulação: relatório + sugestões persistidas em insights.
export async function avaliar(req, res) {
  try {
    const sim = await Simulacao.findById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'simulação não encontrada' });
    const rel = await avaliarSimulacao(sim);
    if (rel.ok) {
      await Simulacao.saveRelatorio(sim.id, rel);
      // Cada sugestão vira uma pendência aplicável na aba Fluxos.
      for (const s of (rel.sugestoes || [])) {
        await query(
          `INSERT INTO insights (padrao, sugestao, evidencia, etapa, origem, status)
           VALUES ($1, $2, $3, $4, $5, 'novo')`,
          [s.problema || '', s.ajuste_sugerido || '', `Simulação #${sim.id} (nota ${rel.nota_geral})`, s.etapa || 'geral', `simulacao:${sim.id}`]
        );
      }
    }
    res.json(rel);
  } catch (e) {
    console.error('[gerente] avaliação falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ===== Insights (sugestões pendentes, visíveis na aba Fluxos) =====

export async function listarInsights(req, res) {
  try {
    const { rows } = await query(
      `SELECT * FROM insights WHERE status = 'novo' ORDER BY id DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Aplica a sugestão como RASCUNHO da etapa (produção intacta):
// rascunho = (rascunho existente ou prompt de produção) + bloco do ajuste.
export async function aplicarInsight(req, res) {
  try {
    const { rows } = await query(`SELECT * FROM insights WHERE id = $1`, [req.params.id]);
    const ins = rows[0];
    if (!ins) return res.status(404).json({ error: 'sugestão não encontrada' });
    const etapa = ins.etapa && ins.etapa !== 'geral' ? ins.etapa : (req.body?.etapa || null);
    if (!etapa) return res.status(400).json({ error: 'sugestão sem etapa — informe {etapa} no body' });
    const st = await AutomationStage.getByStage(etapa);
    if (!st) return res.status(404).json({ error: `etapa "${etapa}" não encontrada` });
    const base = st.prompt_draft || st.prompt_body || '';
    const novo = `${base}\n\n[AJUSTE SUGERIDO PELO GERENTE MAX — revise e edite antes de promover]\n${ins.sugestao}`;
    await AutomationStage.saveDraft(etapa, novo);
    await query(`UPDATE insights SET status = 'aplicado' WHERE id = $1`, [ins.id]);
    invalidatePromptCache();
    res.json({ ok: true, etapa, aplicado_em: 'rascunho' });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function descartarInsight(req, res) {
  try {
    await query(`UPDATE insights SET status = 'descartado' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
