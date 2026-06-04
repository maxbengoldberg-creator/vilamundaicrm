import { handleIncoming } from '../services/agent.service.js';
import { anthropic } from '../services/claude.service.js';
import { env } from '../config/env.js';
import * as Automation from '../models/automation.model.js';

// Dispara o agente manualmente (ex.: para testes ou reativação).
export async function runAgent(req, res, next) {
  try {
    const { phone, text, pushName } = req.body;
    if (!phone || !text) return res.status(400).json({ error: 'phone e text são obrigatórios' });
    const r = await handleIncoming({ phone, text, pushName });
    res.json(r);
  } catch (e) { next(e); }
}

// ==========================================================
//  Geração de AUTOMAÇÃO por PROMPT.
//  Este é o "espaço de prompt" do CRM: o gestor descreve o
//  objetivo com o lead e a Claude devolve o FLUXO em JSON
//  (nós, condições, ações) que alimenta o construtor visual.
// ==========================================================
const FLOW_SYSTEM = `Você é um gerador de fluxos de automação para um CRM de hospedagem.
Receba um objetivo em português e devolva APENAS um JSON válido (sem markdown, sem comentários)
no formato:
{
  "nome": "string curta",
  "descricao": "string",
  "nodes": [
    { "tipo": "trigger|extrai|ia|pms|cond|acao|msg|fim",
      "titulo": "string",
      "sub": "string opcional",
      "bub": "texto de mensagem opcional",
      "branches": [ { "lbl": "Sim", "color": "green|red|amber", "nodes": [ ... ] } ]
    }
  ]
}
Use as ferramentas disponíveis do agente como ações: consultar_disponibilidade (tipo pms),
cotar, criar_reserva, gerar_link_pagamento, qualificar_lead, mover_funil, enviar_midia,
escalar_humano (tipo acao); extração de dados é tipo "extrai"; respostas ao lead são tipo "ia" ou "msg".
Sempre comece por um nó "trigger". Ramifique com "cond" quando houver decisão.
Responda somente com o JSON.`;

export async function generateAutomation(req, res, next) {
  try {
    const { prompt, salvar } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt é obrigatório' });

    const resp = await anthropic.messages.create({
      model: env.anthropic.model,
      max_tokens: 1500,
      system: FLOW_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    let flow;
    try {
      flow = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
    } catch {
      return res.status(502).json({ error: 'a IA não retornou JSON válido', raw });
    }

    let saved = null;
    if (salvar) {
      saved = await Automation.create({
        nome: flow.nome || 'Automação gerada',
        descricao: flow.descricao || '',
        flow: flow.nodes || [],
        prompt,
        enabled: false,
      });
    }

    res.json({ ok: true, flow, saved });
  } catch (e) { next(e); }
}
