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
    const { nome, descricao, prompt_body, enabled } = req.body;
    const result = await AutomationStage.update(stage, { nome, descricao, prompt_body, enabled });
    if (!result) return res.status(404).json({ error: 'etapa não encontrada' });
    invalidatePromptCache();
    res.json(result);
  } catch (e) { next(e); }
}
