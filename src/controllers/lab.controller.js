import * as Lab from '../services/lab.service.js';
import { invalidatePromptCache } from '../services/stage.prompts.js';

export async function getLab(req, res) {
  try { res.json(await Lab.getLab()); } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function seed(req, res) {
  try { res.json(await Lab.seedLab(!!req.body?.force)); } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function salvarCamada(req, res) {
  try {
    const { chave, conteudo } = req.body || {};
    res.json(await Lab.salvarCamada(chave, conteudo));
  } catch (e) { res.status(400).json({ error: e.message }); }
}

export async function publicarC3(req, res) {
  try {
    const r = await Lab.publicarC3();
    invalidatePromptCache();
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
}

export async function compor(req, res) {
  try { res.json(await Lab.compor()); } catch (e) { res.status(500).json({ error: e.message }); }
}

export async function enviarRascunhos(req, res) {
  try {
    const r = await Lab.enviarParaRascunhos();
    invalidatePromptCache();
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
}
