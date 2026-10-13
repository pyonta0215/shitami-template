import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDeepState, runDeepStage } from '../src/deep/run.js';
import { createFakeFetch, FAKE_NOW } from './fake-youtube.js';

async function runAll({ stopEvery = 0 } = {}) {
  const counter = { calls: 0 };
  const fetchImpl = createFakeFetch({ counter });
  const state = newDeepState({ id: 'test', theme: 'AI BGM', region: 'jp', date: '2026-10-10', now: FAKE_NOW });
  let runs = 0;
  while (state.next !== 'done') {
    runs += 1;
    assert.ok(runs < 500, '終わらない');
    const startCalls = counter.calls;
    // 1回の実行で stopEvery 回呼んだら区切る（Apps Script の6分の代わり）
    const shouldStop = stopEvery ? () => counter.calls - startCalls >= stopEvery : undefined;
    // 状態は実行のたびに JSON を通す（保存して読み直すのと同じ）
    const fresh = JSON.parse(JSON.stringify(state));
    await runDeepStage(fresh, { youtubeApiKey: 'k', openAiApiKey: 'k', withEvidence: false, fetchImpl, now: FAKE_NOW, shouldStop, log: () => {} });
    Object.assign(state, fresh);
  }
  return { state, runs };
}

test('区切りながら進めても、一度に進めたときと同じ検索・同じ結果になる', async () => {
  const once = await runAll();
  const split = await runAll({ stopEvery: 25 });
  assert.ok(split.runs > once.runs + 5, `区切りが効いていない（${split.runs}回）`);
  assert.equal(split.state.quota.searchCalls, once.state.quota.searchCalls);
  assert.deepEqual(split.state.searches.map((s) => `${s.cut}|${s.q}|${s.videoDuration}`), once.state.searches.map((s) => `${s.cut}|${s.q}|${s.videoDuration}`));
  assert.deepEqual(Object.keys(split.state.uploads).sort(), Object.keys(once.state.uploads).sort());
  assert.deepEqual(split.state.copyCandidates, once.state.copyCandidates);
  const pick = (r) => ({ niches: r.deep.niches.map((n) => n.term), anglers: r.deep.anglers.map((a) => a.channel_id), wall: r.deep.outliers.wall.map((o) => o.video_id) });
  assert.deepEqual(pick(split.state.result), pick(once.state.result));
  assert.ok(once.state.result.deep.niches.length > 0);
});
