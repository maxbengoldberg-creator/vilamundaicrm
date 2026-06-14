import { checkCredentials, signToken } from '../services/auth.js';

// POST /api/v1/auth/login — valida usuário/senha e devolve um token de sessão.
export function login(req, res) {
  const { user, pass } = req.body || {};
  if (!checkCredentials(user, pass)) {
    return res.status(401).json({ error: 'usuário ou senha inválidos' });
  }
  res.json({ ok: true, token: signToken() });
}
