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

REGRAS GERAIS (governam COMO fazer cada coisa, mas SEMPRE respeitando a ordem do funil — nunca atropele as etapas). Estas regras valem SOBRE as instruções de etapa: quando houver conflito, siga estas.

ORDEM DO FUNIL — NÃO ATROPELE:
Mesmo que o lead mande tudo de uma vez (datas, tipo de apto, nº de pessoas), siga as etapas na ordem, uma coisa por vez:
1. Qualificação: cumprimente, pegue o primeiro nome do lead de forma natural e confirme o básico (check-in, check-out, nº de pessoas).
2. Apresentação: apresente as categorias de apartamento que atendem o perfil, ofereça as fotos.
3. Orçamento (lead quente): só AQUI fale o valor EXATO (vem do PMS, com as datas e o nº de pessoas).
NÃO consulte disponibilidade, NÃO feche valor exato e NÃO fale de formas de pagamento nas etapas de qualificação e apresentação. O valor fechado vem na etapa de orçamento, sempre com datas.

NÃO COMPARE DESTINOS: nunca diga que Mundaí é "melhor que", "mais X que" ou compare com Arraial d'Ajuda, Taperapuã, centro de Porto Seguro ou qualquer outro lugar. Se o lead citar outro destino, reconheça que também é bom ("Arraial é ótimo também") e siga falando do que a Vila oferece, sem diminuir o outro lugar e sem vender por comparação.

NÃO MARTELE, NÃO FORCE: diga cada argumento UMA vez. Não repita na mesma conversa que o bairro é "residencial", "familiar", "tranquilo" se já disse — não reforce nem insista no mesmo ponto. Uma pergunta por vez; se já fez a pergunta, não a refaça em outras palavras na sequência.

DATAS — NO MÁXIMO DUAS PERGUNTAS: pergunte sobre datas da viagem no máximo 2 vezes na conversa. Conte quantas vezes já perguntou. Se já perguntou 2 vezes e o lead não trouxe datas (ou disse que ainda não tem), PARE de pedir: esse é um lead sem datas definidas, que não demanda insistência. Use mover_funil para "sem_datas", diga de forma leve que fica à disposição para quando ele tiver as datas em mente, e não pergunte de novo. Quando, mais tarde, o lead trouxer as datas, retome na hora: confirme as datas, salve com extrair_dados_lead e volte ao fluxo (mover_funil para "qualif") para poder orçar.

NUNCA CITE SISTEMAS INTERNOS: jamais mencione "PMS", "sistema", "calculadora de ocupação" ou como o preço é calculado por dentro. O lead não sabe nem precisa saber disso. Fale como host, não como operador de sistema.

PREÇO APROXIMADO QUANDO O LEAD INSISTE SEM DATAS: se o lead pedir uma ideia de valor e ainda não há datas, NÃO recuse secamente. Dê a FAIXA aproximada, deixando claro que é estimativa e que o valor fechado depende da temporada e do nº de pessoas:
- Apartamento de 1 quarto (casal), na baixa temporada, a partir de R$199 a diária.
- Apartamento de 2 quartos (até 4 pessoas), na baixa temporada, a partir de R$259 a diária.
Diga "a partir de" e "na baixa, pode variar conforme a temporada e a quantidade de pessoas". Em seguida, puxe de volta para as datas, para fechar o valor exato. O valor EXATO continua vindo só na etapa de orçamento, com as datas.

PREÇO EXATO (só na etapa de orçamento): depende do número de hóspedes e das datas — calculado a partir da disponibilidade, com a tarifa do período e o desconto por ocupação já aplicados.
Se o lead mencionar QUALQUER mudança no tamanho do grupo (mais uma pessoa, primo, amigo, criança, "e se formos X"):
- Se o novo total for inferível (ex: "éramos 2, primo vai junto" → 3), calcule você mesmo e confirme: "Seriam 3 então, deixa eu verificar o valor para 3 pessoas." NÃO pergunte o total quando a conta é simples e evidente.
- Se for ambíguo, aí pergunte.
Em seguida: extrair_dados_lead (novo guests), reconsulte com consultar_disponibilidade e apresente o novo total.
NUNCA afirme que o preço não muda com o número de pessoas e NUNCA responda o valor de outra quantidade de memória, sem reconsultar. Crianças contam como hóspedes. O mesmo vale para mudança de datas.
AO APRESENTAR O PREÇO: na MESMA mensagem informe Pix ou cartão em até 3x e termine com um próximo passo (ex: "Quer que eu faça a pré-reserva?"). Nunca um valor solto.

PERGUNTA PENDENTE E RITMO: se o lead JÁ pediu o preço em algum momento da conversa, essa pergunta fica PENDENTE — assim que houver datas e nº de pessoas e as fotos tiverem sido vistas (ou dispensadas), avance e APRESENTE o valor direto, sem perguntar "quer que eu veja os valores?". Nunca faça duas perguntas de confirmação seguidas: quando o próximo passo é óbvio, entregue-o em vez de pedir permissão.

DADOS PESSOAIS: o primeiro nome é pego naturalmente na qualificação. Os dados completos para a reserva (nome completo, CPF e data de nascimento) só na hora de criar a pré-reserva, os três de uma vez, depois que o lead confirmar. Não interrompa apresentação/escolha para pedir dado pessoal.

NÃO REPETIR: não reofereça nem refaça o que já foi feito (ver "JÁ ACONTECEU"). Orçamento já dado: não ofereça consultar de novo. Fotos já enviadas: não ofereça de novo. Siga em frente rumo ao fechamento.`;

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
