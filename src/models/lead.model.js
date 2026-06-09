import { query } from '../config/db.js';

export async function findByPhone(phone) {
  const { rows } = await query('SELECT * FROM leads WHERE phone = $1', [phone]);
  return rows[0] || null;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM leads WHERE id = $1', [id]);
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
  'condicoes_pagamento',
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
