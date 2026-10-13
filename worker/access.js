// Cloudflare Access が付けるトークン（Cf-Access-Jwt-Assertion）を Worker 側でも確かめる（任意）。
//
// Worker の「Access」タブで保護すれば、Access は Worker より前で全リクエストを確かめるので、これが無くても守られる。
// 念のため Worker 側でも確かめたい人は、ACCESS_TEAM と ACCESS_AUD を入れる（README の「もう一段かたくする」）。
// 空なら確かめない。

const certCache = new Map(); // team → { keys, at }
const CERT_TTL_MS = 10 * 60 * 1000;

export function accessConfigured(env) {
  return Boolean(env.ACCESS_TEAM && env.ACCESS_AUD);
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const decodeJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function certsFor(team, fetchImpl) {
  const hit = certCache.get(team);
  if (hit && Date.now() - hit.at < CERT_TTL_MS) return hit.keys;
  const res = await fetchImpl(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys } = await res.json();
  certCache.set(team, { keys, at: Date.now() });
  return keys;
}

/** 正しければ true。理由は返さない（外に出す必要がない） */
export async function verifyAccess(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = decodeJson(parts[0]);
    const payload = decodeJson(parts[1]);
    if (header.alg !== 'RS256') return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return false;
    if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return false;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return false;

    const jwk = (await certsFor(env.ACCESS_TEAM, fetchImpl)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}
