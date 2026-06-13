// ==========================================================
//  GERENTE MAX — Camada 1: Simulador (modo sandbox)
//  Nada aqui toca WhatsApp, PMS ou leads reais.
// ==========================================================

import * as Simulacao from '../models/simulacao.model.js';
import * as Message from '../models/message.model.js';
import * as Conversation from '../models/conversation.model.js';
import * as AutomationStage from '../models/automation_stage.model.js';
import { invalidatePromptCache } from '../services/stage.prompts.js';
import { runSimTurn, avaliarSimulacao, gerarFalaLead, parseRoteiro, PERSONALIDADES, sortearPersonalidade } from '../services/simulador.service.js';
import { query } from '../config/db.js';

export async function criarSimulacao(req, res) {
  try {
    const { nome, usar_draft, from_conversation_id, personalidade, roteiro } = req.body || {};
    const sim = await Simulacao.create({ nome: nome || null, usar_draft: !!usar_draft });

    if (roteiro && String(roteiro).trim()) {
      // Diálogo colado/subido (.txt): o lead-IA reproduz as falas exatas.
      const falas = parseRoteiro(roteiro);
      await query(`UPDATE simulacoes SET perfil = $2, nome = COALESCE(nome, $3) WHERE id = $1`,
        [sim.id, JSON.stringify({ modo: 'roteiro', roteiro: falas, transcript: String(roteiro).slice(0, 8000) }),
         `Roteiro (${falas.length} falas)`]);
    } else if (from_conversation_id) {
      // Importa uma conversa real do Atendimentos como PERFIL: o ator-lead (IA)
      // vai imitar aquele lead de verdade (estilo, dúvidas, objeções).
      const conv = await Conversation.findById(from_conversation_id);
      const msgs = await Message.listForPanel(from_conversation_id);
      const transcript = msgs.map(m =>
        `${m.sender === 'lead' ? 'LEAD' : 'ATENDENTE'}: ${m.content}`).join('\n');
      const perfil = { conversation_id: from_conversation_id, nome_lead: conv?.nome || null, transcript };
      await query(`UPDATE simulacoes SET perfil = $2, nome = COALESCE(nome, $3) WHERE id = $1`,
        [sim.id, JSON.stringify(perfil), conv?.nome ? `Réplica — ${conv.nome}` : null]);
    } else {
      // Personalidade do ator-lead: escolhida ou sorteada (lead realista).
      const p = (personalidade && PERSONALIDADES[personalidade]) ? personalidade : sortearPersonalidade();
      await query(`UPDATE simulacoes SET perfil = $2 WHERE id = $1`,
        [sim.id, JSON.stringify({ personalidade: p })]);
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
      // Cada sugestão vira uma pendência aplicável, roteada pela camada:
      // c4_etapa aparece no Fluxos e no Laboratório; c1/c2/c3 só no Laboratório.
      for (const s of (rel.sugestoes || [])) {
        const camada = ['c1_tom', 'c2_fato', 'c3_regra', 'c4_etapa'].includes(s.camada) ? s.camada : 'c4_etapa';
        await query(
          `INSERT INTO insights (padrao, sugestao, evidencia, etapa, origem, camada, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'novo')`,
          [s.problema || '', s.ajuste_sugerido || '', `Simulação #${sim.id} (nota ${rel.nota_geral})`, s.etapa || 'geral', `simulacao:${sim.id}`, camada]
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
    const texto = (req.body?.sugestao ?? ins.sugestao);  // permite editar antes de aplicar
    const novo = `${base}\n\n[AJUSTE SUGERIDO PELO GERENTE MAX — revise e edite antes de promover]\n${texto}`;
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

// Aplica a sugestão na CAMADA do Laboratório (C1/C2/C3/C4) — sempre como
// adição marcada para revisão; nada vai direto a produção.
export async function aplicarInsightCamada(req, res) {
  try {
    const { rows } = await query(`SELECT * FROM insights WHERE id = $1`, [req.params.id]);
    const ins = rows[0];
    if (!ins) return res.status(404).json({ error: 'sugestão não encontrada' });

    const Lab = await import('../services/lab.service.js');
    const camada = ins.camada || 'c4_etapa';
    let chave;
    if (camada === 'c1_tom') chave = 'c1_identidade';
    else if (camada === 'c2_fato') chave = 'c2_fatos';
    else if (camada === 'c3_regra') chave = 'c3_regras_draft';
    else {
      const etapa = (ins.etapa && ins.etapa !== 'geral') ? ins.etapa : (req.body?.etapa || null);
      if (!etapa) return res.status(400).json({ error: 'sugestão de etapa sem etapa definida — informe {etapa}' });
      chave = `c4_${etapa}`;
    }
    const lab = await Lab.getLab();
    const atualMap = {
      c1_identidade: lab.c1?.conteudo, c2_fatos: lab.c2?.conteudo,
      c3_regras_draft: lab.c3_draft?.conteudo || lab.c3_codigo,
    };
    const base = chave.startsWith('c4_') ? (lab.c4?.[chave.slice(3)]?.conteudo || '') : (atualMap[chave] || '');
    const texto = (req.body?.sugestao ?? ins.sugestao);  // permite editar antes de aplicar
    const novo = `${base}\n\n[AJUSTE SUGERIDO PELO GERENTE MAX — revise e edite]\n${texto}`;
    await Lab.salvarCamada(chave, novo);
    await query(`UPDATE insights SET status = 'aplicado' WHERE id = $1`, [ins.id]);
    res.json({ ok: true, camada, chave });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
