// ==========================================================
//  SIMULADOR (Gerente Max — Camada 1, modo sandbox)
//  Roda o MESMO cérebro do Atendente Max (prompts do banco +
//  REGRA_PRECO + ferramentas + modelo por etapa), mas:
//   - nada vai para o WhatsApp (Z-API não é chamada)
//   - nada toca o PMS (preços são mockados e marcados como simulados)
//   - o "lead" é um objeto virtual da sessão, não a tabela leads
// ==========================================================

import { callClaude, anthropic } from './claude.service.js';
import { buildStagePrompt, getStageModel } from './stage.prompts.js';
import { TOOLS } from '../tools/index.js';

const MAX_TOOL_ROUNDS = 10;

// Mesma sequência do funil de produção (handlers.js).
const STAGE_ORDER = ['qualif', 'apres', 'quente', 'negociacao', 'contrato', 'pagamento', 'ganho'];
const MORNO_NEXT = 'negociacao';
function nextStage(current) {
  if (current === 'morno') return MORNO_NEXT;
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

// Preços fictícios mas plausíveis para o sandbox (deterministas).
// NÃO são os preços reais — o avaliador não julga valores absolutos.
const MOCK_BASE = { 178135: 380, 179290: 360, 179291: 520, 178729: 550 };
const TIPOS = [
  { place_type_id: 178135, acomodacao: '1 Quarto - Térreo', occupants: 5 },
  { place_type_id: 179290, acomodacao: '1 Quarto - Superior', occupants: 5 },
  { place_type_id: 179291, acomodacao: '2 Quartos - Térreo', occupants: 7 },
  { place_type_id: 178729, acomodacao: '2 Quartos - Superior', occupants: 7 },
];
const TAG_POR_MIDIA = {
  'apto-1-quarto-terreo': 'imagens_1q_enviadas',
  'apto-1-quarto-superior': 'imagens_1q_enviadas',
  'apartamento-dois-quartos': 'imagens_2q_enviadas',
  'area-externa': 'imagens_area_externa_enviadas',
  'endereco': 'endereco_enviado',
};

function brl(v) { return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function addTags(lead, novas) {
  const set = new Set([...(lead.tags || []), ...novas]);
  lead.tags = [...set];
}

// Handlers de simulação: mesmo contrato dos reais, zero efeito colateral.
// Recebem (input, lead, eventos) — eventos é a lista de efeitos visíveis
// (fotos "enviadas" etc.) para o transcript.
function simHandlers(lead, eventos) {
  return {
    async consultar_disponibilidade(input) {
      const noites = Math.round((new Date(input.checkout) - new Date(input.checkin)) / 86400000);
      if (!noites || noites < 1) return { ok: false, erro: 'Período inválido.' };
      const g = Number(input.guests) || 2;
      const disponiveis = TIPOS.filter(t => t.occupants >= g).map(t => {
        const desc = t.occupants === 5 ? (5 - Math.max(g, 2)) * 30 : (7 - Math.max(g, 2)) * 25;
        const diaria = Math.max(MOCK_BASE[t.place_type_id] - desc, 100);
        const total = diaria * noites;
        return {
          ...t, disponivel: true, noites,
          diaria, diaria_formatada: brl(diaria),
          total_estadia: total, total_formatado: brl(total),
        };
      });
      addTags(lead, ['orcamento_apresentado']);
      return { ok: true, simulado: true, noites, disponiveis };
    },
    async cotar(input) {
      const noites = input.noites || 1;
      const total = Number(input.diaria) * noites;
      lead.valor_cotado = total; lead.acomodacao = input.acomodacao;
      return { ok: true, acomodacao: input.acomodacao, noites, total, total_formatado: brl(total) };
    },
    async extrair_dados_lead(input) {
      const salvo = {};
      for (const k of ['nome', 'checkin', 'checkout', 'guests', 'acomodacao', 'cpf', 'data_nascimento']) {
        if (input[k] !== undefined && input[k] !== null && input[k] !== '') { lead[k] = input[k]; salvo[k] = input[k]; }
      }
      return { ok: true, salvo };
    },
    async qualificar_lead(input) {
      lead.qual_score = input.score;
      if (input.tags) addTags(lead, input.tags);
      return { ok: true, score: input.score, tags: input.tags || [] };
    },
    async mover_funil(input) {
      const allowed = nextStage(lead.stage);
      if (input.stage !== allowed) {
        return { ok: false, erro: `Avanço bloqueado: de "${lead.stage}" o próximo permitido é "${allowed}", não "${input.stage}".` };
      }
      lead.stage = input.stage;
      return { ok: true, stage: input.stage };
    },
    async enviar_midia(input) {
      const tag = TAG_POR_MIDIA[input.tipo_apto];
      if (tag) addTags(lead, [tag]);
      eventos.push(`[FOTOS enviadas: ${input.tipo_apto} (simulado)]`);
      return { ok: true, simulado: true, enviadas: 6, tipo_apto: input.tipo_apto };
    },
    async gerar_link_pagamento(input) {
      eventos.push(`[LINK de pagamento (simulado): ${brl(input.valor)}]`);
      return { ok: true, simulado: true, link: 'https://pagamento.simulado/checkout/teste', valor: input.valor, valor_formatado: brl(input.valor) };
    },
    async criar_reserva(input) {
      const tipo = input.tipo_apto || lead.acomodacao;
      if (lead.acomodacao && tipo !== lead.acomodacao) {
        return { ok: false, erro: `Bloqueado: a ficha do lead diz "${lead.acomodacao}", mas você pediu "${tipo}".` };
      }
      const noites = Math.round((new Date(input.checkout) - new Date(input.checkin)) / 86400000);
      const t = TIPOS.find(x => x.acomodacao === tipo) || TIPOS[0];
      const g = Number(input.guests) || 2;
      const desc = t.occupants === 5 ? (5 - Math.max(g, 2)) * 30 : (7 - Math.max(g, 2)) * 25;
      const total = Math.max(MOCK_BASE[t.place_type_id] - desc, 100) * noites;
      lead.valor_cotado = total;
      eventos.push(`[PRÉ-RESERVA criada (simulada): ${tipo}, ${noites} noites, ${brl(total)}]`);
      return { ok: true, simulado: true, pms_id: 0, codigo: `SIM:${String(Date.now()).slice(-6)}`, status: 'pre_reservation', valor_total: total, diaria_media: Math.round((total / noites) * 100) / 100 };
    },
    async salvar_condicoes(input) {
      lead.condicoes_pagamento = {
        forma_pagamento: input.forma_pagamento, parcelas: input.parcelas,
        desconto_pix: input.desconto_pix, valor_total: input.valor_total, valor_sinal: input.valor_sinal,
      };
      return { ok: true, salvo: lead.condicoes_pagamento };
    },
    async escalar_humano(input) {
      lead.ai_enabled = false;
      eventos.push(`[ESCALADO para humano (simulado): ${input.motivo}]`);
      return { ok: true, simulado: true, ia_pausada: true, motivo: input.motivo };
    },
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// Roda UM turno da simulação: mensagem do "lead" → respostas do Atendente Max.
// Muta lead/messages/transcript da sessão (caller persiste).
export async function runSimTurn({ lead, messages, transcript, usar_draft }, text) {
  messages.push({ role: 'user', content: text });
  transcript.push({ role: 'lead', text, ts: new Date().toISOString() });

  const partes = [];
  const toolsUsadas = [];
  const eventos = [];
  const handlers = simHandlers(lead, eventos);
  let lastStop = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const system = await buildStagePrompt(lead, { draft: usar_draft });
    const model = await getStageModel(lead.stage);
    const resp = await callClaude({ system, messages, tools: TOOLS, model });
    lastStop = resp.stop_reason;

    const temConteudo = Array.isArray(resp.content) && resp.content.length > 0;
    if (temConteudo) messages.push({ role: 'assistant', content: resp.content });

    const texto = textOf(resp.content);
    if (texto && texto.trim()) partes.push(texto.trim());

    if (resp.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const handler = handlers[block.name];
        let result;
        try { result = handler ? await handler(block.input || {}) : { ok: false, erro: `ferramenta ${block.name} nao existe` }; }
        catch (e) { result = { ok: false, erro: e.message }; }
        toolsUsadas.push({ name: block.name, input: block.input || {}, ok: result?.ok });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  // Mesmo guarda-corpo da produção: rodadas estouradas em tool_use → força texto.
  if (lastStop === 'tool_use') {
    try {
      const system = await buildStagePrompt(lead, { draft: usar_draft });
      const model = await getStageModel(lead.stage);
      const resp = await callClaude({ system, messages, tools: TOOLS, tool_choice: { type: 'none' }, model });
      const texto = textOf(resp.content);
      if (texto && texto.trim()) {
        partes.push(texto.trim());
        messages.push({ role: 'assistant', content: resp.content });
      }
    } catch (e) { console.error('[simulador] fechamento forçado falhou:', e.message); }
  }

  const respostaFinal = partes.join('\n\n');
  transcript.push({
    role: 'agente',
    text: respostaFinal || '(sem resposta)',
    tools: toolsUsadas,
    eventos,
    etapa: lead.stage,
    ts: new Date().toISOString(),
  });

  return { resposta: respostaFinal, tools: toolsUsadas, eventos, lead };
}

// ===== Avaliador (Fase 1.3): rubrica de vendas sobre o transcript =====
const RUBRICA = `Você é o GERENTE MAX, gerente de vendas e especialista em agentes de IA da Vila Mundaí (hospedagem em Porto Seguro). Avalie a SIMULAÇÃO de conversa entre um lead (interpretado pelo CEO) e o Atendente Max (agente IA de vendas).

RUBRICA:
1. TOM: frases curtas, sem emojis/exclamação/listas, sem entusiasmo forçado, espelha saudação.
2. ORDEM DO FUNIL: qualifica (nome, datas, pessoas) antes de apresentar; apresenta antes de orçar; preço sempre com forma de pagamento e próximo passo.
3. PRECISÃO: nunca inventa preço (vem da ferramenta), reconsulta quando muda nº de pessoas/datas, capacidades certas (1Q=5, 2Q=7), lead escolhe o tipo.
4. NÃO REPETIR: não reoferta fotos/orçamento já dados, não repete perguntas respondidas.
5. CONDUÇÃO DE VENDA: reconhece o que o lead traz, responde dúvida antes de avançar, fechamento natural sem pressão, avança quando há sinal de compra.
(Os VALORES em si são mockados — não julgue se o preço é caro/barato, julgue o PROCESSO.)

CLASSIFIQUE cada sugestão pela NATUREZA do problema (campo "camada"):
- "c1_tom": tom/estilo de escrita do agente (vale para a conversa toda — frases, ritmo, formalidade, repetição de muletas)
- "c2_fato": informação errada ou faltando sobre a hospedagem (capacidade, endereço, regras da casa, pagamento)
- "c3_regra": regra de condução que vale em QUALQUER etapa (quando dar preço, não repetir, ritmo de perguntas, coleta de dados)
- "c4_etapa": roteiro/fluxo de UMA etapa específica (informe a etapa)

Responda APENAS JSON válido:
{"nota_geral": 0-10,
 "erros": ["..."],
 "oportunidades_perdidas": ["..."],
 "pontos_fortes": ["..."],
 "sugestoes": [{"camada": "c1_tom|c2_fato|c3_regra|c4_etapa", "etapa": "qualif|apres|quente|negociacao|contrato|pagamento|ganho|morno|geral", "problema": "...", "ajuste_sugerido": "texto pronto para adicionar/alterar"}]}`;

// ===== Ator-lead (Fase 1.5): IA interpreta o lead na simulação =====
// Lead REAL é curto, objetivo e imprevisível — o ator imita isso.
// Se a sessão tem `perfil` (transcript de conversa real importada do
// Atendimentos), o ator imita aquele lead; senão usa uma personalidade.

export const PERSONALIDADES = {
  apressado: 'APRESSADO: só quer saber o preço, logo. Mensagens de 2 a 6 palavras ("qnt fica?", "tem vaga?", "manda o valor"). Ignora apresentações e enrolação, cobra objetividade ("só me fala o preço"). Se demorarem a dar valor, fica impaciente.',
  desconfiado: 'DESCONFIADO: questiona tudo ("isso é golpe?", "tem CNPJ?", "posso ver avaliação?", "como sei que existe?"). Pede provas, fotos reais, endereço. Demora a confiar, mas fecha se convencido.',
  economico: 'ECONÔMICO: acha tudo caro ("nossa, tá salgado", "tem desconto?", "e se eu pagar à vista?", "vi mais barato ali"). Pechinchador, compara com outros lugares, pergunta o que está incluso para justificar o preço.',
  vago: 'VAGO: não sabe direito o que quer ("queria ver aí pra família", "algo pra umas férias"). Não tem datas fechadas, responde pela metade, muda de ideia, às vezes some do assunto e pergunta outra coisa.',
  decidido: 'DECIDIDO: já pesquisou, sabe as datas e quantas pessoas, quer resolver rápido. Responde na lata, pede o passo a passo para fechar, não enrola.',
};

export function sortearPersonalidade() {
  const keys = Object.keys(PERSONALIDADES);
  return keys[Math.floor(Math.random() * keys.length)];
}

export async function gerarFalaLead(sim) {
  const transcript = sim.transcript || [];
  const perfil = sim.perfil || null;
  const historico = transcript.map(t => `${t.role === 'lead' ? 'LEAD' : 'ATENDENTE'}: ${t.text}`).join('\n');

  let quem;
  if (perfil?.transcript) {
    quem = `Imite o LEAD REAL de referência abaixo: mesmo jeito de escrever, mesmo ritmo, mesmas dúvidas, objeções e nível de interesse. Transcript verdadeiro:\n${perfil.transcript.slice(0, 6000)}`;
  } else {
    const p = PERSONALIDADES[perfil?.personalidade] || PERSONALIDADES[sortearPersonalidade()];
    quem = `Personalidade deste lead — ${p}`;
  }

  const system = `Você interpreta um LEAD brasileiro de WhatsApp falando com o atendente da Vila Mundaí (hospedagem em Porto Seguro). Você NÃO é um assistente: é um cliente comum, com pressa e vida própria.

${quem}

COMO LEAD REAL ESCREVE (siga à risca):
- CURTO: a maioria das mensagens tem 2 a 8 palavras. Nunca escreva parágrafos.
- Informal: abreviações (vc, pq, qnt, blz, obg), pontuação largada, inicial minúscula às vezes, um erro de digitação ocasional (ex: "pessas", "quato").
- IMPREVISÍVEL: às vezes ignora a pergunta do atendente e pergunta outra coisa; muda de assunto sem avisar; responde só metade do que foi perguntado; de vez em quando manda duas mensagens curtas em vez de uma (separe com quebra de linha).
- Pergunta preço cedo e mais de uma vez se não responderem.
- Não agradece toda hora, não elogia o atendimento, não puxa assunto à toa.
- Nunca revele que é IA. Nunca use linguagem de assistente ("Claro!", "Com certeza!").
- Se a conversa chegou a um desfecho real (pré-reserva criada, desistiu, ou nada mais a tratar), responda exatamente: [FIM]`;

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 150,
    system,
    messages: [{ role: 'user', content: `CONVERSA ATÉ AGORA:\n${historico || '(ainda não começou — abra a conversa como esse lead abriria, do jeito dele)'}\n\nPRÓXIMA mensagem do lead:` }],
  });
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return text;
}

export async function avaliarSimulacao(sim) {
  const transcript = sim.transcript || [];
  if (transcript.length < 2) return { ok: false, erro: 'simulação muito curta para avaliar' };
  const texto = transcript.map(t => {
    if (t.role === 'lead') return `LEAD: ${t.text}`;
    const tools = (t.tools || []).map(x => x.name).join(', ');
    return `ATENDENTE MAX [etapa ${t.etapa}${tools ? ` | tools: ${tools}` : ''}]: ${t.text}${(t.eventos || []).map(e => `\n${e}`).join('')}`;
  }).join('\n\n');

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: RUBRICA,
    messages: [{ role: 'user', content: `Lead virtual final: ${JSON.stringify(sim.lead_json)}\n\nTRANSCRIPT:\n${texto}` }],
  });
  const raw = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  try {
    return { ok: true, ...JSON.parse(raw.replace(/^```json\s*|```\s*$/g, '').trim()) };
  } catch {
    return { ok: false, erro: 'avaliador não retornou JSON válido', raw };
  }
}
