// Apps Script に無いものを補う。計算の部分（src/）は Node・ブラウザ向けに書いてあるので、
// fetch・URL・setTimeout・AbortSignal をここで用意して、そのまま動かす。
//
// - YouTube Data API は APIキーではなく、Apps Script の YouTube 拡張サービス（本人の Google アカウントの権限）で呼ぶ
// - OpenAI は1回の通信が長い（最大4分）。Apps Script の通信は約60秒で切れるので、
//   バックグラウンド実行で頼み、終わるまで短い問い合わせで待つ

/* global UrlFetchApp, Utilities, PropertiesService, YouTube */

// ---- URL / URLSearchParams（使う分だけ） ----

class SearchParams {
  constructor(init = '', onChange = () => {}) {
    this.list = [];
    this.onChange = onChange;
    const s = String(init).replace(/^\?/, '');
    if (s) for (const pair of s.split('&')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      const dec = (x) => decodeURIComponent(x.replace(/\+/g, ' '));
      this.list.push(i < 0 ? [dec(pair), ''] : [dec(pair.slice(0, i)), dec(pair.slice(i + 1))]);
    }
  }
  get(k) { const f = this.list.find(([a]) => a === k); return f ? f[1] : null; }
  getAll(k) { return this.list.filter(([a]) => a === k).map(([, v]) => v); }
  has(k) { return this.list.some(([a]) => a === k); }
  set(k, v) {
    const i = this.list.findIndex(([a]) => a === k);
    if (i < 0) this.list.push([k, String(v)]);
    else { this.list[i] = [k, String(v)]; this.list = this.list.filter(([a], j) => a !== k || j === i); }
    this.onChange();
  }
  append(k, v) { this.list.push([k, String(v)]); this.onChange(); }
  delete(k) { this.list = this.list.filter(([a]) => a !== k); this.onChange(); }
  forEach(fn) { this.list.forEach(([k, v]) => fn(v, k)); }
  entries() { return this.list[Symbol.iterator](); }
  [Symbol.iterator]() { return this.list[Symbol.iterator](); }
  toString() { return this.list.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
}

const URL_RE = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;

class MiniURL {
  constructor(input, base) {
    let s = String(input);
    if (base && !URL_RE.test(s)) {
      const b = new MiniURL(base);
      s = s.startsWith('/') ? `${b.origin}${s}` : `${b.origin}${b.pathname.replace(/[^/]*$/, '')}${s}`;
    }
    const m = s.match(URL_RE);
    if (!m) throw new TypeError(`Invalid URL: ${s}`);
    this.protocol = m[1].toLowerCase();
    this.host = m[2].toLowerCase();
    this.pathname = m[3] || '/';
    this.hash = m[5] || '';
    this.searchParams = new SearchParams(m[4] || '');
  }
  get hostname() { return this.host.replace(/:\d+$/, '').replace(/^.*@/, ''); }
  get origin() { return `${this.protocol}//${this.host}`; }
  get search() { const q = this.searchParams.toString(); return q ? `?${q}` : ''; }
  set search(v) { this.searchParams = new SearchParams(v); }
  get href() { return `${this.origin}${this.pathname}${this.search}${this.hash}`; }
  toString() { return this.href; }
  toJSON() { return this.href; }
}

// ---- タイマー・中断 ----

function sleepThen(fn, ms) {
  if (ms > 0) Utilities.sleep(Math.min(ms, 30000));
  fn();
  return 0;
}

const neverAbort = () => ({ aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {}, throwIfAborted() {} });

// ---- fetch ----

function makeResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

const YT_PREFIX = 'https://www.googleapis.com/youtube/v3/';
const YT_SERVICE = { search: 'Search', videos: 'Videos', channels: 'Channels', playlistItems: 'PlaylistItems' };

/** 拡張サービスのエラー文から、youtube-kit が読める形の HTTP 応答を作る */
function youtubeError(e) {
  const msg = String(e && e.message || e);
  const status = /quota/i.test(msg) ? 403 : /not ?found|cannot be found/i.test(msg) ? 404 : /forbidden|disabled|permission/i.test(msg) ? 403 : 400;
  const reason = status === 403 && /quota/i.test(msg) ? 'quotaExceeded' : status === 404 ? 'notFound' : status === 403 ? 'forbidden' : 'badRequest';
  return makeResponse(status, JSON.stringify({ error: { code: status, errors: [{ reason }] } }));
}

function youtubeCall(url) {
  const method = url.pathname.split('/').pop();
  const svc = YT_SERVICE[method];
  if (!svc) return makeResponse(404, JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } }));
  const params = {};
  let part = 'snippet';
  for (const [k, v] of url.searchParams) {
    if (k === 'key') continue; // キーは使わない（本人の権限で呼ぶ）
    if (k === 'part') { part = v; continue; }
    params[k] = /^\d+$/.test(v) && k === 'maxResults' ? Number(v) : v;
  }
  try {
    const res = YouTube[svc].list(part, params);
    return makeResponse(200, JSON.stringify(res));
  } catch (e) {
    return youtubeError(e);
  }
}

const OPENAI = 'https://api.openai.com/v1/responses';

function openAiCall(init) {
  const key = PropertiesService.getUserProperties().getProperty('OPENAI_API_KEY');
  if (!key) return makeResponse(401, JSON.stringify({ error: { message: 'OpenAI のキーがありません' } }));
  const headers = { authorization: `Bearer ${key}` };
  const body = JSON.parse(init.body);
  body.background = true; // 長い調査はバックグラウンドで頼み、終わるまで待つ
  body.store = true;
  let res = UrlFetchApp.fetch(OPENAI, { method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true });
  let json = JSON.parse(res.getContentText() || '{}');
  const deadline = Date.now() + 4.5 * 60 * 1000;
  while (res.getResponseCode() < 300 && (json.status === 'queued' || json.status === 'in_progress') && Date.now() < deadline) {
    Utilities.sleep(8000);
    res = UrlFetchApp.fetch(`${OPENAI}/${json.id}`, { headers, muteHttpExceptions: true });
    json = JSON.parse(res.getContentText() || '{}');
  }
  if (json.status === 'queued' || json.status === 'in_progress') return makeResponse(504, JSON.stringify({ error: { message: 'timeout' } }));
  return makeResponse(res.getResponseCode(), JSON.stringify(json));
}

export async function gasFetch(input, init = {}) {
  const raw = typeof input === 'string' ? input : String(input.url ?? input);
  if (raw.startsWith(YT_PREFIX)) return youtubeCall(new MiniURL(raw));
  if (raw === OPENAI) return openAiCall(init);
  const res = UrlFetchApp.fetch(raw, { method: (init.method ?? 'get').toLowerCase(), headers: init.headers, payload: init.body, muteHttpExceptions: true });
  return makeResponse(res.getResponseCode(), res.getContentText());
}

export function installShims(g = globalThis) {
  if (typeof g.URL === 'undefined') g.URL = MiniURL;
  if (typeof g.URLSearchParams === 'undefined') g.URLSearchParams = SearchParams;
  if (typeof g.setTimeout === 'undefined') g.setTimeout = sleepThen;
  if (typeof g.clearTimeout === 'undefined') g.clearTimeout = () => {};
  if (typeof g.AbortSignal === 'undefined') g.AbortSignal = { timeout: neverAbort };
  if (typeof g.fetch === 'undefined') g.fetch = gasFetch;
  if (!Object.hasOwn) Object.hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
}

export { MiniURL, SearchParams };
