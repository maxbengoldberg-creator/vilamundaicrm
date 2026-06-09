import { v2 as cloudinary } from 'cloudinary';
import { query } from '../config/db.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Busca todos os recursos de uma pasta usando a Search API (suporta dynamic folder mode).
// Retorna asset_folder para extrair o tipo_apto corretamente.
async function buscarRecursos(expression) {
  let todos = [];
  let cursor = null;
  do {
    let q = cloudinary.search
      .expression(expression)
      .with_field('asset_folder')
      .max_results(200);
    if (cursor) q = q.next_cursor(cursor);
    const result = await q.execute();
    todos = todos.concat(result.resources || []);
    cursor = result.next_cursor || null;
  } while (cursor);
  return todos;
}

// Lista todos os recursos de uma pasta do Cloudinary e retorna suas URLs públicas.
export async function listFotos(pasta) {
  const recursos = await buscarRecursos(`folder:${pasta}/*`);
  return recursos.map(r => ({
    public_id: r.public_id,
    asset_folder: r.asset_folder,
    url: r.secure_url,
    formato: r.format,
  }));
}

// Move um recurso individual para outra pasta no Cloudinary (dynamic folder mode).
// Lança exceção em caso de erro para que o caller possa tratar individualmente.
export async function moverFotos(publicId, pastaDestino) {
  await cloudinary.api.update(publicId, { asset_folder: pastaDestino });
}

// Sincroniza todas as fotos do Cloudinary com a tabela fotos no banco.
// Em dynamic folder mode, o tipo_apto vem do asset_folder (não do public_id).
// Estrutura esperada: vila-mundai/<tipo_apto> como asset_folder.
export async function syncFotos() {
  const raiz = process.env.CLOUDINARY_FOTOS_PASTA || 'vila-mundai';
  const recursos = await buscarRecursos(`folder:${raiz}/*`);

  let inseridos = 0;
  let ignorados = 0;

  for (const r of recursos) {
    // Em dynamic folder mode, asset_folder = "vila-mundai/apto-1-quarto-superior"
    // O tipo_apto é o último segmento do asset_folder.
    const folder = r.asset_folder || '';
    const partes = folder.split('/').filter(Boolean);
    const tipo_apto = partes.length >= 2 ? partes[partes.length - 1] : null;

    const { rowCount } = await query(
      `INSERT INTO fotos (tipo_apto, url, public_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (public_id) DO NOTHING`,
      [tipo_apto, r.secure_url, r.public_id]
    );
    if (rowCount > 0) inseridos++;
    else ignorados++;
  }

  return { ok: true, inseridos, ignorados, total: recursos.length };
}
