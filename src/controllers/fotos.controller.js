import { query } from '../config/db.js';
import { syncFotos, moverFotos } from '../services/cloudinary.service.js';

export async function listFotos(req, res, next) {
  try {
    const { tipo_apto } = req.query;
    const { rows } = tipo_apto
      ? await query('SELECT * FROM fotos WHERE tipo_apto = $1 ORDER BY ordem ASC NULLS LAST, created_at ASC', [tipo_apto])
      : await query('SELECT * FROM fotos ORDER BY tipo_apto, ordem ASC NULLS LAST, created_at ASC');
    res.json(rows);
  } catch (e) { next(e); }
}

export async function updateFoto(req, res, next) {
  try {
    const { id } = req.params;
    const { ordem, tipo_apto, descricao } = req.body;
    const sets = [];
    const vals = [];
    if (ordem !== undefined) { sets.push(`ordem = $${vals.length+2}`); vals.push(ordem); }
    if (tipo_apto !== undefined) { sets.push(`tipo_apto = $${vals.length+2}`); vals.push(tipo_apto); }
    if (descricao !== undefined) { sets.push(`descricao = $${vals.length+2}`); vals.push(descricao); }
    if (sets.length === 0) return res.status(400).json({ error: 'nenhum campo para atualizar' });
    const { rows } = await query(
      `UPDATE fotos SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...vals]
    );
    if (!rows[0]) return res.status(404).json({ error: 'foto não encontrada' });
    res.json(rows[0]);
  } catch (e) { next(e); }
}

export async function syncFotosHandler(req, res, next) {
  try {
    const result = await syncFotos();
    res.json(result);
  } catch (e) {
    const msg = e?.message || JSON.stringify(e) || 'erro desconhecido';
    console.error('[fotos/sync] erro:', msg, e?.stack || '');
    res.status(500).json({ error: msg });
  }
}

export async function clearFotos(req, res, next) {
  try {
    const { rowCount } = await query('DELETE FROM fotos');
    res.json({ ok: true, deletados: rowCount });
  } catch (e) { next(e); }
}

// Atualiza o asset_folder no Cloudinary e o tipo_apto no banco para todas
// as fotos com tipo_apto NULL. Body: { tipo_apto } — ex: "apto-1-quarto-superior"
export async function migrarFotos(req, res, next) {
  try {
    const { tipo_apto } = req.body;
    if (!tipo_apto) return res.status(400).json({ error: 'tipo_apto obrigatório' });
    const raiz = process.env.CLOUDINARY_FOTOS_PASTA || 'vila-mundai';
    const novaFolder = `${raiz}/${tipo_apto}`;

    const { rows } = await query(`SELECT public_id FROM fotos WHERE tipo_apto IS NULL`);
    const erros = [];
    let movidos = 0;

    for (const { public_id } of rows) {
      try {
        await moverFotos(public_id, novaFolder);
        movidos++;
      } catch (e) {
        const msg = e?.message || JSON.stringify(e);
        console.error(`[fotos/migrar] erro em ${public_id}:`, msg);
        erros.push({ public_id, erro: msg });
      }
    }

    // Atualiza o banco para os que foram movidos com sucesso
    if (movidos > 0) {
      await query(
        `UPDATE fotos SET tipo_apto = $1 WHERE tipo_apto IS NULL`,
        [tipo_apto]
      );
    }

    res.json({ ok: true, total: rows.length, movidos, erros });
  } catch (e) {
    const msg = e?.message || JSON.stringify(e);
    console.error('[fotos/migrar] erro geral:', msg);
    res.status(500).json({ error: msg });
  }
}

