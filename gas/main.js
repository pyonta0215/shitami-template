// スプレッドシート版の本体。メニューとサイドバーから調べ切りを始め、時間で動くトリガーで段を進める。
//
// Apps Script は1回の実行が6分まで。4分半で区切り、状態をシートに保存して、少し後に続きを動かす。
// YouTube は本人の Google アカウントの権限（YouTube 拡張サービス）で呼ぶので、APIキーは要らない。
// 無料枠は本人のアカウントごとに1日 10,000 units（検索100回）。調べ切りは1回で最大85回使うので、1日1回にしている。

/* global SpreadsheetApp, PropertiesService, ScriptApp, LockService, Utilities, HtmlService, YouTube */

import { installShims, gasFetch } from './shim.js';
import { newDeepState, runDeepStage, progressOf, STAGE_TEXT } from '../src/deep/run.js';
import { renderDeepReport } from '../src/deep/report.js';
import { REGIONS } from '../src/demand.js';

installShims();

const SLICE_MS = 4.5 * 60 * 1000;     // 1回の実行で使う時間（上限6分）
const EVIDENCE_START_MS = 40 * 1000;  // Web 調査（最大4分半）は、実行の最初のほうでしか始めない
const RESULT_DAYS = 30;               // YouTube API の規約に合わせて、結果は30日で消す
const DATA_SHEET = '_data';
const RESULT_SHEET = '結果';
const CHUNK = 45000;                  // セル1つは5万文字まで

const props = () => PropertiesService.getDocumentProperties();
const ptDay = (d = new Date()) => Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
const jstDay = (d = new Date()) => Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');

function readJson(key) {
  const v = props().getProperty(key);
  return v ? JSON.parse(v) : null;
}
const writeJson = (key, value) => props().setProperty(key, JSON.stringify(value));
const STALE_MS = 12 * 60 * 1000; // これだけ進みが無ければ、自動の続きが途切れたとみなす
const saveRun = (run) => writeJson('run', { ...run, updatedAt: Date.now() });

// ---- 大きなデータの置き場所（隠しシートに、圧縮して分けて書く） ----

function dataSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DATA_SHEET);
    sh.hideSheet();
  }
  return sh;
}

function deleteBlob(key) {
  const sh = dataSheet();
  const n = sh.getLastRow();
  if (!n) return;
  const keys = sh.getRange(1, 1, n, 1).getValues();
  for (let i = n - 1; i >= 0; i--) if (keys[i][0] === key) sh.deleteRow(i + 1);
}

export function saveBlob(key, text) {
  deleteBlob(key);
  const packed = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(text, 'application/json')).getBytes());
  const rows = [];
  for (let i = 0; i < packed.length; i += CHUNK) rows.push([key, rows.length, packed.slice(i, i + CHUNK)]);
  const sh = dataSheet();
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
}

export function loadBlob(key) {
  const sh = dataSheet();
  const n = sh.getLastRow();
  if (!n) return null;
  const rows = sh.getRange(1, 1, n, 3).getValues().filter((r) => r[0] === key).sort((a, b) => a[1] - b[1]);
  if (!rows.length) return null;
  const bytes = Utilities.base64Decode(rows.map((r) => r[2]).join(''));
  return Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString('UTF-8');
}

// ---- 画面 ----

export function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('shitami')
    .addItem('調べ切る', 'showSidebar')
    .addItem('結果を開く', 'showResults')
    .addSeparator()
    .addItem('OpenAI のキーを設定（任意）', 'setOpenAiKey')
    .addToUi();
  ensureGuide();
  cleanup();
}

const GUIDE_SHEET = '使い方';
const GUIDE = [
  ['shitami ・ 調べ切り（需要の下見）'],
  [''],
  ['YouTube で始めたいテーマを1つ入れると、① 投稿者は少ないのに見られている「穴場」と、② 後から入って伸びた「真似先」を探します。'],
  ['「やるべき／やめるべき」は書きません。判断の材料です。'],
  [''],
  ['■ 調べる'],
  ['1. メニューの「shitami」→「調べ切る」（初回だけ Google の承認画面が出ます）'],
  ['2. 右に出る画面でテーマを入れ、「誰に見てもらう動画？」を選んで「調べ切る」'],
  ['3. 15〜30分ほどで終わります。シートを閉じても裏で続きます'],
  [''],
  ['■ 結果を見る・見返す'],
  ['・メニューの「shitami」→「結果を開く」で、過去の結果を一覧から開けます（パソコンのブラウザで）'],
  ['・「結果」シートには、日付・テーマ・穴場の1位・真似先の1位が残ります（スマホのシートアプリでも見られます）'],
  ['・結果は30日で自動的に消えます（YouTube API の規約に合わせています）'],
  [''],
  ['■ 1日1回だけです'],
  ['YouTube の無料枠では検索が1日100回までで、1回の調べ切りで最大85回使います。枠は日本時間の16時（11月〜3月は17時）に戻ります。'],
  [''],
  ['■ 任意'],
  ['「shitami」→「OpenAI のキーを設定」でキーを入れると、お金が動いている根拠と反証を Web で調べる欄が埋まります（1回 約7円）。'],
  [''],
  ['この道具は、作者がノウハウ図書館の記事やオフ会などで見聞きした内容を、自分なりに噛み砕いて形にしたものです。結果は収益や成果を約束するものではありません。非公式の道具です。'],
];

/** 最初の空のシートを「使い方」にする（無ければ作る）。すでにあれば何もしない */
function ensureGuide() {
  const ss = SpreadsheetApp.getActive();
  if (ss.getSheetByName(GUIDE_SHEET)) return;
  const blank = ss.getSheets().find((sh) => sh.getName() !== RESULT_SHEET && sh.getName() !== DATA_SHEET && sh.getLastRow() === 0);
  const sh = blank ?? ss.insertSheet(GUIDE_SHEET, 0);
  sh.setName(GUIDE_SHEET);
  sh.getRange(1, 1, GUIDE.length, 1).setValues(GUIDE);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.setColumnWidth(1, 640);
  sh.getRange(1, 1, GUIDE.length, 1).setWrap(true);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);
}

export function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('shitami ・ 調べ切り');
  SpreadsheetApp.getUi().showSidebar(html);
}

export function showResults() {
  const rows = listResults();
  const items = rows.length
    ? rows.map((r) => `<li><a href="#" onclick="google.script.run.openResult('${r.id}');return false;">${esc(r.theme)}</a> <small>${esc(r.audience)} ・ ${esc(r.date)}</small></li>`).join('')
    : '<li>まだ結果がありません。メニューの「調べ切る」から始めてください。</li>';
  const html = HtmlService.createHtmlOutput(`<style>body{font:14px/1.8 sans-serif;margin:12px}li{margin:4px 0}small{color:#59636e}</style><p>結果は30日で消えます。</p><ul>${items}</ul>`)
    .setWidth(420).setHeight(360);
  SpreadsheetApp.getUi().showModalDialog(html, '結果を開く');
}

export function openResult(id) {
  const html = loadBlob(`html:${id}`);
  if (!html) {
    SpreadsheetApp.getUi().alert('30日を過ぎたか、見つかりません。');
    return;
  }
  const out = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(out, '調べ切りの結果');
}

export function setOpenAiKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('OpenAI のキー（任意）', 'お金が動いている根拠と反証を Web で調べる欄に使います（1回 約7円）。空のまま OK を押すと削除します。\nキーはあなたの Google アカウントの中にだけ保存され、このシートを共有しても他の人には見えません。', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  const up = PropertiesService.getUserProperties();
  if (key) up.setProperty('OPENAI_API_KEY', key);
  else up.deleteProperty('OPENAI_API_KEY');
  ui.alert(key ? '保存しました。' : '削除しました。');
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- サイドバーから呼ぶ ----

export function getStatus() {
  const run = readJson('run');
  const today = ptDay();
  const active = run && run.stage !== 'done' && run.stage !== 'error';
  return {
    today,
    // 今日の実行か、日をまたいで続いている実行だけを見せる
    run: run && (run.day === today || active) ? { ...run, stageText: STAGE_TEXT[run.stage] ?? '', stale: Boolean(active && Date.now() - (run.updatedAt ?? 0) > STALE_MS) } : null,
    llm: Boolean(PropertiesService.getUserProperties().getProperty('OPENAI_API_KEY')),
  };
}

/** 自動の続きが途切れたとき・途中で止まったときに、保存した段から続ける */
export function resumeRun() {
  const run = readJson('run');
  if (!run || run.stage === 'done') throw new Error('続ける調べ切りがありません');
  if (!loadBlob(`state:${run.id}`)) throw new Error('途中の記録が見つかりません');
  saveRun({ ...run, stage: run.lastStage ?? run.stage, error: null });
  schedule(1000);
  return true;
}

export function startRun(theme, region) {
  theme = String(theme ?? '').trim();
  if (!theme || theme.length > 40) throw new Error('テーマを1〜40文字で入れてください');
  if (!REGIONS[region]) throw new Error('誰に見てもらうかを選んでください');
  const lock = LockService.getDocumentLock();
  lock.waitLock(10000);
  try {
    const today = ptDay();
    const prev = readJson('run');
    if (prev && prev.stage !== 'done' && prev.stage !== 'error') throw new Error('調べている途中です。終わるまでお待ちください');
    if (prev && prev.stage === 'error' && prev.day === today) throw new Error('今日の調べ切りは途中で止まっています。「続きから調べる」を押してください');
    if (prev && prev.day === today) throw new Error('今日の調べ切りはもう使いました。日本時間の16時（11月〜3月は17時）に戻ります');

    // 1 unit だけ使って、YouTube を呼べるか確かめる（権限や枠の問題で1日分を空回りさせない）
    try {
      YouTube.Videos.list('id', { id: 'dQw4w9WgXcQ' });
    } catch (e) {
      throw new Error(/quota/i.test(String(e.message)) ? '今日の YouTube の枠を使い切っています' : 'YouTube を呼べませんでした。メニューから開き直して、承認を済ませてください');
    }

    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const state = newDeepState({ id, theme, region, date: jstDay() });
    saveBlob(`state:${id}`, JSON.stringify(state));
    const run = { id, theme, region, day: today, date: state.date, stage: state.next, progress: progressOf(state), startedAt: new Date().toISOString() };
    saveRun(run);
    schedule(1000);
    return run;
  } finally {
    lock.releaseLock();
  }
}

// ---- トリガーで段を進める ----

function schedule(ms) {
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === 'continueRun') ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('continueRun').timeBased().after(ms).create();
}

export async function continueRun() {
  const started = Date.now();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(1000)) return; // 前の実行がまだ動いている
  const run = readJson('run');
  try {
    if (!run || run.stage === 'done' || run.stage === 'error') return;
    const raw = loadBlob(`state:${run.id}`);
    if (!raw) throw new Error('state-missing');
    const state = JSON.parse(raw);
    const withEvidence = Boolean(PropertiesService.getUserProperties().getProperty('OPENAI_API_KEY'));
    const shouldStop = () => Date.now() - started > SLICE_MS;

    while (state.next !== 'done') {
      if (shouldStop()) break;
      if (state.next === 'evidence' && withEvidence && Date.now() - started > EVIDENCE_START_MS) break;
      await runDeepStage(state, {
        youtubeApiKey: 'apps-script', // 使わない（拡張サービスで本人の権限で呼ぶ）
        openAiApiKey: 'apps-script',
        withEvidence,
        fetchImpl: gasFetch,
        shouldStop,
      });
      Object.assign(run, { stage: state.next, progress: progressOf(state) });
      saveRun(run);
    }

    if (state.next !== 'done') {
      saveBlob(`state:${run.id}`, JSON.stringify(state));
      saveRun(run);
      schedule(5000);
      return;
    }
    finish(run, state);
  } catch (e) {
    const quota = e && (e.kind === 'quota-exceeded' || /quota/i.test(String(e.message)));
    if (run) saveRun({ ...run, lastStage: run.stage, stage: 'error', error: quota ? 'YouTube の1日の枠を使い切りました。日本時間の16時（11月〜3月は17時）以降に、もう一度お試しください' : '途中で止まりました。もう一度お試しください' });
    console.log(JSON.stringify({ error: e && e.name, kind: e && e.kind }));
  } finally {
    lock.releaseLock();
  }
}

function finish(run, state) {
  const r = state.result;
  saveBlob(`html:${run.id}`, renderDeepReport(r));
  deleteBlob(`state:${run.id}`);
  const niche = r.deep.niches.find((n) => !n.tiny);
  const copy = r.deep.anglers.find((a) => a.copyable) ?? r.deep.anglers[0];
  resultSheet().appendRow([r.date, r.theme, run.region === 'en' ? '海外の人' : '日本の人', niche ? niche.term : '—', copy ? copy.title : '—', run.id]);
  saveRun({ ...run, stage: 'done', progress: progressOf(state), finishedAt: new Date().toISOString() });
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === 'continueRun') ScriptApp.deleteTrigger(t);
}

// ---- 結果の一覧と、30日で消す ----

function resultSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(RESULT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RESULT_SHEET);
    sh.appendRow(['日付', 'テーマ', '誰向け', '穴場の1位', '真似先の1位', 'id']);
    sh.setFrozenRows(1);
    sh.hideColumns(6);
  }
  return sh;
}

function listResults() {
  const sh = resultSheet();
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 6).getValues().map((r) => ({ date: Utilities.formatDate(new Date(r[0]), 'Asia/Tokyo', 'yyyy-MM-dd'), theme: r[1], audience: r[2], id: r[5] })).reverse();
}

export function cleanup() {
  const sh = resultSheet();
  const n = sh.getLastRow();
  if (n < 2) return;
  const limit = Date.now() - RESULT_DAYS * 86400000;
  const rows = sh.getRange(2, 1, n - 1, 6).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (new Date(rows[i][0]).getTime() < limit) {
      deleteBlob(`html:${rows[i][5]}`);
      sh.deleteRow(i + 2);
    }
  }
}
