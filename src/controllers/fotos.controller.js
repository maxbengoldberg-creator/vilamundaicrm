import { query } from '../config/db.js';
import { syncFotos } from '../services/cloudinary.service.js';
import { v2 as cloudinary } from 'cloudinary';

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

export async function diagCloudinary(req, res, next) {
  const pasta = process.env.CLOUDINARY_FOTOS_PASTA || 'vila-mundai';
  const out = { pasta, cloud_name: process.env.CLOUDINARY_CLOUD_NAME };
  try {
    out.root_folders = (await cloudinary.api.root_folders()).folders;
  } catch(e) { out.root_folders_err = e.message; }
  try {
    const r = await cloudinary.api.resources({ type: 'upload', prefix: pasta, max_results: 5 });
    out.resources_prefix = { total_count: r.total_count, count: r.resources.length, sample: r.resources.slice(0,3).map(x => x.public_id) };
  } catch(e) { out.resources_prefix_err = e.message; }
  try {
    const r = await cloudinary.api.resources_by_folder(pasta, { max_results: 5 });
    out.resources_by_folder = { count: r.resources.length, sample: r.resources.slice(0,3).map(x => x.public_id) };
  } catch(e) { out.resources_by_folder_err = e.message; }
  try {
    const r = await cloudinary.api.sub_folders(pasta);
    out.sub_folders = r.folders;
  } catch(e) { out.sub_folders_err = e.message; }
  try {
    const r = await cloudinary.search.max_results(5).execute();
    out.search_all = { total_count: r.total_count, sample: r.resources?.slice(0,3).map(x => x.public_id) };
  } catch(e) { out.search_all_err = e.message; }
  res.json(out);
}
