import axios from 'axios';
import { env } from '../config/env.js';

// ==========================================================
//  Integração com o PMS Hospedin
//  Doc: https://pms.hospedin.com/api-docs  (aba "authentication")
//
//  IMPORTANTE: confira na doc os caminhos e nomes de campos exatos.
//  Deixei os endpoints mais prováveis + comentários indicando o que
//  ajustar. Tudo passa por aqui, então é o ÚNICO arquivo a editar
//  caso a doc use rotas/nomes diferentes.
// ==========================================================

let cachedToken = null;
let tokenExpiresAt = 0;

const client = axios.create({
  baseURL: env.hospedin.baseUrl,
  timeout: 15000,
});

// Obtém (e cacheia) o token de autenticação.
async function getToken() {
  // Caso 1: conta usa um token fixo de API.
  if (env.hospedin.apiToken) return env.hospedin.apiToken;

  // Caso 2: login por e-mail/senha (ver aba authentication da doc).
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  try {
    // >>> AJUSTE conforme a doc: rota e corpo do login <<<
    const { data } = await client.post('/auth/sign_in', {
      email: env.hospedin.email,
      password: env.hospedin.password,
    });
    // O token pode vir no corpo ou em headers (access-token). Cobrimos os dois:
    cachedToken =
      data?.token || data?.access_token || data?.auth?.token || null;
    tokenExpiresAt = now + 50 * 60 * 1000; // ~50 min
    if (!cachedToken) throw new Error('token não encontrado na resposta de login');
    return cachedToken;
  } catch (err) {
    console.error('[hospedin] falha no login:', err.response?.data || err.message);
    throw err;
  }
}

async function authedHeaders() {
  const token = await getToken();
  return { Authorization: `Bearer ${token}` };
}

export const hospedin = {
  // Verifica disponibilidade para um período.
  // Retorna lista de acomodações disponíveis com tarifa.
  async disponibilidade({ checkin, checkout, guests }) {
    const headers = await authedHeaders();
    try {
      // >>> AJUSTE: rota e nomes de parâmetros conforme a doc <<<
      const { data } = await client.get('/availabilities', {
        headers,
        params: { check_in: checkin, check_out: checkout, guests },
      });
      // Normaliza para um formato simples que o agente entende.
      const lista = (data?.availabilities || data?.data || data || []).map((a) => ({
        acomodacao: a.room_type_name || a.name || a.accommodation,
        room_type_id: a.room_type_id || a.id,
        disponivel: a.available ?? true,
        diaria: Number(a.rate || a.price || a.daily_rate || 0),
      }));
      return { ok: true, disponiveis: lista.filter((x) => x.disponivel) };
    } catch (err) {
      console.error('[hospedin] disponibilidade:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível consultar a disponibilidade agora.' };
    }
  },

  // Cria uma reserva no PMS.
  async criarReserva({ nome, phone, email, checkin, checkout, guests, room_type_id, valor }) {
    const headers = await authedHeaders();
    try {
      // >>> AJUSTE: rota e corpo conforme a doc <<<
      const { data } = await client.post(
        '/reservations',
        {
          guest: { name: nome, phone, email },
          check_in: checkin,
          check_out: checkout,
          guests,
          room_type_id,
          total: valor,
          status: 'pending',
        },
        { headers }
      );
      return {
        ok: true,
        pms_id: data?.id || data?.reservation?.id,
        status: data?.status || 'pendente',
        raw: data,
      };
    } catch (err) {
      console.error('[hospedin] criarReserva:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível criar a reserva no PMS.' };
    }
  },

  // Confirma uma reserva (após pagamento).
  async confirmarReserva(pms_id) {
    const headers = await authedHeaders();
    try {
      const { data } = await client.patch(
        `/reservations/${pms_id}`,
        { status: 'confirmed' },
        { headers }
      );
      return { ok: true, raw: data };
    } catch (err) {
      console.error('[hospedin] confirmarReserva:', err.response?.data || err.message);
      return { ok: false, erro: 'Não foi possível confirmar a reserva.' };
    }
  },
};
