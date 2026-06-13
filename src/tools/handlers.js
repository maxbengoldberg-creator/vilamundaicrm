import { hospedin } from '../services/hospedin.service.js';
import { zapi } from '../services/zapi.service.js';
import { query } from '../config/db.js';
import * as Lead from '../models/lead.model.js';
import * as Reservation from '../models/reservation.model.js';

// Sequência oficial do funil. O robô só pode avançar para a etapa imediatamente seguinte.
const STAGE_ORDER = ['qualif', 'apres', 'quente', 'negociacao', 'contrato', 'assinatura', 'pagamento', 'ganho'];

// Etapas em que a IA é desligada ao entrar (atendimento humano assume).
// contrato/assinatura = fase de contrato, conduzida pela equipe; ganho = fechado.
const DESLIGA_IA = ['contrato', 'assinatura', 'ganho'];

// Desvios (estacionamento): a próxima etapa ao retomar o lead.
// - morno: volta para negociacao (etapa após quente).
// - sem_datas: volta para qualif quando o lead trouxer datas (reengajamento).
const DESVIO_NEXT = { morno: 'negociacao', sem_datas: 'qualif' };

// De quais etapas o robô pode ESTACIONAR um lead em "sem_datas" (lead sem datas
// definidas, após no máximo 2 perguntas de data sem resposta).
const PODE_PARAR_SEM_DATAS = ['qualif', 'apres'];

// Mapa nome da acomodação -> place_type_id do Hospedin.
const PLACE_TYPE_IDS = {
  '1 Quarto - Térreo': 178135,
  '1 Quarto - Superior': 179290,
  '2 Quartos - Térreo': 179291,
  '2 Quartos - Superior': 178729,
};

// Preços por ocupação são configurados diretamente no PMS e variam por faixa
// de datas. Não usamos tabela hardcoded — o preço real vem de cotarNativo.

// Tag aplicada ao lead quando cada tipo de mídia é enviado, para o agente
// saber o que já mostrou e não repetir a oferta de fotos.
const TAG_POR_MIDIA = {
  'apto-1-quarto-terreo': 'imagens_1q_enviadas',
  'apto-1-quarto-superior': 'imagens_1q_enviadas',
  'apartamento-dois-quartos': 'imagens_2q_enviadas',
  'area-externa': 'imagens_area_externa_enviadas',
  'endereco': 'endereco_enviado',
};

function nextStage(current) {
  if (DESVIO_NEXT[current]) return DESVIO_NEXT[current];
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Pausa antes de confirmar a pré-reserva (parece mais natural, "estou registrando").
const DELAY_CONFIRMA_RESERVA_MS = 30000;

// ==========================================================
//  Executores das ferramentas. Cada handler recebe:
//    (input, ctx)  onde ctx = { lead, phone }
//  e retorna um objeto que será devolvido à Claude como
//  resultado da ferramenta (tool_result).
// ==========================================================

export const HANDLERS = {
  async consultar_disponibilidade(input, ctx) {
    // Tenta de novo em caso de instabilidade (até 3x) — o agente não deve
    // expor "erro" ao lead; quem resolve é o retry aqui.
    let r;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try { r = await hospedin.disponibilidade(input); }
      catch (e) { r = { ok: false, erro: e.message }; }
      if (r && r.ok) break;
      if (tentativa < 3) await delay(1500);
    }
    if (!r || !r.ok || !Array.isArray(r.disponiveis) || r.disponiveis.length === 0) return r || { ok: false };
    // Marca que o orçamento já foi consultado nesta conversa, para o agente não
    // oferecer "quer que eu veja os valores?" de novo (só reconsulta em mudança).
    if (ctx?.lead?.id) await Lead.addTags(ctx.lead.id, ['orcamento_apresentado']);
    // Busca o preço real de cada apto disponível em paralelo, criando pré-reservas
    // temporárias no PMS (canceladas imediatamente). Isso garante que o preço
    // já inclui a tarifa da faixa de datas + o desconto por ocupação configurado
    // pelo anfitrião no PMS — sem nenhuma tabela hardcoded no nosso código.
    const cotacoes = await Promise.all(
      r.disponiveis.map(d =>
        hospedin.cotarNativo({
          checkin: input.checkin,
          checkout: input.checkout,
          guests: input.guests,
          place_type_id: d.place_type_id,
          cancelar: true,
        }).catch(e => {
          console.error('[cotarNativo] falhou para', d.acomodacao, e.message);
          return { ok: false };
        })
      )
    );
    r.disponiveis = r.disponiveis.map((d, i) => {
      const c = cotacoes[i];
      if (!c.ok) return { ...d, noites: r.noites }; // fallback sem preço
      return {
        ...d,
        noites: r.noites,
        diaria: c.diaria_media,
        diaria_formatada: c.diaria_media.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        total_estadia: c.total,
        total_formatado: c.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      };
    });
    return r;
  },

  async cotar(input, ctx) {
    const noites = input.noites || 1;
    const total = Number(input.diaria) * noites;
    await Lead.update(ctx.lead.id, { valor_cotado: total, acomodacao: input.acomodacao });
    return {
      ok: true,
      acomodacao: input.acomodacao,
      noites,
      total,
      total_formatado: total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      cafe_incluso: !!input.cafe_incluso,
    };
  },

  async extrair_dados_lead(input, ctx) {
    const patch = {};
    for (const k of ['nome', 'checkin', 'checkout', 'guests', 'acomodacao', 'cpf', 'data_nascimento']) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') patch[k] = input[k];
    }
    await Lead.update(ctx.lead.id, patch);
    return { ok: true, salvo: patch };
  },

  async qualificar_lead(input, ctx) {
    await Lead.update(ctx.lead.id, {
      qual_score: input.score,
      ...(input.tags ? { tags: input.tags } : {}),
    });
    return { ok: true, score: input.score, tags: input.tags || [] };
  },

  async mover_funil(input, ctx) {
    const allowed = nextStage(ctx.lead.stage);
    // Estacionamento lateral: de qualif/apres o robô pode mover para "sem_datas"
    // (lead sem datas definidas) mesmo não sendo a próxima etapa linear.
    const podeParar = input.stage === 'sem_datas' && PODE_PARAR_SEM_DATAS.includes(ctx.lead.stage);
    if (input.stage !== allowed && !podeParar) {
      return {
        ok: false,
        erro: `Avanço bloqueado: de "${ctx.lead.stage}" o próximo permitido é "${allowed}", não "${input.stage}". O robô só avança uma etapa por vez.`,
      };
    }
    // Contrato/assinatura/ganho = atendimento humano: a IA desliga junto (a
    // resposta final desta rodada ainda sai; da próxima mensagem o humano assume).
    const patch = { stage: input.stage };
    const desliga = DESLIGA_IA.includes(input.stage);
    if (desliga) patch.ai_enabled = false;
    await Lead.update(ctx.lead.id, patch);
    return { ok: true, stage: input.stage, ...(desliga ? { ia_pausada: true } : {}) };
  },

  async enviar_midia(input, ctx) {
    const { rows } = await query(
      `SELECT url, public_id FROM fotos WHERE tipo_apto = $1 ORDER BY ordem ASC NULLS LAST, created_at ASC`,
      [input.tipo_apto]
    );
    if (rows.length === 0) {
      return { ok: false, erro: `Nenhuma foto encontrada para tipo_apto "${input.tipo_apto}". Sincronize as fotos via /api/v1/fotos/sync.` };
    }
    for (const foto of rows) {
      const isVideo = /\.(mp4|mov|avi|webm)$/i.test(foto.url);
      if (isVideo) await zapi.sendVideo(ctx.phone, foto.url, '');
      else await zapi.sendImage(ctx.phone, foto.url, '');
    }
    // Marca no lead o que já foi enviado, para o agente não oferecer/perguntar de novo.
    const tag = TAG_POR_MIDIA[input.tipo_apto];
    if (tag && ctx.lead?.id) await Lead.addTags(ctx.lead.id, [tag]);
    return { ok: true, enviadas: rows.length, tipo_apto: input.tipo_apto };
  },

  async gerar_link_pagamento(input) {
    // Stub: integre aqui seu gateway (Pix/cartão). Por ora gera um link de exemplo.
    const ref = Math.random().toString(36).slice(2, 10);
    const link = `https://pagamento.vilamundai.com.br/checkout/${ref}`;
    return {
      ok: true,
      link,
      valor: input.valor,
      valor_formatado: Number(input.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    };
  },

  async criar_reserva(input, ctx) {
    // Ficha fresca: nome/acomodação podem ter sido salvos na mesma rodada.
    const lead = (await Lead.findById(ctx.lead.id)) || ctx.lead;
    const tipo_apto = input.tipo_apto || lead.acomodacao;
    const place_type_id = PLACE_TYPE_IDS[tipo_apto];
    if (!place_type_id) {
      return { ok: false, erro: `Tipo de apartamento inválido: "${tipo_apto}". Use a acomodação exata da consulta de disponibilidade.` };
    }
    // Trava: a reserva tem que sair na acomodação que o lead escolheu (ficha).
    if (lead.acomodacao && tipo_apto !== lead.acomodacao) {
      return {
        ok: false,
        erro: `Bloqueado: a ficha do lead diz que ele escolheu "${lead.acomodacao}", mas você pediu "${tipo_apto}". Crie a reserva na acomodação escolhida pelo lead, ou atualize a ficha com extrair_dados_lead se ele mudou de escolha.`,
      };
    }
    // Não passamos diaria — o PMS precifica sozinho com a tarifa da faixa
    // de datas e o desconto por ocupação configurado pelo anfitrião.
    const r = await hospedin.criarReserva({
      nome: lead.nome,
      checkin: input.checkin,
      checkout: input.checkout,
      guests: input.guests,
      place_type_id,
    });
    if (r.ok) {
      await Lead.update(ctx.lead.id, { valor_cotado: r.valor_total });
      await Reservation.create({
        lead_id: ctx.lead.id,
        pms_id: r.pms_id,
        checkin: input.checkin,
        checkout: input.checkout,
        guests: input.guests,
        acomodacao: tipo_apto,
        valor: r.valor_total,
        status: r.status,
        payload: r.raw,
      });
      // Pausa antes de a confirmação chegar ao lead (não parecer instantâneo).
      await delay(DELAY_CONFIRMA_RESERVA_MS);
    }
    return r;
  },

  async salvar_condicoes(input, ctx) {
    const condicoes = {
      forma_pagamento: input.forma_pagamento,
      parcelas: input.parcelas,
      desconto_pix: input.desconto_pix,
      valor_total: input.valor_total,
      valor_sinal: input.valor_sinal,
      ...(input.data_sinal ? { data_sinal: input.data_sinal } : {}),
      ...(input.observacoes ? { observacoes: input.observacoes } : {}),
    };
    await Lead.update(ctx.lead.id, { condicoes_pagamento: condicoes });
    return { ok: true, salvo: condicoes };
  },

  async escalar_humano(input, ctx) {
    // Guarda o motivo no lead para o operador ver na ficha do Atendimentos.
    const lead = (await Lead.findById(ctx.lead.id)) || ctx.lead;
    const extra = { ...(lead.extra || {}), escalado_motivo: input.motivo, escalado_at: new Date().toISOString() };
    await Lead.update(ctx.lead.id, { ai_enabled: false, extra: JSON.stringify(extra) });
    console.log(`[escalonamento] lead ${ctx.lead.id} -> humano. Motivo: ${input.motivo}`);
    return { ok: true, ia_pausada: true, motivo: input.motivo };
  },
};
