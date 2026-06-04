import axios from 'axios';
import { env } from '../config/env.js';

const ACCOUNT_ID = 'vila-mundai';
const BASE = 'https://pms-api.hospedin.com/api/v2';

const PLACE_TYPES = [
  { id: 178135, nome: '1 Quarto - Térreo',   occupants: 5 },
  { id: 179290, nome: '1 Quarto - Superior',  occupants: 5 },
  { id: 179291, nome: '2 Quartos - Térreo',   occupants: 7 },
  { id: 178729, nome: '2 Quartos - Superior', occupants: 7 },
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

async function headers() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
}

export const hospedin = {
  async categorias() {
    return PLACE_TYPES;
  },

  async disponibilidade({ checkin, checkout, guests }) {
    try {
      const h = await headers();
      const resultados = [];
      for (const pt of PLACE_TYPES) {
        if (guests && pt.occupants < guests) continue;
        const { data } = await axios.get(
          `${BASE}/${ACCOUNT_ID}/place_types/${pt.id}/rates_and_availabilities`,
          { headers: h, params: { start_date: checkin, end_date: checkout } }
        );
        const diasDisponiveis = data.filter(d => d.availability > 0);
        if (diasDisponiveis.length === 0) continue;
        const diaria = diasDisponiveis[0].rate_price / 100;
        resultados.push({
          place_type_id: pt.id,
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

  async criarReserva({ nome, phone, email, checkin, checkout, guests, room_type_id, valor }) {
    try {
      const h = await headers();
      const { data } = await axios.post(
        `${BASE}/${ACCOUNT_ID}/reservations`,
        {
          reservation: {
            place_type_id: room_type_id,
            check_in: checkin,
            check_out: checkout,
            guests_number: guests,
            total: valor * 100,
            status: 'reserved',
          },
          guest: { name: nome, phone, email },
        },
        { headers: h }
      );
      return { ok: true, pms_id: data?.id, status: data?.status, raw: data };
    } catch (err) {
      console.error('[hospedin] criarReserva:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível criar a reserva.' };
    }
  },
};
