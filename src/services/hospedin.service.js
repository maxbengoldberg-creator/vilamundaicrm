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
      console.error('[hospedin] criarReserva:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível criar a reserva no PMS.' };
    }
  },
};
