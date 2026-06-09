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
      const resultados = [];
      for (const pt of PLACE_TYPES) {
        if (guests && pt.occupants < Number(guests)) continue;
        const { data } = await axios.get(
          `${BASE}/${ACCOUNT_ID}/place_types/${pt.id}/rates_and_availabilities`,
          { headers: h, params: { start_date: checkin, end_date: checkout } }
        );
        const disponivel = data.some(d => d.availability > 0);
        if (!disponivel) continue;
        const diaria = (data[0]?.rate_price || 0) / 100;
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
      return { ok: true, disponiveis: resultados };
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

  async criarReserva({ nome, checkin, checkout, guests, place_type_id, place_id, diaria }) {
    try {
      const h = await authHeaders();
      const guest = await hospedin.criarGuest(nome || 'Hóspede Vila Mundaí');
      const noites = Math.round((new Date(checkout) - new Date(checkin)) / (1000*60*60*24));
      const daily_cents = Math.round((diaria || 100) * 100);
      const total_daily_cents = daily_cents * noites;
      const pt = PLACE_TYPES.find(p => p.id === place_type_id) || PLACE_TYPES[0];
      const { data } = await axios.post(
        `${BASE}/${ACCOUNT_ID}/reservations`,
        {
          sale_channel_id: SALE_CHANNEL_ID,
          place_type_id: pt.id,
          place_id: place_id || pt.places[0],
          status: 'pre_reservation',
          check_in: checkin,
          check_out: checkout,
          daily_cents,
          total_daily_cents,
          adults: Number(guests) || 2,
          children: 0,
          exempt: false,
          guest_id: guest.id,
          has_breakfast: false,
        },
        { headers: h }
      );
      return { ok: true, pms_id: data.id, codigo: data.searchable_code, status: data.status, raw: data };
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
