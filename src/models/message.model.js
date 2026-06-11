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
    `SELECT role, content, raw, sender, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
    [conversation_id]
  );
  // pg já desserializa JSONB; raw volta como objeto.
  return rows;
}

// Mensagens para o PAINEL do operador: sem os registros internos do agente
// (placeholders "[ferramentas]" e textos vazios de rodadas de tool_use).
export async function listForPanel(conversation_id) {
  const { rows } = await query(
    `SELECT role, content, sender, created_at FROM messages
      WHERE conversation_id = $1
        AND content IS NOT NULL AND btrim(content) <> '' AND content <> '[ferramentas]'
      ORDER BY created_at ASC, id ASC`,
    [conversation_id]
  );
  return rows;
}

export async function countByConversation(conversation_id) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE conversation_id = $1
        AND content IS NOT NULL AND btrim(content) <> '' AND content <> '[ferramentas]'`,
    [conversation_id]
  );
  return rows[0]?.n || 0;
}

// Já existe mensagem com este conteúdo nesta conversa nos últimos `segundos`?
// Usado para deduplicar ecos de mensagens fromMe (IA/CRM já gravaram).
export async function existsRecentByContent(conversation_id, content, segundos = 120) {
  const { rows } = await query(
    `SELECT 1 FROM messages
      WHERE conversation_id = $1 AND content = $2
        AND created_at > now() - ($3 || ' seconds')::interval
      LIMIT 1`,
    [conversation_id, content, String(segundos)]
  );
  return rows.length > 0;
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
