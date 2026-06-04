import { query } from '../config/db.js';

export async function create({ conversation_id, role, content = null, raw = null, sender = 'lead' }) {
  const { rows } = await query(
    `INSERT INTO messages (conversation_id, role, content, raw, sender)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [conversation_id, role, content, raw ? JSON.stringify(raw) : null, sender]
  );
  return rows[0];
}

// Retorna o histórico em ordem cronológica (para reconstruir o contexto).
export async function listByConversation(conversation_id) {
  const { rows } = await query(
    `SELECT role, content, raw, sender FROM messages
      WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [conversation_id]
  );
  // pg já desserializa JSONB; raw volta como objeto.
  return rows;
}
