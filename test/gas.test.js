// スプレッドシート版（gas/dist/Code.js）を、偽の Apps Script 環境で最後まで動かす。
// 時計は通信のたびに進めて、「1回6分まで」で区切って続ける流れを通す。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { respond, FAKE_NOW } from './fake-youtube.js';

execFileSync('node', ['gas/build.mjs']);
const CODE = readFileSync('gas/dist/Code.js', 'utf8');

function fakeAppsScript() {
  let clock = FAKE_NOW;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  const tick = (ms) => { clock += ms; };

  const sheets = new Map();
  const order = [];
  const sheet = (name) => {
    const rows = [];
    const sh = {
      name, rows, hidden: false,
      getName: () => sh.name,
      setName: (n) => { sheets.delete(sh.name); sh.name = n; sheets.set(n, sh); return sh; },
      setColumnWidth: () => sh,
      getLastRow: () => rows.length,
      getRange: (r, c, nr = 1, nc = 1) => {
        const range = {
          getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')),
          setValues: (vals) => { vals.forEach((v, i) => { rows[r - 1 + i] = rows[r - 1 + i] ?? []; v.forEach((x, j) => { rows[r - 1 + i][c - 1 + j] = x; }); }); return range; },
          setFontSize: () => range, setFontWeight: () => range, setWrap: () => range,
        };
        return range;
      },
      deleteRow: (r) => rows.splice(r - 1, 1),
      appendRow: (v) => rows.push([...v]),
      hideSheet: () => { sh.hidden = true; },
      setFrozenRows: () => {}, hideColumns: () => {},
    };
    sheets.set(name, sh);
    order.push(sh);
    return sh;
  };
  sheet('シート1');
  const ss = { getSheetByName: (n) => sheets.get(n) ?? null, insertSheet: (n) => sheet(n), getSheets: () => order.slice(), setActiveSheet: () => {}, moveActiveSheet: () => {} };
  const menu = { addItem: () => menu, addSeparator: () => menu, addToUi: () => {} };

  const store = (m = new Map()) => ({ getProperty: (k) => m.get(k) ?? null, setProperty: (k, v) => m.set(k, String(v)), deleteProperty: (k) => m.delete(k) });
  const docProps = store();
  const userProps = store();

  const triggers = [];
  const counter = { calls: 0 };
  const call = (url) => { tick(1500); counter.calls += 1; return respond(url); }; // 通信1回で1.5秒進める

  const blob = (bytes, type) => ({
    bytes: Buffer.from(bytes),
    getBytes() { return this.bytes; },
    getDataAsString: function () { return this.bytes.toString('utf8'); },
    type,
  });

  const g = {
    console: { log: () => {} },
    Date: FakeDate,
    SpreadsheetApp: { getActive: () => ss, getUi: () => ({ createMenu: () => menu }) },
    PropertiesService: { getDocumentProperties: () => docProps, getUserProperties: () => userProps },
    LockService: { getDocumentLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ after: (ms) => ({ create: () => triggers.push({ fn, ms, getHandlerFunction: () => fn }) }) }) }),
    },
    Utilities: {
      sleep: (ms) => tick(ms),
      formatDate: (d, tz, fmt) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(d.getTime())),
      getUuid: () => '1234abcd-5678-90ef-aaaa-bbbbccccdddd',
      newBlob: (data, type) => blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, type),
      gzip: (b) => blob(zlib.gzipSync(b.getBytes()), 'application/x-gzip'),
      ungzip: (b) => blob(zlib.gunzipSync(b.getBytes()), 'application/octet-stream'),
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s) => Buffer.from(s, 'base64'),
    },
    UrlFetchApp: {
      fetch: (url) => {
        const r = call(url);
        return { getResponseCode: () => r.status, getContentText: () => r.text };
      },
    },
    // 拡張サービスは、失敗すると例外を投げる
    YouTube: Object.fromEntries(['Search', 'Videos', 'Channels', 'PlaylistItems'].map((svc) => [svc, {
      list: (part, params) => {
        const method = svc[0].toLowerCase() + svc.slice(1);
        const qs = new URLSearchParams({ part, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
        const r = call(`https://www.googleapis.com/youtube/v3/${method}?${qs}`);
        if (r.status >= 400) throw new Error(r.status === 404 ? 'API call to youtube.playlistItems.list failed with error: The playlist identified with the request\'s playlistId parameter cannot be found.' : 'API call failed with error: Bad Request');
        return JSON.parse(r.text);
      },
    }])),
    HtmlService: {},
  };
  return { g, triggers, sheets, docProps, userProps, counter, tick };
}

test('スプレッドシート版を、区切りながら最後まで動かせる', async () => {
  const env = fakeAppsScript();
  const { g } = env;
  const ctx = vm.createContext({ ...g });
  vm.runInContext(CODE, ctx);

  // 開いたときに、空の「シート1」が「使い方」になる
  ctx.onOpen();
  assert.ok(env.sheets.get('使い方'));
  assert.equal(env.sheets.get('シート1'), undefined);
  assert.match(env.sheets.get('使い方').rows[11][0], /結果を開く/);

  const run = ctx.startRun('AI BGM', 'jp');
  assert.equal(run.stage, 'expand');
  assert.equal(env.triggers.length, 1);

  let executions = 0;
  while (env.triggers.length) {
    executions += 1;
    assert.ok(executions < 200, '終わらない');
    const t = env.triggers.shift();
    env.tick(t.ms);
    await ctx[t.fn]();
    const status = ctx.getStatus();
    assert.notEqual(status.run.stage, 'error', JSON.stringify(status.run));
  }
  const status = ctx.getStatus();
  assert.equal(status.run.stage, 'done');
  assert.ok(executions >= 3, `区切りが効いていない（${executions}回）`);
  // 偽の YouTube はチャンネルが300しか無いので、新しいチャンネルが出なくなって早めに打ち切られる
  assert.ok(status.run.progress.searchCalls > 20, JSON.stringify(status.run.progress) + ' exec=' + executions + ' calls=' + env.counter.calls);

  // 結果は隠しシートに圧縮して残り、途中の状態は消えている
  const data = env.sheets.get('_data').rows;
  assert.ok(data.some((r) => r[0] === `html:${run.id}`));
  assert.ok(!data.some((r) => r[0] === `state:${run.id}`));
  assert.ok(data.every((r) => String(r[2]).length <= 45000));
  const html = vm.runInContext(`Shitami.loadBlob('html:${run.id}')`, ctx);
  assert.match(html, /まず見る3つ/);

  // 結果の一覧に1行
  const rows = env.sheets.get('結果').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'AI BGM');

  // 同じ日の2回目は断る
  assert.throws(() => ctx.startRun('lofi', 'en'), /今日の調べ切りはもう使いました/);
});
