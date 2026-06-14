import { query } from '../config/db.js';

export async function findOpenByPhone(phone) {
  const { rows } = await query(
    `SELECT * FROM conversations WHERE phone = $1 AND status = 'aberta' ORDER BY id DESC LIMIT 1`,
    [phone]
  );
  return rows[0] || null;
}

// Conversa aberta de um lead (independente da forma do telefone) — usada para
// consolidar a conversa quando o número chega com/sem o 9º dígito.
export async function findOpenByLead(leadId) {
  if (!leadId) return null;
  const { rows } = await query(
    `SELECT * FROM conversations WHERE lead_id = $1 AND status = 'aberta' ORDER BY id DESC LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

export async function create({ lead_id, phone }) {
  const { rows } = await query(
    `INSERT INTO conversations (lead_id, phone) VALUES ($1,$2) RETURNING *`,
    [lead_id, phone]
  );
  return rows[0];
}

export async function touch(id, lastMessage) {
  await query(
    `UPDATE conversations SET last_message = $2, last_at = now() WHERE id = $1`,
    [id, lastMessage?.slice(0, 500) || null]
  );
}

export async function finish(id) {
  await query(`UPDATE conversations SET status = 'finalizada' WHERE id = $1`, [id]);
}

// Lista para o painel de Atendimentos: traz a ficha do lead junto
// (etapa, datas, hóspedes, valor, tags) e o contador de não lidas.
export async function list() {
  const { rows } = await query(
    `SELECT c.*, l.nome, l.stage, l.ai_enabled, l.checkin, l.checkout, l.guests,
            l.valor_cotado, l.tags, l.extra, l.qual_score,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.conversation_id = c.id AND m.sender = 'lead'
                AND m.created_at > COALESCE(c.last_read_at, 'epoch'::timestamptz)) AS unread
       FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
      ORDER BY c.last_at DESC LIMIT 100`
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query(
    `SELECT c.*, l.nome, l.stage, l.checkin, l.checkout, l.guests, l.valor_cotado, l.tags
       FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Marca a conversa como lida pelo operador (zera o contador de não lidas).
export async function markRead(id) {
  await query(`UPDATE conversations SET last_read_at = now() WHERE id = $1`, [id]);
}

// Salva o resumo gerado pela IA e a estimativa de conversão.
export async function saveResumo(id, { resumo, conversao, conversao_pct, resumo_msgs }) {
  await query(
    `UPDATE conversations
        SET resumo = $2, conversao = $3, conversao_pct = $4, resumo_msgs = $5, resumo_at = now()
      WHERE id = $1`,
    [id, resumo, conversao, conversao_pct, resumo_msgs]
  );
}
