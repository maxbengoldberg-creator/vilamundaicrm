import { query } from '../config/db.js';

export async function list() {
  const { rows } = await query('SELECT * FROM automations ORDER BY id ASC');
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM automations WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function create({ nome, descricao = null, flow = [], prompt = null, enabled = false }) {
  const { rows } = await query(
    `INSERT INTO automations (nome, descricao, flow, prompt, enabled)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [nome, descricao, JSON.stringify(flow), prompt, enabled]
  );
  return rows[0];
}

export async function update(id, patch) {
  const fields = [];
  const vals = [];
  let i = 2;
  for (const k of ['nome', 'descricao', 'enabled', 'flow', 'prompt']) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      vals.push(k === 'flow' ? JSON.stringify(patch[k]) : patch[k]);
    }
  }
  if (!fields.length) return findById(id);
  const { rows } = await query(
    `UPDATE automations SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...vals]
  );
  return rows[0];
}
