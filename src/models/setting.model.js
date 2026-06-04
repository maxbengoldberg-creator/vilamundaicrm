import { query } from '../config/db.js';

export async function get(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function set(key, value) {
  const { rows } = await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING *`,
    [key, JSON.stringify(value)]
  );
  return rows[0];
}
