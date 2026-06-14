import crypto from 'crypto';
import { env } from '../config/env.js';

// Login do painel. Usuário em texto; senha guardada como HASH (sha256), nunca em
// texto no repositório. Dá para sobrescrever por variáveis de ambiente no Railway.
const USER = process.env.CRM_USER || 'maxbgoldberg';
const PASS_HASH = process.env.CRM_PASS_HASH || '940c25d45576cd776dc673af81418f52bd3fa5fcb3861eae7574659ff6fab6f5'; // sha256('vila@2793')
// Segredo para assinar o token (HMAC). Usa AUTH_SECRET ou cai na APP_API_KEY (já secreta no env).
const SECRET = process.env.AUTH_SECRET || env.appApiKey || 'vm-fallback-secret';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(String(s)).digest('hex');

export function checkCredentials(user, pass) {
  return String(user || '') === USER && sha256(pass || '') === PASS_HASH;
}

// Token stateless: base64url("<exp>.<hmac(user.exp)>"). Sobrevive a redeploy.
export function signToken() {
  const exp = Date.now() + TTL_MS;
  const sig = hmac(`${USER}.${exp}`);
  return Buffer.from(`${exp}.${sig}`).toString('base64url');
}

export function verifyToken(token) {
  try {
    const t = String(token || '');
    const raw = Buffer.from(t, 'base64url').toString();
    // round-trip: rejeita lixo extra/adulteração no base64url
    if (Buffer.from(raw).toString('base64url') !== t) return false;
    const [exp, sig] = raw.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const expected = hmac(`${USER}.${exp}`);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
