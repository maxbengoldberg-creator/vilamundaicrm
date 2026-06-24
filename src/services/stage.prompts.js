// Prompts por etapa do funil — carregados do banco com cache de 60s.
// Placeholders disponíveis nos textos do banco:
//   {{hoje}}, {{ano}}, {{nome}}, {{checkin}}, {{checkout}}, {{guests}}, {{sinal_30}},
//   {{condicoes_pagamento}} (JSON das condições acordadas na negociação)

import * as AutomationStage from '../models/automation_stage.model.js';
import * as Setting from '../models/setting.model.js';
import { query } from '../config/db.js';

const CACHE_TTL = 60_000;
let _cache = null; // { [stage]: stageRow }
let _cacheTs = 0;

// Modo do agente: 'modelo1' (prompts por etapa, padrão) ou 'modelo2' (camadas
// do Laboratório: C1 + C2 + ficha + C4 da etapa). Um por vez, escolhido na aba
// Agente. Cacheado 60s como o resto. Só vale em produção; o Simulador testa
// rascunhos no formato Modelo 1.
let _mode = { val: undefined, ts: 0 };
async function getAgentMode() {
  if (_mode.val !== undefined && Date.now() - _mode.ts < CACHE_TTL) return _mode.val;
  try {
    const v = await Setting.get('agent_mode', 'modelo1');
    _mode = { val: v === 'modelo2' ? 'modelo2' : 'modelo1', ts: Date.now() };
  } catch { _mode = { val: 'modelo1', ts: Date.now() }; }
  return _mode.val;
}

// Camadas do Laboratório (C1/C2/C4) lidas do banco com cache. Usadas só no
// Modelo 2 para compor o corpo do prompt da etapa em runtime.
let _camadas = { val: undefined, ts: 0 };
async function getCamadasMap() {
  if (_camadas.val !== undefined && Date.now() - _camadas.ts < CACHE_TTL) return _camadas.val;
  try {
    const { rows } = await query(`SELECT chave, conteudo FROM lab_camadas`);
    _camadas = { val: Object.fromEntries(rows.map(r => [r.chave, r.conteudo])), ts: Date.now() };
  } catch { _camadas = { val: {}, ts: Date.now() }; }
  return _camadas.val;
}

// Corpo do prompt no Modelo 2: C1 (identidade/tom) + C2 (fatos) + ficha do lead
// + C4 da etapa. Retorna null se a etapa não tem C4 (o chamador cai no Modelo 1).
async function getModelo2Body(stage) {
  const c = await getCamadasMap();
  const c4 = c[`c4_${stage}`];
  if (!c4 || !c4.trim()) return null;
  const ficha = 'LEAD: {{nome}} | checkin: {{checkin}} | checkout: {{checkout}} | hóspedes: {{guests}}';
  return [c['c1_identidade'], c['c2_fatos'], ficha, c4].filter(Boolean).join('\n\n');
}

// C3 (regras de condução) publicada no Laboratório: lida do banco com cache;
// se não existir lá, usa a constante REGRA_PRECO do código (fallback seguro).
let _c3 = { val: undefined, ts: 0 };
async function getC3Publicada() {
  if (_c3.val !== undefined && Date.now() - _c3.ts < CACHE_TTL) return _c3.val;
  try {
    const { rows } = await query(`SELECT conteudo FROM lab_camadas WHERE chave = 'c3_regras'`);
    _c3 = { val: rows[0]?.conteudo?.trim() || null, ts: Date.now() };
  } catch { _c3 = { val: null, ts: Date.now() }; }
  return _c3.val;
}

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
export const REGRA_PRECO = `

REGRAS GERAIS DE CONDUÇÃO:

ORDEM DO FUNIL: qualificação (primeiro nome + check-in, check-out, nº de pessoas) → apresentação (categorias que servem ao perfil + fotos) → orçamento (só aqui o valor EXATO, sempre com datas). Não consulte disponibilidade, não feche valor exato nem fale de pagamento antes do orçamento. Mesmo que o lead mande tudo junto, vá uma coisa por vez.

TOM: seja direto, sem preâmbulo ("Só pra confirmar/checar"), sem "para você" desnecessário, sem anunciar tempos ("na hora", "leva poucos minutos"). Uma pergunta por vez; não refaça pergunta já feita nem martele argumento já dito (bairro "residencial/familiar"). Nunca use travessão ou hífen para separar ideias (use ponto ou vírgula).

NÃO COMPARE DESTINOS: nunca diga que Mundaí é "melhor/mais que" Arraial, Taperapuã, etc. Se o lead citar outro lugar, reconheça que também é bom e siga, sem diminuir nem vender por comparação.

FERRAMENTA QUE FALHA: chame de novo, em silêncio. Nunca fale de "instabilidade/erro/sistema" nem peça para o lead aguardar ou voltar depois.

NUNCA CITE SISTEMAS INTERNOS (PMS, "sistema", cálculo interno). Passe só o valor ("o total fica R$ 2.450"), nunca "pelo PMS".

DATAS (máx 2 perguntas): se após 2 perguntas o lead não trouxe datas, pare, use mover_funil para "sem_datas" e fique à disposição. Quando ele trouxer datas, salve (extrair_dados_lead) e volte para "qualif".

PREÇO SEM DATAS: se insistir por valor sem datas, dê faixa como estimativa (1 quarto/casal, baixa: a partir de R$199 a diária; 2 quartos/até 4, baixa: a partir de R$259), diga "a partir de" e que varia por temporada e pessoas, e puxe de volta para as datas.

RÉVEILLON (datas pegando 30 ou 31 de dezembro): não cote nem informe preço; diga que por ser Réveillon a equipe verifica as condições e retorna.

RESERVAS 2027 (datas em 2027): não cote nem informe preço; diga que para 2027 a equipe ainda vai definir as condições e retorna.

ESTADIA CURTA (até 2 noites): não cote nem informe preço; diga que vai verificar a disponibilidade para essas datas e a equipe retorna. Nunca diga ao lead que é "reserva ruim".

GRUPO GRANDE (mais de 7 pessoas): precisa de mais de um apartamento; não cote e NUNCA diga que está indisponível. Diga que para um grupo desse tamanho a equipe verifica as melhores opções e retorna.

PREÇO EXATO (etapa de orçamento): vem da consulta de disponibilidade (tarifa do período + desconto por ocupação já aplicados); varia por pessoas e datas. Mudou o grupo ou as datas? Reconsulte (extrair_dados_lead + consultar_disponibilidade) e apresente o novo total; nunca responda de memória nem diga que o preço não muda com pessoas (crianças contam). APRESENTE O VALOR EXATAMENTE como a ferramenta devolveu: use o total de cada opção como veio (total_formatado), nunca recalcule, arredonde nem troque valores entre as opções. Na mesma mensagem: Pix ou cartão em até 3x e um próximo passo. Nunca um valor solto.

RITMO DO PREÇO: se o lead pediu preço só UMA vez, primeiro apresente o apartamento que melhor se adequa a ele e conduza a apresentação (fotos só se ele pedir, responda dúvidas); o preço vem DEPOIS, quando o lead reagir à apresentação. Apresente o preço de imediato (e direto, sem perguntar "quer que eu veja os valores?") apenas se o lead INSISTIR no valor (pedir 2 ou mais vezes).

DESCONTO PIX = CARTA NA MANGA: os 5% no Pix só se o lead PEDIR desconto. Escolher Pix como pagamento NÃO dá desconto — sem pedido, segue o preço cheio. Nunca ofereça por conta própria.

CONVITE DE PRÉ-RESERVA (sem ansiedade): convide no máximo 1 vez por vez, variando o jeito e sem começar com "quer que eu faça a pré-reserva". Dê espaço para responder; se já convidou e o lead perguntou outra coisa, responda só a pergunta e não reanexe o convite.

SINAL: 30% do total, NUNCA parcelado (Pix ou cartão 1x). Restante (70%) na chegada em até 2x (3x no total). Se o lead pedir flexibilidade, até 4x (1x do sinal + 3x na chegada). Nunca pergunte em quantas vezes dividir o sinal.

FECHAMENTO: com o lead confirmando e condições acordadas, nesta ordem: salvar_condicoes → colete nome completo, CPF e data de nascimento (juntos) → criar_reserva → confirme o código e finalize com "Vou elaborar o contrato e retorno em breve." → mover_funil para "contrato". Não mova para contrato antes de criar a pré-reserva; não use escalar_humano para isso.

CONTRATO: diga só que vai enviar o contrato por aqui para conferir e assinar. Não mencione "PDF", "WhatsApp" nem "Gov.br".

COMO FUNCIONA A PRÉ-RESERVA (se perguntarem): precisamos de nome completo, CPF e data de nascimento; depois enviamos o contrato por aqui; e um sinal de 30% para garantir, o restante na chegada.

DADOS PESSOAIS só na hora de criar a pré-reserva, os três juntos, após o lead confirmar. Não interrompa a conversa para pedir dado pessoal antes.

NÃO REPITA o que já foi feito (ver "JÁ ACONTECEU"): orçamento já dado, fotos já enviadas, mapa já enviado. Siga rumo ao fechamento.`;

// opts.draft=true: usa o rascunho da etapa quando existir (modo Simulador) —
// permite testar um ajuste de prompt sem tocar no que roda em produção.
export async function buildStagePrompt(lead, opts = {}) {
  const map = await getStageMap();
  const entry = map[lead.stage] || map['qualif'] || {};
  // Modelo 2 (camadas) só em produção; o Simulador (opts.draft) testa o Modelo 1.
  const mode = opts.mode || (opts.draft ? 'modelo1' : await getAgentMode());
  let body = null;
  if (mode === 'modelo2') body = await getModelo2Body(lead.stage);
  if (body == null) body = (opts.draft && entry.prompt_draft) ? entry.prompt_draft : (entry.prompt_body || '');
  const c3 = await getC3Publicada();
  const regras = c3 ? `\n\n${c3}` : REGRA_PRECO;
  return interpolate(body, lead) + regras + estadoLead(lead);
}

export async function getStageModel(stage) {
  const map = await getStageMap();
  return map[stage]?.model || 'claude-sonnet-4-6';
}

// Invalida o cache imediatamente (chamado após PATCH de um prompt, troca de
// modo do agente, ou edição de camada do Laboratório).
export function invalidatePromptCache() {
  _cacheTs = 0;
  _c3 = { val: undefined, ts: 0 };
  _mode = { val: undefined, ts: 0 };
  _camadas = { val: undefined, ts: 0 };
}
