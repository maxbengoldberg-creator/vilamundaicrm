// Prompts por etapa do funil — carregados do banco com cache de 60s.
// Placeholders disponíveis nos textos do banco:
//   {{hoje}}, {{ano}}, {{nome}}, {{checkin}}, {{checkout}}, {{guests}}, {{sinal_30}},
//   {{condicoes_pagamento}} (JSON das condições acordadas na negociação)

import * as AutomationStage from '../models/automation_stage.model.js';

const CACHE_TTL = 60_000;
let _cache = null; // { [stage]: stageRow }
let _cacheTs = 0;

async function getStageMap() {
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) return _cache;
  try {
    const rows = await AutomationStage.list();
    _cache = Object.fromEntries(rows.map(r => [r.stage, r]));
    _cacheTs = Date.now();
    return _cache;
  } catch (err) {
    console.error('[stage.prompts] erro ao carregar do banco, usando cache anterior:', err.message);
    return _cache || {};
  }
}

function interpolate(template, lead) {
  const hoje = new Date().toISOString().split('T')[0];
  const ano = new Date().getFullYear();
  return template
    .replace(/\{\{hoje\}\}/g, hoje)
    .replace(/\{\{ano\}\}/g, String(ano))
    .replace(/\{\{nome\}\}/g, lead.nome || 'sem nome')
    .replace(/\{\{checkin\}\}/g, lead.checkin || '—')
    .replace(/\{\{checkout\}\}/g, lead.checkout || '—')
    .replace(/\{\{guests\}\}/g, String(lead.guests || '—'))
    .replace(/\{\{sinal_30\}\}/g, lead.valor_cotado
      ? (Number(lead.valor_cotado) * 0.3).toFixed(2)
      : 'verificar')
    .replace(/\{\{condicoes_pagamento\}\}/g, lead.condicoes_pagamento
      ? JSON.stringify(lead.condicoes_pagamento, null, 2)
      : 'não registradas');
}

// Bloco dinâmico com o que já foi feito nesta conversa (via tags), para o
// agente nunca repetir oferta de fotos ou ações já concluídas.
function estadoLead(lead) {
  const tags = Array.isArray(lead.tags) ? lead.tags : [];
  const linhas = [];
  if (tags.includes('imagens_1q_enviadas')) linhas.push('As fotos do apartamento de 1 quarto JÁ foram enviadas — não ofereça nem pergunte de novo se quer ver.');
  if (tags.includes('imagens_2q_enviadas')) linhas.push('As fotos do apartamento de 2 quartos JÁ foram enviadas — não ofereça nem pergunte de novo se quer ver.');
  if (tags.includes('imagens_area_externa_enviadas')) linhas.push('As fotos da área externa/piscina JÁ foram enviadas.');
  if (tags.includes('endereco_enviado')) linhas.push('O mapa da localização JÁ foi enviado.');
  if (tags.includes('orcamento_apresentado')) linhas.push('O orçamento JÁ foi apresentado — não pergunte "quer que eu veja os valores?" nem reapresente o preço sem o lead pedir. (Mudou nº de pessoas ou datas? Aí sim reconsulte.)');
  if (linhas.length === 0) return '';
  return '\n\nJÁ ACONTECEU NESTA CONVERSA (nunca repita nem pergunte de novo):\n- ' + linhas.join('\n- ');
}

// Regra fixa de preço, anexada a TODAS as etapas (no código, para nenhuma
// edição de prompt no banco perder essa proteção). O preço vem do PMS e
// varia por nº de hóspedes e por datas.
const REGRA_PRECO = `

REGRAS GERAIS (valem em qualquer etapa, prioridade máxima):

PREÇO: depende do número de hóspedes e das datas — quem calcula é o PMS.
Se o lead mencionar QUALQUER mudança no tamanho do grupo (mais uma pessoa, primo, amigo, criança, "e se formos X"):
- Se o novo total for inferível (ex: "éramos 2, primo vai junto" → 3), calcule você mesmo e confirme diretamente: "Seriam 3 então, deixa eu verificar o valor para 3 pessoas." NÃO pergunte o total quando a conta é simples e evidente.
- Se for realmente ambíguo (ex: "vamos ser um grupo"), aí pergunte.
Em seguida: atualize a ficha com extrair_dados_lead (novo guests), reconsulte com consultar_disponibilidade e apresente o novo total.
NUNCA afirme que o preço não muda com o número de pessoas e NUNCA responda o valor de outra quantidade de hóspedes de memória, sem reconsultar. Crianças contam como hóspedes. O mesmo vale se as datas mudarem.

AO APRESENTAR O PREÇO: na MESMA mensagem informe que o pagamento pode ser Pix ou cartão em até 3x, e termine com um próximo passo claro (ex: "Quer que eu faça a pré-reserva?"). Nunca apresente um valor sozinho, sem forma de pagamento e sem próximo passo.

DADOS PESSOAIS: nome completo, CPF e data de nascimento só são pedidos na hora de criar a pré-reserva, depois que o lead confirmar que quer reservar — e os três de uma vez. NÃO interrompa a apresentação ou a escolha do apartamento para pedir só o nome. Para se dirigir ao lead, use o nome que já tiver; se não tiver, não force.

NÃO REPETIR: não reofereça nem refaça o que já foi feito nesta conversa (ver o bloco "JÁ ACONTECEU"). Se já apresentou o orçamento, não ofereça consultar de novo; se já enviou fotos, não ofereça de novo; siga em frente rumo ao fechamento.`;

export async function buildStagePrompt(lead) {
  const map = await getStageMap();
  const entry = map[lead.stage] || map['qualif'] || {};
  return interpolate(entry.prompt_body || '', lead) + REGRA_PRECO + estadoLead(lead);
}

export async function getStageModel(stage) {
  const map = await getStageMap();
  return map[stage]?.model || 'claude-sonnet-4-6';
}

// Invalida o cache imediatamente (chamado após PATCH de um prompt).
export function invalidatePromptCache() {
  _cacheTs = 0;
}
