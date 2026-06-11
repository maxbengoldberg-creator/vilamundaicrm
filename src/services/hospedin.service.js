import axios from 'axios';
import { env } from '../config/env.js';

const ACCOUNT_ID = 'vila-mundai';
const BASE = 'https://pms-api.hospedin.com/api/v2';
const SALE_CHANNEL_ID = 269875;

const PLACE_TYPES = [
  { id: 178135, nome: '1 Quarto - Térreo',   occupants: 5, places: [514933,514935,514943,514945] },
  { id: 179290, nome: '1 Quarto - Superior',  occupants: 5, places: [514934,514936,514944,514946] },
  { id: 179291, nome: '2 Quartos - Térreo',   occupants: 7, places: [514937,514939,514941] },
  { id: 178729, nome: '2 Quartos - Superior', occupants: 7, places: [514938,514940,514942] },
];

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;
  const { data } = await axios.post(`${BASE}/authentication/sessions`, {
    email: env.hospedin.email,
    password: env.hospedin.password,
  });
  cachedToken = data.token;
  tokenExpiresAt = now + 4 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function authHeaders() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' };
}

export const hospedin = {
  async categorias() {
    return PLACE_TYPES.map(p => ({ id: p.id, nome: p.nome, occupants: p.occupants }));
  },

  async disponibilidade({ checkin, checkout, guests }) {
    try {
      const h = await authHeaders();
      const noites = Math.round((new Date(checkout) - new Date(checkin)) / (1000 * 60 * 60 * 24));
      if (!noites || noites < 1) return { ok: false, erro: 'Período inválido (checkout deve ser depois do checkin).' };
      const resultados = [];
      for (const pt of PLACE_TYPES) {
        if (guests && pt.occupants < Number(guests)) continue;
        const { data } = await axios.get(
          `${BASE}/${ACCOUNT_ID}/place_types/${pt.id}/rates_and_availabilities`,
          { headers: h, params: { start_date: checkin, end_date: checkout } }
        );
        // Só as noites da estadia: a data do checkout não é cobrada.
        const dias = data.filter(d => d.date >= checkin && d.date < checkout);
        if (dias.length === 0) continue;
        // TODAS as noites precisam ter vaga, não apenas alguma.
        if (!dias.every(d => d.availability > 0)) continue;
        // A tarifa pode variar por noite no calendário do PMS: soma as noites
        // e usa a diária média, para o total bater com o calendário.
        let totalBase = dias.reduce((a, d) => a + (d.rate_price || 0), 0) / 100;
        if (dias.length !== noites) totalBase = (totalBase / dias.length) * noites;
        const diaria = Math.round((totalBase / noites) * 100) / 100;
        resultados.push({
          place_type_id: pt.id,
          place_id: pt.places[0],
          acomodacao: pt.nome,
          occupants: pt.occupants,
          disponivel: true,
          diaria,
          diaria_formatada: diaria.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
        });
      }
      return { ok: true, noites, disponiveis: resultados };
    } catch (err) {
      console.error('[hospedin] disponibilidade:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível consultar a disponibilidade.' };
    }
  },

  async criarGuest(nome) {
    const h = await authHeaders();
    const { data } = await axios.post(`${BASE}/${ACCOUNT_ID}/guests`, { name: nome }, { headers: h });
    return data;
  },

  async criarReserva({ nome, checkin, checkout, guests, place_type_id, place_id }) {
    try {
      const h = await authHeaders();
      const guest = await hospedin.criarGuest(nome || 'Hóspede Vila Mundaí');
      const noites = Math.round((new Date(checkout) - new Date(checkin)) / (1000*60*60*24));
      // Não enviamos daily_cents — o PMS precifica sozinho usando a tarifa base
      // da faixa de datas + os descontos por ocupação configurados nele.
      const nota = `Reserva criada pelo agente IA: ${guests} hóspedes, ${noites} noites.`;
      const pt = PLACE_TYPES.find(p => p.id === place_type_id) || PLACE_TYPES[0];

      // A disponibilidade é verificada por TIPO, mas a reserva exige uma unidade
      // (place_id) específica. Tenta cada unidade do tipo até achar uma livre —
      // o PMS recusa com "UH já está em uso" as que estão ocupadas no período.
      const candidatos = place_id ? [place_id] : pt.places;
      let ultimoErro = null;

      for (const pid of candidatos) {
        try {
          const { data } = await axios.post(
            `${BASE}/${ACCOUNT_ID}/reservations`,
            {
              sale_channel_id: SALE_CHANNEL_ID,
              place_type_id: pt.id,
              place_id: pid,
              status: 'pre_reservation',
              check_in: checkin,
              check_out: checkout,
              adults: Number(guests) || 2,
              children: 0,
              exempt: 0,
              guest_id: guest.id,
              has_breakfast: false,
              note: nota,
            },
            { headers: h }
          );
          const totalPms = (data.total_amount || 0) / 100;
          const diaria_media = noites ? Math.round((totalPms / noites) * 100) / 100 : null;
          console.log(`[hospedin] reserva ${data.id} criada. total_pms=R$${totalPms} guests=${guests}`);
          return {
            ok: true,
            pms_id: data.id,
            codigo: data.searchable_code,
            status: data.status,
            place_id: pid,
            valor_total: totalPms,
            diaria_media,
            raw: data,
          };
        } catch (err) {
          ultimoErro = err.response?.data || err.message;
          const msg = JSON.stringify(ultimoErro);
          // "UH já está em uso" → tenta a próxima unidade; outro erro → aborta.
          if (/em uso/i.test(msg)) {
            console.warn(`[hospedin] unidade ${pid} ocupada no período, tentando próxima`);
            continue;
          }
          throw err;
        }
      }

      console.error('[hospedin] criarReserva: todas as unidades ocupadas/erro:', JSON.stringify(ultimoErro));
      return { ok: false, erro: 'Nenhuma unidade desse tipo está livre para o período no PMS.', detalhe: ultimoErro };
    } catch (err) {
      const detalhe = err.response?.data || err.message;
      console.error('[hospedin] criarReserva:', JSON.stringify(detalhe));
      return { ok: false, erro: 'Não foi possível criar a reserva no PMS.', detalhe };
    }
  },
};

// ===== BOAS-VINDAS / CHEGADAS =====
const CANAL_MAP = { 177874: 'Airbnb', 171931: 'Booking.com', 269875: 'Chat IA' };

function extrairTelefone(...textos) {
  for (const t of textos) {
    if (!t) continue;
    const m = String(t).match(/\b(55\d{10,11}|\d{2}9?\d{8})\b/);
    if (m) {
      let num = m[1].replace(/\D/g, '');
      if (!num.startsWith('55')) num = '55' + num;
      return num;
    }
  }
  return null;
}

// Cria pré-reserva SEM enviar valor para o PMS calcular sozinho
// (tarifa base da faixa + desconto por ocupação configurado no PMS).
// Cancela uma reserva no PMS (usada após cotação temporária).
hospedin.cancelarReserva = async function (id) {
  try {
    const h = await authHeaders();
    await axios.patch(`${BASE}/${ACCOUNT_ID}/reservations/${id}`, { status: 'canceled' }, { headers: h });
    return { ok: true };
  } catch (err) {
    console.warn(`[hospedin] cancelarReserva ${id}:`, err.response?.data || err.message);
    return { ok: false };
  }
};

// Cria pré-reserva SEM enviar valor para o PMS precificar sozinho
// (tarifa base da faixa + desconto por ocupação configurado no PMS).
// Se cancelar=true, cancela a reserva logo após ler o preço (usado na cotação).
hospedin.cotarNativo = async function ({ checkin, checkout, guests, place_type_id, nome, cancelar = false }) {
  const h = await authHeaders();
  const guest = await hospedin.criarGuest(nome || 'Cotação CRM');
  const pt = PLACE_TYPES.find(p => p.id === Number(place_type_id));
  if (!pt) return { ok: false, erro: `place_type_id inválido: ${place_type_id}` };
  let ultimoErro = null;
  for (const pid of pt.places) {
    try {
      const { data } = await axios.post(
        `${BASE}/${ACCOUNT_ID}/reservations`,
        {
          sale_channel_id: SALE_CHANNEL_ID,
          place_type_id: pt.id,
          place_id: pid,
          status: 'pre_reservation',
          check_in: checkin,
          check_out: checkout,
          adults: Number(guests) || 2,
          children: 0,
          exempt: 0,
          guest_id: guest.id,
          has_breakfast: false,
          note: cancelar
            ? `Cotação temporária CRM: ${guests} hóspedes — será cancelada.`
            : `Reserva criada pelo agente IA: ${guests} hóspedes.`,
        },
        { headers: h }
      );
      const noites = Math.round((new Date(checkout) - new Date(checkin)) / 86400000);
      const total = (data.total_amount || 0) / 100;
      const diaria_media = noites ? Math.round((total / noites) * 100) / 100 : null;
      console.log(`[hospedin] cotarNativo: reserva ${data.id} total=R$${total} guests=${guests} cancelar=${cancelar}`);
      if (cancelar) await hospedin.cancelarReserva(data.id);
      return { ok: true, pms_id: data.id, codigo: data.searchable_code, acomodacao: pt.nome, place_id: pid, noites, total, diaria_media };
    } catch (err) {
      ultimoErro = err.response?.data || err.message;
      if (/em uso/i.test(JSON.stringify(ultimoErro))) { continue; }
      throw err;
    }
  }
  return { ok: false, erro: 'Nenhuma unidade livre no período.', detalhe: ultimoErro };
};

hospedin.chegadas = async function ({ start_date, end_date }) {
  const h = await authHeaders();
  const encontrados = [];
  for (let page = 1; page <= 38; page++) {
    const { data } = await axios.get(`${BASE}/${ACCOUNT_ID}/reservations`, {
      headers: h, params: { limit: 20, page },
    });
    const lista = data.data || [];
    if (!lista.length) break;
    for (const r of lista) {
      if (r.status !== 'reservation') continue;
      const ci = r.check_in.slice(0, 10);
      if (ci < start_date || ci > end_date) continue;
      encontrados.push(r);
    }
    if (data.pagination && page >= data.pagination.last) break;
  }

  const clientes = [];
  for (const r of encontrados) {
    const full = await axios.get(`${BASE}/${ACCOUNT_ID}/reservations/${r.id}`, { headers: h }).then(x => x.data).catch(() => null);
    if (!full) continue;
    let nome = 'Hóspede', guestNote = null, guestPhone = null, email = null;
    if (full.guest_id) {
      const g = await axios.get(`${BASE}/${ACCOUNT_ID}/guests/${full.guest_id}`, { headers: h }).then(x => x.data).catch(() => null);
      if (g) { nome = g.name || nome; guestNote = g.note; email = g.email || null; guestPhone = g.phone || null; }
    }
    const phone = extrairTelefone(guestPhone, full.note, guestNote);
    const ci = new Date(full.check_in), co = new Date(full.check_out);
    const noites = Math.round((co - ci) / (1000*60*60*24));
    const canal = CANAL_MAP[full.sale_channel_id] || 'Direto';
    const pt = PLACE_TYPES.find(p => p.id === full.place_type_id);
    clientes.push({
      pms_reservation_id: full.id,
      pms_guest_id: full.guest_id,
      nome, phone, email, canal,
      qualificacao: canal === 'Airbnb' ? 'Cliente Airbnb' : canal === 'Booking.com' ? 'Cliente Booking' : 'Cliente Direto',
      check_in: full.check_in.slice(0,10),
      check_out: full.check_out.slice(0,10),
      noites,
      pessoas: (full.adults || 0) + (full.children || 0),
      receita_cents: full.total_amount || full.total_daily_cents || 0,
      acomodacao: pt ? pt.nome : null,
      status_reserva: full.status,
      note: full.note || null,
    });
  }
  return clientes;
};
