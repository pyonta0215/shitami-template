// shitami の Worker。調べ切りの計算はブラウザがするので、ここは「鍵番」だけを受け持つ。
//
//   /api/status        今日の実行・検索の残り・OpenAI と Access の設定状況
//   /api/runs          今日の調べ切りを始める（1日1回。太平洋時間の0時＝日本時間16〜17時に戻る）
//   /api/yt/<method>   YouTube Data API の中継。キーはここで付け、ブラウザには出さない
//   /api/suggest       YouTube の検索候補の中継（ブラウザから直接は呼べないため）
//   /api/llm           OpenAI の中継（キーを入れたときだけ）
//   /api/results       結果の保存と一覧。KV に30日だけ置く（YouTube API の開発者ポリシー）
//   /r/<id>/           保存した結果ページ
//
// 外に出すエラーは種類だけにする。上流の本文やキーを含みうる値はログにも出さない。

import { accessConfigured, verifyAccess } from './access.js';
import { ptDate } from '../src/deep/plan.js';

const YT_BASE = 'https://www.googleapis.com/youtube/v3/';
const YT_METHODS = new Set(['search', 'videos', 'channels', 'playlistItems']);
const SUGGEST = 'https://suggestqueries.google.com/complete/search';
const OPENAI = 'https://api.openai.com/v1/responses';
const REGIONS = { jp: { hl: 'ja', gl: 'jp' }, en: { hl: 'en', gl: 'us' } };
const LLM_DAILY_CAP = 2; // 調べ切りは1回呼ぶ。やり直しに1回
const DAY_TTL = 3 * 24 * 60 * 60;
const RESULT_TTL = 30 * 24 * 60 * 60;
const ID_RE = /^[A-Za-z0-9]{12}$/;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

export function jstDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function newId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => abc[b % abc.length]).join('');
}

async function getCount(env, key) {
  return Number((await env.STORE.get(key)) ?? 0);
}

async function bump(env, key) {
  const n = (await getCount(env, key)) + 1;
  await env.STORE.put(key, String(n), { expirationTtl: DAY_TTL });
  return n;
}

async function todayRun(env, day) {
  return env.STORE.get(`run:${day}`, 'json');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (accessConfigured(env) && !(await verifyAccess(request, env))) {
      return fail(403, 'Cloudflare Access を通っていない呼び出しです');
    }

    try {
      if (path.startsWith('/r/')) return serveResult(path, env);
      if (path === '/api/status' && request.method === 'GET') return status(request, env);
      if (path === '/api/runs' && request.method === 'POST') return startRun(request, env);
      if (path.startsWith('/api/yt/') && request.method === 'GET') return youtube(path.slice('/api/yt/'.length), url, env);
      if (path === '/api/suggest' && request.method === 'GET') return suggest(url, env);
      if (path === '/api/llm' && request.method === 'POST') return llm(request, env);
      if (path === '/api/results' && request.method === 'GET') return listResults(env);
      if (path.startsWith('/api/results/') && request.method === 'PUT') return saveResult(path.slice('/api/results/'.length), request, env);
      return fail(404, '見つかりません');
    } catch (e) {
      console.log(JSON.stringify({ path, error: e.name }));
      return fail(500, '中継に失敗しました');
    }
  },
};

async function status(request, env) {
  const day = ptDate();
  return json({
    day,
    run: await todayRun(env, day),
    search: { used: await getCount(env, `count:search:${day}`), cap: Number(env.SEARCH_DAILY_CAP ?? 95) },
    youtube: Boolean(env.YOUTUBE_API_KEY),
    llm: Boolean(env.OPENAI_API_KEY),
    // Access の後ろにあれば、このヘッダーが必ず付く（画面の「鍵がかかっていません」表示に使うだけ）
    access: accessConfigured(env) || request.headers.has('cf-access-jwt-assertion'),
  });
}

async function startRun(request, env) {
  if (!env.YOUTUBE_API_KEY) return fail(503, 'YouTube の APIキーが設定されていません（README の手順3）');
  const body = await request.json().catch(() => ({}));
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const region = body.region;
  if (!theme || theme.length > 40) return fail(400, 'テーマを1〜40文字で入れてください');
  if (!REGIONS[region]) return fail(400, '地域が正しくありません');

  const day = ptDate();
  const existing = await todayRun(env, day);
  if (existing) {
    // 同じテーマなら続きから。違うテーマは翌日に
    if (existing.theme === theme && existing.region === region) return json({ run: existing, resumed: true });
    return json({ error: '今日の調べ切りはもう使いました。日本時間の16〜17時に戻ります', run: existing }, 409);
  }
  // キーが間違っていると、検索が全部失敗したまま1日分を使い切る。始める前に1 unit だけ使って確かめる
  const probe = await fetch(`${YT_BASE}videos?part=id&id=dQw4w9WgXcQ&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  if (!probe.ok) {
    const reason = probe.status === 403 ? 'YouTube の枠を使い切ったか、YouTube Data API v3 が有効になっていません' : 'YouTube の APIキーが正しくありません';
    return fail(503, `${reason}（README の手順3）`);
  }
  const run = { id: newId(), theme, region, date: jstDate(), day, startedAt: new Date().toISOString() };
  await env.STORE.put(`run:${day}`, JSON.stringify(run), { expirationTtl: DAY_TTL });
  return json({ run, resumed: false });
}

async function youtube(method, url, env) {
  if (!YT_METHODS.has(method)) return fail(404, '中継していない呼び出しです');
  const day = ptDate();
  if (!(await todayRun(env, day))) return fail(409, '先に調べ切りを始めてください');
  if (method === 'search') {
    const cap = Number(env.SEARCH_DAILY_CAP ?? 95);
    if ((await getCount(env, `count:search:${day}`)) >= cap) return fail(429, '今日の検索の上限に達しました');
    await bump(env, `count:search:${day}`);
  }
  const params = new URLSearchParams(url.search);
  params.delete('key');
  params.set('key', env.YOUTUBE_API_KEY);
  const res = await fetch(`${YT_BASE}${method}?${params}`);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function suggest(url, env) {
  if (!(await todayRun(env, ptDate()))) return fail(409, '先に調べ切りを始めてください');
  const q = url.searchParams.get('q') ?? '';
  const r = REGIONS[url.searchParams.get('region')];
  if (!q || q.length > 100 || !r) return fail(400, '検索語が正しくありません');
  const target = `${SUGGEST}?client=firefox&ds=yt&hl=${r.hl}&gl=${r.gl}&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
  const res = await fetch(target);
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function llm(request, env) {
  if (!env.OPENAI_API_KEY) return fail(404, 'OpenAI のキーが設定されていません');
  const day = ptDate();
  if (!(await todayRun(env, day))) return fail(409, '先に調べ切りを始めてください');
  if ((await getCount(env, `count:llm:${day}`)) >= LLM_DAILY_CAP) return fail(429, '今日の Web 調査の上限に達しました');
  await bump(env, `count:llm:${day}`);
  const res = await fetch(OPENAI, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: request.body,
  });
  return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function saveResult(id, request, env) {
  if (!ID_RE.test(id)) return fail(400, 'id が正しくありません');
  const text = await request.text();
  if (text.length > MAX_RESULT_BYTES) return fail(413, '結果が大きすぎます');
  const { html, result } = JSON.parse(text);
  if (typeof html !== 'string' || !result || typeof result !== 'object') return fail(400, '結果の形が正しくありません');
  const meta = { theme: String(result.theme ?? ''), regionLabel: String(result.regionLabel ?? ''), date: String(result.date ?? ''), savedAt: new Date().toISOString() };
  await env.STORE.put(`res:${id}`, html, { expirationTtl: RESULT_TTL, metadata: meta });
  await env.STORE.put(`json:${id}`, JSON.stringify(result), { expirationTtl: RESULT_TTL });
  return json({ url: `/r/${id}/` });
}

async function listResults(env) {
  const list = await env.STORE.list({ prefix: 'res:', limit: 100 });
  const items = list.keys
    .map((k) => ({ id: k.name.slice(4), ...(k.metadata ?? {}) }))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  return json({ items });
}

async function serveResult(path, env) {
  const m = path.match(/^\/r\/([A-Za-z0-9]{12})(\/|\/index\.html|\/result\.json)?$/);
  if (!m) return fail(404, '見つかりません');
  if (!m[2]) return new Response(null, { status: 301, headers: { location: `/r/${m[1]}/` } });
  const headers = { 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=60' };
  if (m[2] === '/result.json') {
    const body = await env.STORE.get(`json:${m[1]}`);
    return body ? new Response(body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } }) : fail(404, '30日を過ぎたか、見つかりません');
  }
  const html = await env.STORE.get(`res:${m[1]}`);
  if (!html) return new Response('30日を過ぎたか、見つかりません', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(html, { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}
