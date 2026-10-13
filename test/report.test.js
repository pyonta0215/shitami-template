import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, summarize } from '../src/report.js';

const row = (keyword, verdict, intents = []) => ({ keyword, verdict, intents, sampled: 50, recent_count: 20 });

test('一番多い判定の語が全部同じ意図なら、要点の1行に書き添える', () => {
  const s = summarize([
    row('ai bgm 作り方', 'crowded', ['maker']),
    row('ai bgm 自動生成 無料', 'crowded', ['maker', 'price']),
    row('ai bgm 稼ぐ', 'crowded', ['maker']),
    row('ai bgm stream', 'target', ['viewer']),
  ]);
  assert.equal(s.top.verdict, 'crowded');
  assert.equal(s.top.count, 3);
  assert.equal(s.sharedIntent, 'maker');
  assert.equal(s.line, '測った4語のうち3語が「席が埋まっている」。その3語は、すべて「作る側（作り方・収益化）」の語');
});

test('意図がそろっていなければ、判定の数だけを書く', () => {
  const s = summarize([row('lofi beats', 'target', ['viewer']), row('lofi girl', 'target'), row('lofi asmr', 'crowded', ['viewer'])]);
  assert.equal(s.sharedIntent, null);
  assert.equal(s.line, '測った3語のうち2語が「入り込む余地あり」');
});

test('同数のときはどちらかに寄せず、内訳を並べる', () => {
  const s = summarize([row('a', 'crowded', ['maker']), row('b', 'crowded', ['maker']), row('c', 'target'), row('d', 'target')]);
  assert.equal(s.tie, true);
  assert.equal(s.sharedIntent, null);
  assert.equal(s.line, '測った4語の内訳: 「入り込む余地あり」2語、「席が埋まっている」2語');
});

test('全語が同じ判定なら「すべて」と書く', () => {
  assert.equal(summarize([row('a', 'gap'), row('b', 'gap')]).line, '測った2語すべてが「直近の動画がほぼ無い」');
});

test('供給が無い・根拠を調べていない1枚は「記録なし」になり、「やるべき」とは書かない', () => {
  const html = renderReport({
    theme: 'x', regionLabel: '日本', date: '2026-09-24',
    demand: { terms: [], intentTotals: {}, uniqueTerms: 0, onThemeTerms: 0 },
    supply: [],
    evidence: { ok: false, reason: '調べていません' },
    quota: { searchCalls: 0 },
  });
  assert.equal(summarize([]), null);
  assert.match(html, /席の空きは記録なし/);
  assert.match(html, /<b>記録なし<\/b><span>お金の根拠<\/span>/);
  assert.doesNotMatch(html, /やるべき|やめるべき|おすすめします/);
});

test('検索結果の壁はサムネを直接表示し、回っている動画に枠を付け、因果は言い切らない', () => {
  const v = (id, extra) => ({ video_id: id, title: id, channel: 'ch', subscribers: 1000, views: 5000, age_days: 30, duration_seconds: 125, is_short: false, is_live: false, ratio: 2.5, channel_age_days: 40, ...extra });
  const html = renderReport({
    theme: 'x', regionLabel: '日本', date: '2026-09-28',
    demand: { terms: [], intentTotals: {}, uniqueTerms: 0, onThemeTerms: 0 },
    supply: [{ ...row('x bgm', 'target'), leaders: [], wall: [v('hot1'), v('cold1', { ratio: 0.2, channel_age_days: 900 }), v('hidden1', { subscribers: null, ratio: null, channel_age_days: 900 })] }],
    evidence: { ok: false, reason: '調べていません' },
  });
  assert.match(html, /https:\/\/i\.ytimg\.com\/vi\/hot1\/mqdefault\.jpg/);
  assert.equal((html.match(/class="tile is-hot"/g) ?? []).length, 1);
  assert.match(html, /開設2ヶ月目の動画/);
  assert.match(html, /2:05/);
  assert.match(html, /伸びた理由がサムネだとは限りません/);
});
