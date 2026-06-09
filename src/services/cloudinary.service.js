import { v2 as cloudinary } from 'cloudinary';
import { query } from '../config/db.js';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Lista todos os recursos de uma pasta do Cloudinary e retorna suas URLs públicas.
export async function listFotos(pasta) {
  const result = await cloudinary.api.resources({
    type: 'upload',
    prefix: pasta,
    max_results: 200,
  });
  return result.resources.map(r => ({
    public_id: r.public_id,
    url: r.secure_url,
    formato: r.format,
  }));
}

// Sincroniza todas as fotos do Cloudinary com a tabela fotos no banco.
// Usa a Search API (funciona com folder mode ativo) e pagina até esgotar.
// Estrutura esperada: vila-mundai/<tipo_apto>/arquivo — o tipo_apto vem da subpasta.
export async function syncFotos() {
  const raiz = process.env.CLOUDINARY_FOTOS_PASTA || 'vila-mundai';
  let todos = [];
  let cursor = null;

  do {
    const q = cloudinary.search
      .expression(`folder:${raiz}/*`)
      .with_field('secure_url')
      .max_results(200);
    if (cursor) q.next_cursor(cursor);
    const result = await q.execute();
    todos = todos.concat(result.resources || []);
    cursor = result.next_cursor || null;
  } while (cursor);

  let inseridos = 0;
  let ignorados = 0;

  for (const r of todos) {
    // Extrai tipo_apto da subpasta imediatamente abaixo da raiz
    // ex: vila-mundai/apto-1-quarto-superior/foto.jpg → tipo_apto = "apto-1-quarto-superior"
    const partes = r.public_id.split('/');
    const tipo_apto = partes.length >= 2 ? partes[partes.length - 2] : null;

    const { rowCount } = await query(
      `INSERT INTO fotos (tipo_apto, url, public_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (public_id) DO NOTHING`,
      [tipo_apto, r.secure_url, r.public_id]
    );
    if (rowCount > 0) inseridos++;
    else ignorados++;
  }

  return { ok: true, inseridos, ignorados, total: todos.length };
}
