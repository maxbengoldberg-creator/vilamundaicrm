import { env } from '../config/env.js';
import { verifyToken } from '../services/auth.js';

// Protege as rotas /api/v1. Aceita o token de sessão (login do painel, via
// Authorization: Bearer) ou a chave APP_API_KEY (header x-api-key, para
// integrações servidor-a-servidor). A chave NÃO fica mais exposta no HTML.
export function requireApiKey(req, res, next) {
  const auth = req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && verifyToken(m[1])) return next();

  const key = req.header('x-api-key');
  if (key && key === env.appApiKey) return next();

  return res.status(401).json({ error: 'não autorizado' });
}
