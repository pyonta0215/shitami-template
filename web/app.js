// 画面の動き。調べ切りの計算はこのブラウザの中で回し、外への呼び出しはすべて Worker の中継（/api/*）を通す。
//
// 段が終わるたびに状態を IndexedDB に保存するので、タブを閉じても「続きから」で再開できる。
// APIキーはこの画面には来ない（Worker が付ける）。

import { newDeepState, runDeepStage, progressOf, STAGES, STAGE_TEXT } from '../src/deep/run.js';
import { renderDeepReport } from '../src/deep/report.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- 外への呼び出しを中継に差し替える ----

const YT = 'https://www.googleapis.com/youtube/v3/';
const SUGGEST = 'https://suggestqueries.google.com/complete/search';
const OPENAI = 'https://api.openai.com/v1/responses';

export function toProxyUrl(raw) {
  const u = new URL(raw);
  if (raw.startsWith(YT)) {
    u.searchParams.delete('key');
    return `/api/yt/${u.pathname.slice('/youtube/v3/'.length)}?${u.searchParams}`;
  }
  if (raw.startsWith(SUGGEST)) {
    const region = u.searchParams.get('gl') === 'us' ? 'en' : 'jp';
    return `/api/suggest?region=${region}&q=${encodeURIComponent(u.searchParams.get('q') ?? '')}`;
  }
  if (raw === OPENAI) return '/api/llm';
  throw new Error(`中継していない宛先: ${u.host}`);
}

async function proxyFetch(input, init = {}) {
  const raw = typeof input === 'string' ? input : input.url;
  const headers = new Headers(init.headers ?? {});
  headers.delete('authorization'); // キーは Worker が付ける
  return fetch(toProxyUrl(raw), { ...init, headers });
}

// ---- 途中の状態の保存（IndexedDB） ----

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('shitami', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('state', mode);
    const req = fn(tx.objectStore('state'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const loadState = (id) => idb('readonly', (s) => s.get(id)).catch(() => null);
const saveState = (state) => idb('readwrite', (s) => s.put(state, state.id));
const dropState = (id) => idb('readwrite', (s) => s.delete(id)).catch(() => {});

// ---- 画面 ----

// 地域ではなく「誰に見てもらうか」で聞く。検索候補と検索結果の並びがその視聴者の目線になる
const AUDIENCES = [
  { region: 'jp', label: '日本の人', hint: 'ふつうはこちら' },
  { region: 'en', label: '海外の人', hint: 'BGM など言葉の要らない動画向け' },
];

const STEP_LABEL = { expand: '広げる', discover: '見つける', deepen: '掘る', evidence: 'お金', analyze: 'まとめる' };

let status = null;
let running = false;

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function renderSteps(stage) {
  const idx = stage === 'done' ? STAGES.length : STAGES.indexOf(stage);
  $('steps').innerHTML = STAGES.map((s, i) =>
    `<li class="${i < idx ? 'on' : i === idx ? 'now' : ''}">${STEP_LABEL[s]}</li>`).join('');
}

function renderProgress(state, line = '') {
  const p = progressOf(state);
  renderSteps(state.next);
  $('progress').hidden = false;
  $('stageText').textContent = STAGE_TEXT[state.next] ?? '';
  $('numbers').textContent = `検索 ${p.searchCalls}回 ・ チャンネル ${p.channels}件 ・ 動画 ${p.videos}本`;
  if (line) $('log').textContent = line;
}

function renderNotices() {
  const notes = [];
  if (!status.access) notes.push('<b>鍵がかかっていません。</b>この URL を知っている人なら誰でも開けます。README の手順5で Cloudflare Access を設定してください。');
  if (!status.youtube) notes.push('<b>YouTube の APIキーが未設定です。</b>README の手順3で設定してください。');
  $('notices').innerHTML = notes.map((n) => `<p class="notice">${n}</p>`).join('');
  $('llmNote').textContent = status.llm
    ? 'お金の根拠と反証を Web で調べます（OpenAI・1回 約7円）'
    : 'OpenAI のキーが無いので、お金の根拠と反証の欄は空になります（任意）';
  $('quota').textContent = `今日の YouTube 検索: ${status.search.used} / ${status.search.cap} 回`;
}

async function renderHistory() {
  const { ok, body } = await api('/api/results');
  if (!ok || !body.items?.length) { $('history').hidden = true; return; }
  $('history').hidden = false;
  $('historyList').innerHTML = body.items.map((x) =>
    `<li><a href="/r/${esc(x.id)}/">${esc(x.theme)}</a> <small>${esc(x.regionLabel)} ・ ${esc(x.date)}</small></li>`).join('');
}

async function refresh() {
  const r = await api('/api/status');
  if (!r.ok) { $('error').textContent = r.body.error ?? '状態を読めませんでした'; return; }
  status = r.body;
  renderNotices();
  const run = status.run;
  if (run && !running) {
    const saved = await loadState(run.id);
    $('theme').value = run.theme;
    document.querySelector(`input[name=region][value=${run.region}]`).checked = true;
    if (saved && saved.next !== 'done') {
      $('go').textContent = '続きから調べる';
      renderProgress(saved, 'この端末に途中までの結果があります');
    } else if (!saved) {
      $('go').textContent = '今日の分は使いました';
      $('go').disabled = true;
      $('used').hidden = false;
      $('todayLink').href = `/r/${run.id}/`;
      $('todayLink').textContent = `今日の結果「${run.theme}」を開く`;
    }
  }
  renderHistory();
}

async function start(e) {
  e.preventDefault();
  if (running) return;
  $('error').textContent = '';
  const theme = $('theme').value.trim();
  const region = document.querySelector('input[name=region]:checked').value;
  const r = await api('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme, region }) });
  if (!r.ok) { $('error').textContent = r.body.error ?? '始められませんでした'; return; }
  const run = r.body.run;

  running = true;
  $('go').disabled = true;
  const wake = await navigator.wakeLock?.request('screen').catch(() => null);
  window.onbeforeunload = () => '調べている途中です';
  try {
    let state = (await loadState(run.id)) ?? newDeepState({ id: run.id, theme: run.theme, region: run.region, date: run.date });
    renderProgress(state);
    while (state.next !== 'done') {
      await runDeepStage(state, {
        youtubeApiKey: 'via-worker',
        openAiApiKey: 'via-worker',
        withEvidence: status.llm,
        fetchImpl: proxyFetch,
        log: (m) => renderProgress(state, m),
      });
      await saveState(state);
      renderProgress(state);
    }
    const html = renderDeepReport(state.result);
    const saved = await api(`/api/results/${run.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html, result: state.result }) });
    if (!saved.ok) throw Object.assign(new Error('save'), { kind: 'save' });
    await dropState(run.id);
    renderSteps('done');
    $('stageText').textContent = 'できました';
    $('done').hidden = false;
    $('open').href = saved.body.url;
  } catch (err) {
    const quota = err?.kind === 'quota-exceeded' || /quota/i.test(String(err?.message));
    $('error').textContent = quota
      ? 'YouTube の1日の枠を使い切りました。日本時間の16〜17時以降に「続きから調べる」を押してください。'
      : '途中で止まりました。もう一度押すと、止まった段から続けます。';
    $('go').disabled = false;
    $('go').textContent = '続きから調べる';
  } finally {
    running = false;
    window.onbeforeunload = null;
    wake?.release?.();
    refresh();
  }
}

if (typeof document !== 'undefined') {
  $('form').addEventListener('submit', start);
  $('regions').innerHTML = AUDIENCES.map((a, i) =>
    `<input type="radio" name="region" id="r-${a.region}" value="${a.region}"${i === 0 ? ' checked' : ''}><label for="r-${a.region}">${esc(a.label)}<small>${esc(a.hint)}</small></label>`).join('');
  refresh();
}
