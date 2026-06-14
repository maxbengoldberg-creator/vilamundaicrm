import { query } from '../config/db.js';

export async function findByPhone(phone) {
  const { rows } = await query('SELECT * FROM leads WHERE phone = $1', [phone]);
  return rows[0] || null;
}

// Formas equivalentes de um número BR para o 9º dígito: o WhatsApp entrega ora
// com 13 dígitos (55 + DD + 9 + 8) ora com 12 (sem o 9). Devolve as duas formas
// para casar a mesma pessoa, sem mexer no número usado para enviar.
export function formasPhoneBR(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return [String(phone || '')];
  if (p.startsWith('55') && p.length === 13 && p[4] === '9') {
    return [p, p.slice(0, 4) + p.slice(5)];           // com 9  -> também sem 9
  }
  if (p.startsWith('55') && p.length === 12 && /[6-9]/.test(p[4])) {
    return [p, p.slice(0, 4) + '9' + p.slice(4)];      // sem 9 (celular) -> também com 9
  }
  return [p];
}

// Acha o lead por qualquer forma do número (com/sem 9º dígito). @lid não entra
// aqui (resolvido antes). Retorna o mais antigo (canônico) quando há mais de um.
export async function findByPhoneFlex(phone) {
  if (!phone) return null;
  if (String(phone).includes('@')) return findByPhone(phone);
  const formas = formasPhoneBR(phone);
  const { rows } = await query(
    'SELECT * FROM leads WHERE phone = ANY($1::text[]) ORDER BY id ASC LIMIT 1', [formas]
  );
  return rows[0] || null;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [id]);
  return rows[0] || null;
}

// Acha o lead pelo LID (identificador de privacidade do WhatsApp, só dígitos).
export async function findByLid(lid) {
  if (!lid) return null;
  const { rows } = await query('SELECT * FROM leads WHERE lid = $1 ORDER BY id ASC LIMIT 1', [lid]);
  return rows[0] || null;
}

export async function create({ phone, nome = null, origem = 'whatsapp' }) {
  const { rows } = await query(
    `INSERT INTO leads (phone, nome, origem) VALUES ($1,$2,$3)
     ON CONFLICT (phone) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [phone, nome, origem]
  );
  return rows[0];
}

// Update parcial seguro: só altera as colunas permitidas que vierem no patch.
const ALLOWED = new Set([
  'nome', 'email', 'origem', 'stage', 'qual_score', 'tags', 'checkin', 'checkout',
  'guests', 'acomodacao', 'valor_cotado', 'ai_enabled', 'assigned_to', 'extra',
  'condicoes_pagamento', 'cpf', 'data_nascimento', 'lid',
]);

export async function update(id, patch) {
  const keys = Object.keys(patch).filter((k) => ALLOWED.has(k));
  if (keys.length === 0) return findById(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const vals = keys.map((k) => patch[k]);
  const { rows } = await query(
    `UPDATE leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...vals]
  );
  return rows[0];
}

// Acrescenta tags ao lead sem duplicar nem apagar as existentes.
export async function addTags(id, novas = []) {
  if (!Array.isArray(novas) || novas.length === 0) return findById(id);
  const { rows } = await query(
    `UPDATE leads
        SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(coalesce(tags, '{}') || $2::text[]) t),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, novas]
  );
  return rows[0];
}

export async function list({ stage } = {}) {
  if (stage) {
    const { rows } = await query('SELECT * FROM leads WHERE stage = $1 ORDER BY updated_at DESC', [stage]);
    return rows;
  }
  const { rows } = await query('SELECT * FROM leads ORDER BY updated_at DESC LIMIT 200');
  return rows;
}

export async function remove(id) {
  await query('DELETE FROM leads WHERE id = $1', [id]);
}
