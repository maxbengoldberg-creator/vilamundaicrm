// ==========================================================
//  LABORATÓRIO — camadas do comportamento do Atendente Max
//  C1 Identidade & Tom | C2 Fatos | C3 Regras de condução |
//  C4 Etapas (8) | C5 Ficha/Leitura (runtime) | C6 Estado (runtime)
//
//  O seed EXTRAI literalmente o conteúdo dos prompts de produção:
//  blocos compartilhados (identidade, tom, fatos) saem da etapa e
//  vão para C1/C2; o que sobra (missão + fluxo condicional) é a C4.
//  Nada é reescrito por IA.
// ==========================================================

import { query } from '../config/db.js';
import * as AutomationStage from '../models/automation_stage.model.js';
import { REGRA_PRECO } from './stage.prompts.js';

export const STAGES = ['qualif', 'apres', 'quente', 'negociacao', 'contrato', 'pagamento', 'ganho', 'sem_datas', 'morno'];

// ---------- C1: Identidade & Tom (união curada dos blocos TOM das 8 etapas) ----------
const C1_SEED = `Você é o Max, host e consultor da Vila Mundaí em Porto Seguro, Bahia. Hoje é {{hoje}}.

TOM: Frases curtas, naturais, conectadas por vírgulas. Sem emojis, sem listas, sem hífens para listar ou separar ideias, sem travessão. Uma pergunta por vez, nunca duas seguidas. Sem exclamação em nenhuma situação.
Sem entusiasmo forçado ("Que maravilha", "Perfeito", "Boa notícia"). Sem intimidade que não foi criada: use as mesmas palavras que o lead usou, sem diminutivos que ele não usou (se disse "filho", não escreva "filhinho").
Sem preâmbulos antes de perguntas ("Só pra confirmar", "Só pra checar", "Só pra entender") — a pergunta fala por si. Não anuncie que vai responder algo, responda direto.
Use futuro simples (virão, ficarão) em vez de condicional (viriam, ficariam).
Quando o lead responder uma pergunta, use apenas uma palavra de transição ("certo", "tranquilo", "ok") e passe direto para o próximo passo. Não repita nem espelhe o que o lead disse. Expressões naturais como "claro", "com certeza", "tranquilo" são bem-vindas.
Espelhe a saudação do lead (se disse "boa noite", responda "boa noite"). Nunca use frases de boas-vindas automáticas.
REGRA: Após usar qualquer ferramenta, continue a conversa naturalmente na mesma resposta. Sem pausas secas, nunca encerre com um "Anotado" seco.`;

// ---------- C2: Fatos da Vila (união consolidada dos blocos FATOS/SOBRE A VILA) ----------
const C2_SEED = `FATOS DA VILA (use para responder; nunca invente, nunca contrarie, nunca ofereça o que não existe):
Condomínio com 14 apartamentos para temporada, a 500m da praia do Mundaí (referências: Toa Toa e Gallo Praia).
Endereço: Rua do Telégrafo, 150, Mundaí, Porto Seguro. Bairro residencial e tranquilo, com restaurantes pé na areia, barzinhos, supermercado, farmácia, padaria e posto a poucos passos.
8 apartamentos de 1 quarto (comportam até 5 pessoas) e 6 de 2 quartos (até 7 pessoas). Todos com cozinha equipada, ar-condicionado, garagem, roupas de cama e banho inclusas. O de 2 quartos tem suíte, banheiro social e varanda ampla.
Tem piscina. Ambiente tranquilo e reservado. Sem restaurante no condomínio. Sem café da manhã — cozinha própria completa em cada apto.
Pets bem-vindos sem taxa.
Check-in a partir das 15h, com flexibilidade. Recepção presencial das 08h às 18h; das 18h às 08h, self check-in por cofre externo com senha.
Troca de roupa de cama inclusa acima de 7 diárias.
Pagamento: Pix ou cartão em até 3x. Parcelamento acima de 3x só com autorização do gerente. Desconto de 5% no Pix: só mencione se o lead pedir desconto, nunca ofereça antes.
Sinal de 30% após assinatura do contrato; os 70% restantes são pagos na chegada. Cancelamento: devolução integral até 5 dias antes do check-in, no mesmo dia do pedido.
TERMOS: use sempre "pré-reserva" até o contrato ser assinado e o sinal pago; só chame de "reserva" após pagamento confirmado.
Site: www.vilamundai.com.br
DATAS: sempre converta para AAAA-MM-DD (ex: "17 de junho" = "{{ano}}-06-17").`;

// Blocos (parágrafos) que SAEM da etapa porque já vivem em C1/C2/C5.
// Identificados pela primeira linha do parágrafo.
const PADROES_REMOVER = [
  /^Você é o Max/i,                      // identidade -> C1
  /^TOM:/i,                              // tom -> C1
  /^LEAD:\s*\{\{nome\}\}/i,              // dados do lead -> C5 (runtime)
  /^REGRA:\s*Após usar/i,                // pós-ferramenta -> C1
  /^REGRA GERAL:\s*Após usar/i,          // idem -> C1
  /^TERMOS:/i,                           // pré-reserva/reserva -> C2
  /^FATOS DA VILA/i,                     // fatos -> C2
  /^SOBRE A VILA/i,                      // fatos -> C2
  /^CONDIÇÕES DA RESERVA \(nunca invente/i,   // fatos de pagamento -> C2
  /^CONDIÇÕES DE PAGAMENTO \(nunca invente/i, // fatos de pagamento -> C2
];

// Extrai a C4 de um prompt de etapa: divide em parágrafos e filtra os blocos
// compartilhados. Retorna { c4, removidos } para auditoria.
export function extrairC4(promptBody) {
  const blocos = String(promptBody || '').split(/\n{2,}/);
  const mantidos = [];
  const removidos = [];
  for (const b of blocos) {
    const primeira = b.trim().split('\n')[0] || '';
    if (PADROES_REMOVER.some(re => re.test(primeira.trim()))) removidos.push(primeira.trim().slice(0, 80));
    else if (b.trim()) mantidos.push(b.trim());
  }
  return { c4: mantidos.join('\n\n'), removidos };
}

async function getCamada(chave) {
  const { rows } = await query(`SELECT conteudo, updated_at FROM lab_camadas WHERE chave = $1`, [chave]);
  return rows[0] || null;
}
async function setCamada(chave, conteudo) {
  await query(
    `INSERT INTO lab_camadas (chave, conteudo) VALUES ($1, $2)
     ON CONFLICT (chave) DO UPDATE SET conteudo = $2, updated_at = now()`,
    [chave, conteudo]
  );
}

// Seed idempotente: só grava chaves que ainda não existem (force=true sobrescreve
// C4s re-extraindo da produção atual; C1/C2 nunca são sobrescritas com force,
// para não perder edições do CEO).
export async function seedLab(force = false) {
  const relatorio = { criadas: [], puladas: [], extracao: {} };
  const existentes = new Set(
    (await query(`SELECT chave FROM lab_camadas`)).rows.map(r => r.chave)
  );

  const putIfNew = async (chave, conteudo) => {
    if (existentes.has(chave) && !force) { relatorio.puladas.push(chave); return; }
    if (existentes.has(chave) && force && (chave === 'c1_identidade' || chave === 'c2_fatos' || chave === 'c3_regras_draft')) {
      relatorio.puladas.push(chave + ' (protegida)'); return;
    }
    await setCamada(chave, conteudo);
    relatorio.criadas.push(chave);
  };

  await putIfNew('c1_identidade', C1_SEED);
  await putIfNew('c2_fatos', C2_SEED);
  await putIfNew('c3_regras_draft', REGRA_PRECO.trim());
  // c3_regras (publicada) NÃO é semeada: enquanto não existir, o runtime usa a
  // constante do código — produção segue idêntica até o CEO publicar.

  const stages = await AutomationStage.list();
  for (const st of stages) {
    if (!STAGES.includes(st.stage)) continue;
    const { c4, removidos } = extrairC4(st.prompt_body);
    relatorio.extracao[st.stage] = { blocos_removidos: removidos, tamanho_c4: c4.length, tamanho_original: (st.prompt_body || '').length };
    await putIfNew(`c4_${st.stage}`, c4);
  }
  return relatorio;
}

export async function getLab() {
  const { rows } = await query(`SELECT chave, conteudo, updated_at FROM lab_camadas`);
  const map = Object.fromEntries(rows.map(r => [r.chave, { conteudo: r.conteudo, updated_at: r.updated_at }]));
  return {
    c1: map['c1_identidade'] || null,
    c2: map['c2_fatos'] || null,
    c3_publicada: map['c3_regras'] || null,       // null = runtime usa a constante do código
    c3_draft: map['c3_regras_draft'] || null,
    c3_codigo: REGRA_PRECO.trim(),
    c4: Object.fromEntries(STAGES.map(s => [s, map[`c4_${s}`] || null])),
    seeded: !!map['c1_identidade'],
  };
}

export async function salvarCamada(chave, conteudo) {
  const validas = new Set(['c1_identidade', 'c2_fatos', 'c3_regras_draft', ...STAGES.map(s => `c4_${s}`)]);
  if (!validas.has(chave)) throw new Error(`chave inválida: ${chave}`);
  await setCamada(chave, conteudo || '');
  return { ok: true, chave };
}

// Ressincroniza o rascunho da C3 com a constante REGRA_PRECO do código.
// Útil quando as regras globais mudam no código (ex.: novas regras de condução):
// alinha o que o CEO vê/edita no Laboratório com o que de fato roda.
export async function resyncC3Draft() {
  await setCamada('c3_regras_draft', REGRA_PRECO.trim());
  return { ok: true, tamanho: REGRA_PRECO.trim().length };
}

// Publica a C3: rascunho -> produção (runtime passa a ler do banco).
export async function publicarC3() {
  const draft = await getCamada('c3_regras_draft');
  if (!draft || !draft.conteudo.trim()) throw new Error('rascunho da C3 vazio');
  const atual = await getCamada('c3_regras');
  if (atual?.conteudo) await AutomationStage.saveRevision('__c3_regras', atual.conteudo, 'edicao');
  await setCamada('c3_regras', draft.conteudo);
  return { ok: true };
}

// Compõe o prompt de cada etapa: C1 + C2 + C4 (a C3 é anexada pelo runtime,
// e C5/C6 são montadas por lead/turno — no preview entram como exemplo).
export async function compor() {
  const lab = await getLab();
  const stages = await AutomationStage.list();
  const byStage = Object.fromEntries(stages.map(s => [s.stage, s]));
  const exemploC5 = 'LEAD: {{nome}} | checkin: {{checkin}} | checkout: {{checkout}} | hóspedes: {{guests}}';
  const out = [];
  for (const s of STAGES) {
    if (!byStage[s]) continue;
    const partes = [lab.c1?.conteudo, lab.c2?.conteudo, exemploC5, lab.c4?.[s]?.conteudo].filter(Boolean);
    out.push({
      stage: s,
      nome: byStage[s].nome,
      composto: partes.join('\n\n'),
      producao: byStage[s].prompt_body || '',
      tem_c4: !!lab.c4?.[s]?.conteudo,
    });
  }
  return out;
}

// Envia a composição como RASCUNHO das 8 etapas (trilho existente:
// rascunho -> simulador -> promover). Produção intocada.
export async function enviarParaRascunhos() {
  const composicoes = await compor();
  const enviados = [];
  for (const c of composicoes) {
    if (!c.tem_c4) continue;
    await AutomationStage.saveDraft(c.stage, c.composto);
    enviados.push(c.stage);
  }
  return { ok: true, enviados };
}
