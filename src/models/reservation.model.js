import { query } from '../config/db.js';

export async function create(r) {
  const { rows } = await query(
    `INSERT INTO reservations (lead_id, pms_id, checkin, checkout, guests, acomodacao, valor, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [r.lead_id, r.pms_id, r.checkin, r.checkout, r.guests, r.acomodacao, r.valor, r.status, r.payload ? JSON.stringify(r.payload) : null]
  );
  return rows[0];
}

export async function list() {
  const { rows } = await query('SELECT * FROM reservations ORDER BY created_at DESC LIMIT 100');
  return rows;
}
