import { query } from '../config/db.js';

export async function findOpenByPhone(phone) {
  const { rows } = await query(
    `SELECT * FROM conversations WHERE phone = $1 AND status = 'aberta' ORDER BY id DESC LIMIT 1`,
    [phone]
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

export async function list() {
  const { rows } = await query(
    `SELECT c.*, l.nome, l.stage, l.ai_enabled
       FROM conversations c LEFT JOIN leads l ON l.id = c.lead_id
      ORDER BY c.last_at DESC LIMIT 100`
  );
  return rows;
}
