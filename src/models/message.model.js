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

// Janela de contexto: últimas N mensagens em ordem cronológica (economia de tokens)
export async function listRecent(conversation_id, limit = 20) {
  const { rows } = await query(
    `SELECT role, content, raw, sender FROM (
       SELECT role, content, raw, sender, created_at, id FROM messages
         WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
     ) sub ORDER BY created_at ASC, id ASC`,
    [conversation_id, limit]
  );
  return rows;
}
