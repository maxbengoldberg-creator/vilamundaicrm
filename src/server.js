import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { mornoJob } from './jobs/morno.job.js';
import { seedIfEmpty } from './models/automation_stage.model.js';

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

  // Job de morno: roda imediatamente e depois a cada 1 hora
  mornoJob();
  setInterval(mornoJob, 60 * 60 * 1000);
  console.log('[server] morno.job registrado (intervalo: 1h)');
});
