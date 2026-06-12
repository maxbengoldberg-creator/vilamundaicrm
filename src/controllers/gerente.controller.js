// ==========================================================
//  GERENTE MAX — Camada 1: Simulador (modo sandbox)
//  Nada aqui toca WhatsApp, PMS ou leads reais.
// ==========================================================

import * as Simulacao from '../models/simulacao.model.js';
import { runSimTurn, avaliarSimulacao } from '../services/simulador.service.js';

export async function criarSimulacao(req, res) {
  try {
    const { nome, usar_draft } = req.body || {};
    const sim = await Simulacao.create({ nome: nome || null, usar_draft: !!usar_draft });
    res.status(201).json(sim);
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

// Turno da simulação: CEO escreve como lead → Atendente Max responde em sandbox.
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

// Avaliação pós-simulação (rubrica de vendas → relatório + sugestões).
export async function avaliar(req, res) {
  try {
    const sim = await Simulacao.findById(req.params.id);
    if (!sim) return res.status(404).json({ error: 'simulação não encontrada' });
    const rel = await avaliarSimulacao(sim);
    if (rel.ok) await Simulacao.saveRelatorio(sim.id, rel);
    res.json(rel);
  } catch (e) {
    console.error('[gerente] avaliação falhou:', e.message);
    res.status(500).json({ error: e.message });
  }
}
