import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { mornoJob } from './jobs/morno.job.js';
import { seedIfEmpty } from './models/automation_stage.model.js';
import { query } from './config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, '../public')));

app.use('/', routes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] Vila Mundaí CRM rodando na porta ${env.port}`);
  console.log(`[server] modelo Claude: ${env.anthropic.model}`);

  // Garante tabela e seed de prompts por etapa
  seedIfEmpty().catch(err => console.error('[server] seed stages falhou:', err.message));

  // Adiciona colunas de rastreamento de custo (idempotente)
  Promise.all([
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_tokens_input  INTEGER     DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_tokens_output INTEGER     DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_custo_brl     NUMERIC(10,4) DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS condicoes_pagamento JSONB DEFAULT '{}'`),
    query(`CREATE TABLE IF NOT EXISTS fotos (
      id         BIGSERIAL PRIMARY KEY,
      tipo_apto  TEXT,
      descricao  TEXT,
      url        TEXT NOT NULL,
      public_id  TEXT UNIQUE NOT NULL,
      ordem      INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    )`),
    query(`ALTER TABLE fotos ADD COLUMN IF NOT EXISTS ordem INTEGER`),
  ]).catch(err => console.error('[server] migrate falhou:', err.message));

  // Job de morno: roda imediatamente e depois a cada 1 hora
  mornoJob();
  setInterval(mornoJob, 60 * 60 * 1000);
  console.log('[server] morno.job registrado (intervalo: 1h)');
});
