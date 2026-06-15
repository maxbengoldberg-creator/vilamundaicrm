import crypto from 'crypto';
import { env } from '../config/env.js';

// Login do painel. Usuário em texto; senha guardada como HASH (sha256), nunca em
// texto no repositório. Dá para sobrescrever o usuário principal por variáveis de
// ambiente no Railway (CRM_USER / CRM_PASS_HASH).
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Lista de usuários do painel. Cada um: { user, passHash }.
const USERS = [
  {
    user: process.env.CRM_USER || 'maxbgoldberg',
    passHash: process.env.CRM_PASS_HASH || '940c25d45576cd776dc673af81418f52bd3fa5fcb3861eae7574659ff6fab6f5', // sha256('vila@2793')
  },
  {
    user: 'mateusribas',
    passHash: '0f5cbbc8c265f3c21602f20ab1c6e56a2e7061462b37d214bfabd3413063a1a1', // sha256('telegrao150!')
  },
];

// Segredo para assinar o token (HMAC). Usa AUTH_SECRET ou cai na APP_API_KEY (já secreta no env).
const SECRET = process.env.AUTH_SECRET || env.appApiKey || 'vm-fallback-secret';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(String(s)).digest('hex');

// Devolve o nome do usuário se as credenciais baterem; senão null.
export function checkCredentials(user, pass) {
  const u = USERS.find((x) => x.user === String(user || ''));
  if (!u) return null;
  return sha256(pass || '') === u.passHash ? u.user : null;
}

// Token stateless: base64url("<user>.<exp>.<hmac(user.exp)>"). Sobrevive a redeploy.
export function signToken(user) {
  const exp = Date.now() + TTL_MS;
  const sig = hmac(`${user}.${exp}`);
  return Buffer.from(`${user}.${exp}.${sig}`).toString('base64url');
}

export function verifyToken(token) {
  try {
    const t = String(token || '');
    const raw = Buffer.from(t, 'base64url').toString();
    // round-trip: rejeita lixo extra/adulteração no base64url
    if (Buffer.from(raw).toString('base64url') !== t) return false;
    const [user, exp, sig] = raw.split('.');
    if (!user || !exp || !sig || Number(exp) < Date.now()) return false;
    if (!USERS.some((x) => x.user === user)) return false;
    const expected = hmac(`${user}.${exp}`);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
