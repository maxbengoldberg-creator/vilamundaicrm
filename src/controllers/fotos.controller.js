import { query } from '../config/db.js';
import { syncFotos } from '../services/cloudinary.service.js';

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
  } catch (e) { next(e); }
}
