import * as AutomationStage from '../models/automation_stage.model.js';
import { invalidatePromptCache } from '../services/stage.prompts.js';

export async function listStages(req, res, next) {
  try {
    res.json(await AutomationStage.list());
  } catch (e) { next(e); }
}

export async function updateStage(req, res, next) {
  try {
    const { stage } = req.params;
    const { nome, descricao, prompt_body, enabled, model } = req.body;
    // Auto-backup: se o prompt vai mudar, guarda a versão atual antes.
    if (prompt_body != null) {
      const atual = await AutomationStage.getByStage(stage);
      if (atual && atual.prompt_body && atual.prompt_body !== prompt_body) {
        await AutomationStage.saveRevision(stage, atual.prompt_body, 'edicao');
      }
    }
    const result = await AutomationStage.update(stage, { nome, descricao, prompt_body, enabled, model });
    if (!result) return res.status(404).json({ error: 'etapa não encontrada' });
    invalidatePromptCache();
    res.json(result);
  } catch (e) { next(e); }
}

// ─── Rascunho (draft): o Simulador testa sem tocar produção ────────────────

export async function saveDraft(req, res, next) {
  try {
    const { stage } = req.params;
    const { prompt_draft } = req.body;
    const r = await AutomationStage.saveDraft(stage, prompt_draft || null);
    if (!r) return res.status(404).json({ error: 'etapa não encontrada' });
    invalidatePromptCache();
    res.json({ ok: true, stage, tem_draft: !!r.prompt_draft });
  } catch (e) { next(e); }
}

export async function promoteDraft(req, res, next) {
  try {
    const { stage } = req.params;
    const r = await AutomationStage.promoteDraft(stage);
    if (!r) return res.status(400).json({ error: 'etapa sem rascunho para promover' });
    invalidatePromptCache();
    res.json({ ok: true, stage, promovido: true });
  } catch (e) { next(e); }
}

// ─── Histórico de versões ───────────────────────────────────────────────────

export async function listRevisions(req, res, next) {
  try { res.json(await AutomationStage.listRevisions(req.params.stage)); } catch (e) { next(e); }
}

export async function getRevision(req, res, next) {
  try {
    const r = await AutomationStage.getRevision(req.params.id);
    if (!r) return res.status(404).json({ error: 'revisão não encontrada' });
    res.json(r);
  } catch (e) { next(e); }
}

export async function restoreRevision(req, res, next) {
  try {
    const { stage, id } = req.params;
    const rev = await AutomationStage.getRevision(id);
    if (!rev || rev.stage !== stage) return res.status(404).json({ error: 'revisão não encontrada para esta etapa' });
    const atual = await AutomationStage.getByStage(stage);
    if (atual?.prompt_body) await AutomationStage.saveRevision(stage, atual.prompt_body, 'restauracao');
    const result = await AutomationStage.update(stage, { prompt_body: rev.prompt_body });
    invalidatePromptCache();
    res.json({ ok: true, stage, restaurado_de: rev.id, result });
  } catch (e) { next(e); }
}
