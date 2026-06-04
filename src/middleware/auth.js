import { env } from '../config/env.js';

// Protege rotas administrativas com a chave APP_API_KEY (header x-api-key).
export function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== env.appApiKey) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  next();
}
