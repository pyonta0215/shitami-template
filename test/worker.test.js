import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { verifyAccess } from '../worker/access.js';
import { toProxyUrl } from '../web/app.js';

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k)?.value; return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, value, opts = {}) { m.set(k, { value, metadata: opts.metadata }); },
    async list({ prefix }) { return { keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })) }; },
  };
}

let env;
let upstream;
const realFetch = globalThis.fetch;
beforeEach(() => {
  env = { STORE: fakeKv(), YOUTUBE_API_KEY: 'yt-secret', SEARCH_DAILY_CAP: '3', ACCESS_TEAM: '', ACCESS_AUD: '' };
  upstream = [];
  globalThis.fetch = async (url, init) => { upstream.push({ url: String(url), init }); return new Response('{"items":[]}', { status: 200 }); };
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (path, init) => worker.fetch(new Request(`https://x.test${path}`, init), env);
const start = (theme = 'AI BGM', region = 'jp') =>
  call('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, region }) });

test('調べ切りは1日1回。同じテーマなら続きから、違うテーマは断る', async () => {
  const a = await (await start()).json();
  assert.equal(a.resumed, false);
  assert.match(a.run.id, /^[A-Za-z0-9]{12}$/);
  const b = await (await start()).json();
  assert.equal(b.resumed, true);
  assert.equal(b.run.id, a.run.id);
  const c = await start('lofi', 'en');
  assert.equal(c.status, 409);
});

test('APIキーが通らなければ始めない（1日分を空回りさせない）', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 400 });
  const r = await start();
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /APIキーが正しくありません/);
  assert.equal((await (await call('/api/status')).json()).run, null);
});

test('始める前の YouTube 中継は断る', async () => {
  const r = await call('/api/yt/videos?part=snippet&id=x');
  assert.equal(r.status, 409);
  assert.equal(upstream.length, 0);
});

test('YouTube の中継はキーを Worker で付け直し、ブラウザから来た key は捨てる', async () => {
  await start();
  await call('/api/yt/videos?part=snippet&id=abc&key=attacker');
  const u = new URL(upstream.at(-1).url);
  assert.equal(u.origin + u.pathname, 'https://www.googleapis.com/youtube/v3/videos');
  assert.deepEqual(u.searchParams.getAll('key'), ['yt-secret']);
  assert.equal(u.searchParams.get('id'), 'abc');
});

test('search は1日の上限で止める（videos などは数えない）', async () => {
  await start();
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/yt/search?q=a')).status, 200);
  assert.equal((await call('/api/yt/search?q=a')).status, 429);
  assert.ok(upstream.every((u) => !u.url.includes('/search?') || u.url.includes('q=a')));
  assert.equal((await call('/api/yt/channels?id=a')).status, 200);
  const s = await (await call('/api/status')).json();
  assert.deepEqual(s.search, { used: 3, cap: 3 });
});

test('中継しない YouTube のメソッドは断る', async () => {
  await start();
  assert.equal((await call('/api/yt/commentThreads?videoId=x')).status, 404);
});

test('OpenAI はキーが無ければ使えず、あれば1日2回まで中継する', async () => {
  await start();
  assert.equal((await call('/api/llm', { method: 'POST', body: '{}' })).status, 404);
  env.OPENAI_API_KEY = 'oa-secret';
  for (let i = 0; i < 2; i++) assert.equal((await call('/api/llm', { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await call('/api/llm', { method: 'POST', body: '{}' })).status, 429);
  assert.equal(new Headers(upstream.find((u) => u.url.startsWith('https://api.openai.com/')).init.headers).get('authorization'), 'Bearer oa-secret');
});

test('結果は30日の期限付きで保存し、/r/<id>/ で noindex 付きで返す', async () => {
  const { run } = await (await start()).json();
  const put = await call(`/api/results/${run.id}`, { method: 'PUT', body: JSON.stringify({ html: '<p>ok</p>', result: { theme: 'AI BGM', regionLabel: '日本', date: '2026-10-13' } }) });
  assert.equal(put.status, 200);
  const page = await call(`/r/${run.id}/`);
  assert.equal(await page.text(), '<p>ok</p>');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const list = await (await call('/api/results')).json();
  assert.equal(list.items[0].theme, 'AI BGM');
  assert.equal((await call('/r/AAAAAAAAAAAA/')).status, 404);
  assert.equal((await call(`/r/${run.id}`)).headers.get('location'), `/r/${run.id}/`);
});

test('Access の後ろにいるかどうかを画面に伝える', async () => {
  assert.equal((await (await call('/api/status')).json()).access, false);
  assert.equal((await (await call('/api/status', { headers: { 'cf-access-jwt-assertion': 'x' } })).json()).access, true);
});

test('Access を設定したら、トークンの無い呼び出しを断る', async () => {
  env.ACCESS_TEAM = 'team';
  env.ACCESS_AUD = 'aud';
  assert.equal((await call('/api/status')).status, 403);
  assert.equal(await verifyAccess(new Request('https://x.test', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } }), env), false);
});

test('Access のトークンは署名・宛先・期限を確かめる', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (payload) => {
    const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head));
    return `${head}.${Buffer.from(sig).toString('base64url')}`;
  };
  const e = { ACCESS_TEAM: 'team2', ACCESS_AUD: 'aud' };
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const req = (t) => new Request('https://x.test', { headers: { 'cf-access-jwt-assertion': t } });
  const good = { aud: ['aud'], iss: 'https://team2.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 60 };
  assert.equal(await verifyAccess(req(await sign(good)), e, { fetchImpl }), true);
  assert.equal(await verifyAccess(req(await sign({ ...good, aud: ['other'] })), e, { fetchImpl }), false);
  assert.equal(await verifyAccess(req(await sign({ ...good, exp: 1 })), e, { fetchImpl }), false);
  const t = await sign(good);
  assert.equal(await verifyAccess(req(t.slice(0, -4) + 'AAAA'), e, { fetchImpl }), false);
});

test('ブラウザからの呼び出し先を中継の URL に差し替える', () => {
  assert.equal(toProxyUrl('https://www.googleapis.com/youtube/v3/search?part=snippet&q=a&key=x'), '/api/yt/search?part=snippet&q=a');
  assert.equal(toProxyUrl('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=us&q=lofi%20a'), '/api/suggest?region=en&q=lofi%20a');
  assert.equal(toProxyUrl('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ja&gl=jp&q=a'), '/api/suggest?region=jp&q=a');
  assert.equal(toProxyUrl('https://api.openai.com/v1/responses'), '/api/llm');
  assert.throws(() => toProxyUrl('https://example.com/'));
});
