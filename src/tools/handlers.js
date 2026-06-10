import { hospedin } from '../services/hospedin.service.js';
import { zapi } from '../services/zapi.service.js';
import { query } from '../config/db.js';
import * as Lead from '../models/lead.model.js';
import * as Reservation from '../models/reservation.model.js';

// Sequência oficial do funil. O robô só pode avançar para a etapa imediatamente seguinte.
const STAGE_ORDER = ['qualif', 'apres', 'quente', 'negociacao', 'contrato', 'pagamento', 'ganho'];

// De morno, o lead volta para negociacao (etapa após quente).
const MORNO_NEXT = 'negociacao';

// Mapa nome da acomodação -> place_type_id do Hospedin.
const PLACE_TYPE_IDS = {
  '1 Quarto - Térreo': 178135,
  '1 Quarto - Superior': 179290,
  '2 Quartos - Térreo': 179291,
  '2 Quartos - Superior': 178729,
};

// Desconto na diária por número de hóspedes, por tipo de apto.
// O preço do PMS é o cheio (ocupação máxima); aqui ajustamos para menos pessoas.
// A diária retornada ao agente já sai corrigida — é ela que vai ao lead e ao PMS.
const DESCONTO_POR_HOSPEDES = {
  178135: { 4: 40, 3: 70, 2: 120 }, // 1 Quarto - Térreo (cheio = 5 pessoas)
};

function aplicarDescontoHospedes(disponiveis, guests) {
  const g = Number(guests);
  if (!g) return disponiveis;
  return disponiveis.map(d => {
    const tabela = DESCONTO_POR_HOSPEDES[d.place_type_id];
    if (!tabela) return d;
    // 1 hóspede paga como 2; acima do teto da tabela paga o preço cheio.
    const desconto = tabela[Math.max(g, 2)] || 0;
    if (!desconto) return d;
    const diaria = Math.max(d.diaria - desconto, 0);
    return {
      ...d,
      diaria,
      diaria_formatada: diaria.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    };
  });
}

function nextStage(current) {
  if (current === 'morno') return MORNO_NEXT;
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

// ==========================================================
//  Executores das ferramentas. Cada handler recebe:
//    (input, ctx)  onde ctx = { lead, phone }
//  e retorna um objeto que será devolvido à Claude como
//  resultado da ferramenta (tool_result).
// ==========================================================

export const HANDLERS = {
  async consultar_disponibilidade(input) {
    const r = await hospedin.disponibilidade(input);
    if (r.ok && Array.isArray(r.disponiveis)) {
      r.disponiveis = aplicarDescontoHospedes(r.disponiveis, input.guests);
    }
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
    if (input.stage !== allowed) {
      return {
        ok: false,
        erro: `Avanço bloqueado: de "${ctx.lead.stage}" o próximo permitido é "${allowed}", não "${input.stage}". O robô só avança uma etapa por vez.`,
      };
    }
    await Lead.update(ctx.lead.id, { stage: input.stage });
    return { ok: true, stage: input.stage };
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
    const tipo_apto = input.tipo_apto || ctx.lead.acomodacao;
    const place_type_id = PLACE_TYPE_IDS[tipo_apto];
    if (!place_type_id) {
      return { ok: false, erro: `Tipo de apartamento inválido: "${tipo_apto}". Use a acomodação exata da consulta de disponibilidade.` };
    }
    const r = await hospedin.criarReserva({
      nome: ctx.lead.nome,
      checkin: input.checkin,
      checkout: input.checkout,
      guests: input.guests,
      place_type_id,
      diaria: input.valor,
    });
    if (r.ok) {
      await Reservation.create({
        lead_id: ctx.lead.id,
        pms_id: r.pms_id,
        checkin: input.checkin,
        checkout: input.checkout,
        guests: input.guests,
        acomodacao: tipo_apto,
        valor: input.valor,
        status: r.status,
        payload: r.raw,
      });
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
    await Lead.update(ctx.lead.id, { ai_enabled: false });
    // Aqui você poderia notificar a equipe (Slack/e-mail). Stub:
    console.log(`[escalonamento] lead ${ctx.lead.id} -> humano. Motivo: ${input.motivo}`);
    return { ok: true, ia_pausada: true, motivo: input.motivo };
  },
};
