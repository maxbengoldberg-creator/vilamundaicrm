import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { buildStagePrompt } from './stage.prompts.js';
import { query } from '../config/db.js';

export const anthropic = new Anthropic({ apiKey: env.anthropic.apiKey });

export async function buildSystemPrompt(lead) {
  return buildStagePrompt(lead);
}

export async function callClaude({ system, messages, tools, model, lead_id }) {
  const resp = await anthropic.messages.create({
    model: model || env.anthropic.model,
    max_tokens: env.anthropic.maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  });
  const i = resp.usage.input_tokens;
  const o = resp.usage.output_tokens;
  const cacheRead = resp.usage.cache_read_input_tokens || 0;
  const cacheWrite = resp.usage.cache_creation_input_tokens || 0;
  const custoBrl = (i * 15 + o * 75) / 1000000 * 5.7;
  console.log(`[tokens] input:${i} output:${o} cache_read:${cacheRead} cache_write:${cacheWrite} stop:${resp.stop_reason} custo:~R$${custoBrl.toFixed(4)}`);

  if (lead_id) {
    query(
      `UPDATE leads
          SET total_tokens_input  = total_tokens_input  + $1,
              total_tokens_output = total_tokens_output + $2,
              total_custo_brl     = total_custo_brl     + $3,
              updated_at          = now()
        WHERE id = $4`,
      [i, o, custoBrl, lead_id]
    ).catch(e => console.error('[tokens] falha ao salvar custo:', e.message));
  }

  return resp;
}
