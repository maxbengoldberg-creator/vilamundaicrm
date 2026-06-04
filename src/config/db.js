import pg from 'pg';
import { env } from './env.js';

const { Pool } = pg;

// O Railway exige SSL nas conexões externas; em local geralmente não.
const useSsl = /railway|render|amazonaws|supabase/i.test(env.databaseUrl || '');

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export function query(text, params) {
  return pool.query(text, params);
}

pool.on('error', (err) => {
  console.error('[db] erro inesperado no pool:', err.message);
});
