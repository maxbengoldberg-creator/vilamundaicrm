import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { buildStagePrompt } from './stage.prompts.js';

export const anthropic = new Anthropic({ apiKey: env.anthropic.apiKey });

export async function buildSystemPrompt(lead) {
  return buildStagePrompt(lead);
}

export async function callClaude({ system, messages, tools, model }) {
  const resp = await anthropic.messages.create({
    model: model || env.anthropic.model,
    max_tokens: env.anthropic.maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  });
  const i = resp.usage.input_tokens;
  const o = resp.usage.output_tokens;
  const brl = ((i * 15 + o * 75) / 1000000 * 5.7).toFixed(4);
  console.log(`[tokens] input:${i} output:${o} custo:~R$${brl}`);
  return resp;
}
