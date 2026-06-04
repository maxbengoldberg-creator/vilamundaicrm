import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ service: 'Vila Mundaí CRM API', status: 'online' }));
app.use('/', routes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] Vila Mundaí CRM rodando na porta ${env.port}`);
  console.log(`[server] modelo Claude: ${env.anthropic.model}`);
});
