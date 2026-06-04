import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] aplicando schema...');
  await pool.query(sql);
  console.log('[migrate] concluído com sucesso.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] falhou:', err.message);
  process.exit(1);
});
