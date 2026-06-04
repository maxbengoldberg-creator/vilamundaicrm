import { query } from '../config/db.js';

export async function upsertFromReserva(c) {
  const { rows } = await query(
    `INSERT INTO clientes
      (pms_reservation_id, pms_guest_id, nome, phone, email, canal, qualificacao,
       check_in, check_out, noites, pessoas, receita_cents, acomodacao, status_reserva, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (pms_reservation_id) DO UPDATE SET
       nome=EXCLUDED.nome, phone=COALESCE(EXCLUDED.phone, clientes.phone),
       canal=EXCLUDED.canal, qualificacao=EXCLUDED.qualificacao,
       check_in=EXCLUDED.check_in, check_out=EXCLUDED.check_out,
       noites=EXCLUDED.noites, pessoas=EXCLUDED.pessoas,
       receita_cents=EXCLUDED.receita_cents, acomodacao=EXCLUDED.acomodacao,
       status_reserva=EXCLUDED.status_reserva, updated_at=now()
     RETURNING *`,
    [c.pms_reservation_id, c.pms_guest_id, c.nome, c.phone, c.email, c.canal, c.qualificacao,
     c.check_in, c.check_out, c.noites, c.pessoas, c.receita_cents, c.acomodacao, c.status_reserva, c.note]
  );
  return rows[0];
}

export async function list() {
  const { rows } = await query('SELECT * FROM clientes ORDER BY check_in ASC');
  return rows;
}

export async function findById(id) {
  const { rows } = await query('SELECT * FROM clientes WHERE id = $1', [id]);
  return rows[0] || null;
}

const ALLOWED = new Set(['nome','phone','email','qualificacao','boas_vindas_enviada','auto_boas_vindas','ai_enabled','note']);
export async function update(id, patch) {
  const keys = Object.keys(patch).filter(k => ALLOWED.has(k));
  if (!keys.length) return findById(id);
  const sets = keys.map((k,i) => `${k} = $${i+2}`);
  const vals = keys.map(k => patch[k]);
  const { rows } = await query(
    `UPDATE clientes SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, ...vals]
  );
  return rows[0];
}

export async function findByPhone(phone) {
  const { rows } = await query('SELECT * FROM clientes WHERE phone = $1 ORDER BY check_in DESC LIMIT 1', [phone]);
  return rows[0] || null;
}

export async function remove(id) {
  await query('DELETE FROM clientes WHERE id = $1', [id]);
}
