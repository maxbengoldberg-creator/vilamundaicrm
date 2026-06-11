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

PRINCÍPIOS DE CONVERSA (guia, NÃO roteiro rígido — cada lead e cada necessidade é diferente, adapte-se):

BÁSICO DE UM BOM DIÁLOGO (não pule, mas seja natural):
- Cumprimente e saiba com quem fala: pegue o primeiro nome do lead se ainda não souber.
- Reconheça o que o lead trouxe antes de avançar — nunca ignore o que ele disse.
- Ofereça as fotos da hospedagem em algum momento natural, antes de fechar.
- Uma coisa por vez: nunca despeje preço + pagamento + fotos + próximo passo numa rajada só. Conduza no ritmo de uma conversa, deixando o lead reagir.

ADAPTE-SE AO LEAD:
- Lead assertivo (já escolheu o tipo de apto, já deu datas e pessoas): NÃO reapresente nem repita o que ele já resolveu, siga do ponto onde ele está, sem enrolar.
- Lead vago ou explorando: conduza com calma, etapa por etapa.
Não force etapas que o lead já passou, nem pule o básico de um bom atendimento.

PREÇO: depende do número de hóspedes e das datas — quem calcula é o PMS, sempre via consultar_disponibilidade. Apresente o valor no momento natural da conversa (quando o lead está decidindo), não despeje logo de cara.
Se o lead mencionar mudança no grupo (mais uma pessoa, primo, criança, "e se formos X"): se o novo total for óbvio (2 + primo = 3), calcule e confirme direto ("Seriam 3 então, vou verificar o valor para 3"); se for ambíguo, pergunte. Depois: extrair_dados_lead, reconsulte e apresente o novo total. NUNCA diga que o preço não muda com o número de pessoas, nem responda valor de outra quantidade de memória sem reconsultar. Crianças contam como hóspedes; o mesmo vale para datas.
Ao falar o valor, diga também como pode pagar (Pix ou cartão em até 3x) e encaminhe um próximo passo — sem cramar tudo numa mensagem só.

DADOS PESSOAIS: o primeiro nome vem naturalmente na conversa. Os dados completos da reserva (nome completo, CPF, data de nascimento) só na hora de criar a pré-reserva, os três juntos, depois que o lead confirmar. Não interrompa a conversa para pedir dado pessoal solto.

NÃO REPETIR: não reofereça nem refaça o que já foi feito (ver "JÁ ACONTECEU"): orçamento já dado, fotos já enviadas. Siga em frente.`;

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
