import { query } from '../config/db.js';

export async function create({ nome = null, usar_draft = false }) {
  const leadInicial = {
    nome: null, stage: 'qualif', tags: [], checkin: null, checkout: null,
    guests: null, acomodacao: null, valor_cotado: null, condicoes_pagamento: null,
    ai_enabled: true, cpf: null, data_nascimento: null,
  };
  const { rows } = await query(
    `INSERT INTO simulacoes (nome, usar_draft, lead_json) VALUES ($1, $2, $3) RETURNING *`,
    [nome, usar_draft, JSON.stringify(leadInicial)]
  );
  return rows[0];
}

export async function findById(id) {
  const { rows } = await query(`SELECT * FROM simulacoes WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function list(limit = 30) {
  const { rows } = await query(
    `SELECT id, nome, usar_draft, status, created_at, updated_at,
            jsonb_array_length(transcript) AS turnos,
            lead_json->>'stage' AS stage,
            (relatorio IS NOT NULL) AS tem_relatorio
       FROM simulacoes ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function saveState(id, { lead, messages, transcript }) {
  await query(
    `UPDATE simulacoes
        SET lead_json = $2, messages_json = $3, transcript = $4, updated_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(lead), JSON.stringify(messages), JSON.stringify(transcript)]
  );
}

export async function saveRelatorio(id, relatorio) {
  await query(
    `UPDATE simulacoes SET relatorio = $2, status = 'avaliada', updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(relatorio)]
  );
}

export async function remove(id) {
  await query(`DELETE FROM simulacoes WHERE id = $1`, [id]);
}
