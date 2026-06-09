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
// Lê as subpastas por tipo_apto a partir de CLOUDINARY_FOTOS_PASTA (padrão: "vila-mundai").
// Estrutura esperada: vila-mundai/1-quarto-terreo/*, vila-mundai/2-quartos-superior/*, etc.
export async function syncFotos() {
  const raiz = process.env.CLOUDINARY_FOTOS_PASTA || 'vila-mundai';
  const result = await cloudinary.api.resources({
    type: 'upload',
    prefix: raiz,
    max_results: 500,
  });

  let inseridos = 0;
  let ignorados = 0;

  for (const r of result.resources) {
    // Extrai tipo_apto do segundo segmento do caminho (ex: vila-mundai/1-quarto-terreo/foto.jpg)
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

  return { ok: true, inseridos, ignorados, total: result.resources.length };
}
