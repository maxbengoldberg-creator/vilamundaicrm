import { hospedin } from '../services/hospedin.service.js';
import { zapi } from '../services/zapi.service.js';
import * as Lead from '../models/lead.model.js';
import * as Reservation from '../models/reservation.model.js';

// ==========================================================
//  Executores das ferramentas. Cada handler recebe:
//    (input, ctx)  onde ctx = { lead, phone }
//  e retorna um objeto que será devolvido à Claude como
//  resultado da ferramenta (tool_result).
// ==========================================================

export const HANDLERS = {
  async consultar_disponibilidade(input) {
    const r = await hospedin.disponibilidade(input);
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
    for (const k of ['nome', 'checkin', 'checkout', 'guests', 'acomodacao']) {
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
    await Lead.update(ctx.lead.id, { stage: input.stage });
    return { ok: true, stage: input.stage };
  },

  async enviar_midia(input, ctx) {
    if (input.tipo === 'video') await zapi.sendVideo(ctx.phone, input.url, input.legenda || '');
    else await zapi.sendImage(ctx.phone, input.url, input.legenda || '');
    return { ok: true, enviado: input.tipo };
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
    const r = await hospedin.criarReserva({
      nome: ctx.lead.nome,
      phone: ctx.phone,
      email: ctx.lead.email,
      checkin: input.checkin,
      checkout: input.checkout,
      guests: input.guests,
      room_type_id: input.room_type_id,
      valor: input.valor,
    });
    if (r.ok) {
      await Reservation.create({
        lead_id: ctx.lead.id,
        pms_id: r.pms_id,
        checkin: input.checkin,
        checkout: input.checkout,
        guests: input.guests,
        acomodacao: ctx.lead.acomodacao,
        valor: input.valor,
        status: r.status,
        payload: r.raw,
      });
      await Lead.update(ctx.lead.id, { stage: 'reserva' });
    }
    return r;
  },

  async escalar_humano(input, ctx) {
    await Lead.update(ctx.lead.id, { ai_enabled: false });
    // Aqui você poderia notificar a equipe (Slack/e-mail). Stub:
    console.log(`[escalonamento] lead ${ctx.lead.id} -> humano. Motivo: ${input.motivo}`);
    return { ok: true, ia_pausada: true, motivo: input.motivo };
  },
};
