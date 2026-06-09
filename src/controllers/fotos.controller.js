import { query } from '../config/db.js';
import { syncFotos, moverFotos } from '../services/cloudinary.service.js';

export async function listFotos(req, res, next) {
  try {
    const { tipo_apto } = req.query;
    const { rows } = tipo_apto
      ? await query('SELECT * FROM fotos WHERE tipo_apto = $1 ORDER BY created_at ASC', [tipo_apto])
      : await query('SELECT * FROM fotos ORDER BY tipo_apto, created_at ASC');
    res.json(rows);
  } catch (e) { next(e); }
}

export async function syncFotosHandler(req, res, next) {
  try {
    const result = await syncFotos();
    res.json(result);
  } catch (e) {
    console.error('[fotos/sync] erro:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}

export async function clearFotos(req, res, next) {
  try {
    const { rowCount } = await query('DELETE FROM fotos');
    res.json({ ok: true, deletados: rowCount });
  } catch (e) { next(e); }
}

// Move fotos no Cloudinary de uma pasta para outra (dynamic folder mode).
// Body: { origem, destino }
export async function migrarFotos(req, res, next) {
  try {
    const { origem, destino } = req.body;
    if (!origem || !destino) return res.status(400).json({ error: 'origem e destino obrigatórios' });
    const result = await moverFotos(origem, destino);
    res.json(result);
  } catch (e) {
    console.error('[fotos/migrar] erro:', e.message);
    res.status(500).json({ error: e.message });
  }
}

