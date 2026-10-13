import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSaturated, CUTS, EXTRA_BUDGET, SEARCH_BUDGET, ptDate } from '../src/deep/plan.js';
import { clusterTerms, modifierTokens } from '../src/deep/expand.js';
import { classifyLinks, hasMoney } from '../src/deep/links.js';
import { channelBaselines, multiplierOf } from '../src/deep/metrics.js';
import { titlePattern, clones, killCheck } from '../src/deep/analyze.js';
import { newDeepState, runDeepStage } from '../src/deep/run.js';
import { planSummary } from '../src/deep/plan.js';

test('配分の合計は発見の予算と一致する', () => {
  assert.equal(CUTS.reduce((s, c) => s + c.budget, 0) + EXTRA_BUDGET, SEARCH_BUDGET);
});

test('飽和: 基準4回のあと2回で新しく出たのが5%以下なら止める', () => {
  const base = [30, 25, 20, 25].map((n) => ({ newChannels: n })); // 基準100
  assert.equal(isSaturated(base), false);
  assert.equal(isSaturated([...base, { newChannels: 3 }, { newChannels: 2 }]), true); // 5/100
  assert.equal(isSaturated([...base, { newChannels: 4 }, { newChannels: 2 }]), false); // 6/100
  assert.equal(isSaturated([0, 0, 0, 0, 0, 0].map((n) => ({ newChannels: n }))), true);
});

test('太平洋時間の日付で数える', () => {
  assert.equal(ptDate(Date.parse('2026-10-08T06:00:00Z')), '2026-10-07'); // PDT 23:00
  assert.equal(ptDate(Date.parse('2026-10-08T08:00:00Z')), '2026-10-08');
});

test('クラスタは修飾語の先頭で分かれ、代表語は出現回数の多い語', () => {
  assert.deepEqual(modifierTokens('作業用bgm 秋', 'bgm'), ['作業用', '秋']);
  const terms = [
    { term: '作業用bgm 秋', hits: 3, intents: ['viewer'] },
    { term: '作業用bgm', hits: 5, intents: ['viewer'] },
    { term: 'bgm 作り方', hits: 4, intents: ['maker'] },
  ];
  const c = clusterTerms(terms, 'bgm');
  assert.equal(c[0].key, '作業用');
  assert.equal(c[0].rep, '作業用bgm');
  assert.equal(c[0].hits, 8);
  assert.equal(c[1].key, '作り方');
});

test('説明欄のリンクを販売・アフィリエイト・提供に分ける。素材の購入はお金の流れに数えない', () => {
  assert.deepEqual(classifyLinks('楽曲はこちら https://booth.pm/ja/items/1 #PR'), ['sales', 'sponsor']);
  assert.deepEqual(classifyLinks('使用機材 https://amzn.to/abc'), ['affiliate']);
  assert.equal(hasMoney(classifyLinks('BGM: https://www.epidemicsound.com/x')), false);
  assert.deepEqual(classifyLinks('https://www.youtube.com/@foo/join で応援'), ['membership']);
});

test('倍率はチャンネル内の同じ形式の中央値と比べ、公開直後と本数不足は出さない', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const old = '2026-08-01T00:00:00Z';
  const vids = [100, 120, 90, 110, 100, 1000].map((views, i) => ({ id: `v${i}`, fmt: 'long', pub: old, views }));
  const base = channelBaselines(vids, now);
  assert.equal(base.long.median, 105);
  assert.equal(base.short, null);
  assert.equal(multiplierOf(vids[5], base, now), 9.5);
  assert.equal(multiplierOf({ fmt: 'long', pub: '2026-09-25T00:00:00Z', views: 5000 }, base, now), null);
});

test('題名の型は3割以上に出る記号と言い回し', () => {
  const p = titlePattern(['【作業用】雨の日 lofi', '【作業用】夜 lofi', '朝のジャズ']);
  assert.ok(p.some((x) => x.token === '【作業用】'));
  assert.ok(p.some((x) => x.token === 'lofi'));
});

test('名前の似たチャンネルが3つ以上あれば量産型として数える', () => {
  const state = { channels: { a: { title: 'Soft Rain Ambience' }, b: { title: 'Soft Rain Ambience 2' }, c: { title: 'softrain ambience jp' }, d: { title: 'Other' } } };
  assert.equal(clones(state)[0].count, 3);
});

test('撤退条件の判定', () => {
  const k = killCheck(planSummary(), {
    anglers: [{ copyable: false }],
    outl: { concentration: 0.8 },
    niches: [{ catchMedian: 500 }],
    money: { outliersWithMoney: 0.05 },
  });
  assert.ok(k.every((x) => x.hit));
});

// ---- 段を通しで動かす（API は偽物） ----

function fakeWorld() {
  const now = Date.parse('2026-10-08T00:00:00Z');
  const day = 86400000;
  const channels = Array.from({ length: 80 }, (_, i) => ({
    id: `UC${String(i).padStart(22, '0')}`,
    title: i % 10 === 0 ? `Lofi Rain Cafe ${i}` : `channel ${i}`,
    subs: i < 5 ? 2e6 : 500 + i * 300,
    pub: new Date(now - (i % 2 ? 300 : 1500) * day).toISOString(),
  }));
  const videos = [];
  for (const [ci, c] of channels.entries()) {
    for (let j = 0; j < 30; j += 1) {
      videos.push({
        id: `v${ci}_${j}`, ch: c.id, chTitle: c.title,
        title: j % 3 ? `【作業用】lofi ${j}` : `lofi study ${j}`,
        pub: new Date(now - (j * 12 + 5) * day).toISOString(),
        dur: j % 4 ? 3600 : 40,
        views: j === 3 ? 50000 + ci * 100 : 1000 + ci * 10 + j,
        description: j === 3 ? 'https://booth.pm/x' : '',
      });
    }
  }
  const byId = new Map(videos.map((v) => [v.id, v]));
  const iso = (s) => `PT${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}H` : ''}${Math.floor((s % 3600) / 60) ? `${Math.floor((s % 3600) / 60)}M` : ''}${s % 60 ? `${s % 60}S` : ''}`;
  let searchN = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.hostname === 'suggestqueries.google.com') {
      const q = u.searchParams.get('q');
      return body([q, ['lofi study', 'lofi 作業用', 'lofi 雨', 'lofi jazz cafe', `${q} music`.slice(0, 40)]]);
    }
    const method = u.pathname.split('/').pop();
    if (method === 'search') {
      searchN += 1;
      // 呼ぶたびに少しずつ違うチャンネルが出る
      const start = (searchN * 7) % 60;
      const items = channels.slice(start, start + 20).map((c, k) => ({ id: { videoId: `v${channels.indexOf(c)}_${k % 30}` }, snippet: { channelId: c.id, title: '', channelTitle: c.title, publishedAt: '' } }));
      return body({ items, pageInfo: { totalResults: 100000 } });
    }
    if (method === 'videos') {
      const ids = u.searchParams.get('id').split(',');
      return body({ items: ids.map((id) => byId.get(id)).filter(Boolean).map((v) => ({ id: v.id, snippet: { channelId: v.ch, channelTitle: v.chTitle, title: v.title, description: v.description, publishedAt: v.pub }, contentDetails: { duration: iso(v.dur) }, statistics: { viewCount: String(v.views) } })) });
    }
    if (method === 'channels') {
      const ids = u.searchParams.get('id').split(',');
      return body({ items: channels.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, snippet: { title: c.title, publishedAt: c.pub }, statistics: { subscriberCount: String(c.subs), videoCount: '30' }, contentDetails: { relatedPlaylists: { uploads: `UU${c.id.slice(2)}` } } })) });
    }
    if (method === 'playlistItems') {
      const pl = u.searchParams.get('playlistId');
      const ch = `UC${pl.replace(/^(UULF|UUSH|UU)/, '')}`;
      const ci = channels.findIndex((c) => c.id === ch);
      const vids = videos.filter((v) => v.ch === ch).filter((v) => (pl.startsWith('UULF') ? v.dur > 180 : pl.startsWith('UUSH') ? v.dur <= 180 : true));
      return body({ items: ci < 0 ? [] : vids.map((v) => ({ contentDetails: { videoId: v.id } })) });
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { now, fetchImpl };
}

test('段を通しで進めると、配分の上限を守って結果ができる', async () => {
  const { now, fetchImpl } = fakeWorld();
  let state = newDeepState({ id: 'abcdefghijkl', theme: 'lofi', region: 'en', date: '2026-10-08', now });
  while (state.next !== 'done') {
    state = await runDeepStage(state, { youtubeApiKey: 'k', withEvidence: false, fetchImpl, now });
    state = JSON.parse(JSON.stringify(state)); // 段の間で保存・読み直しをしても続けられる
  }
  const r = state.result;
  assert.ok(r.quota.searchCalls <= 85);
  assert.ok(r.searches.filter((s) => s.ok).length <= SEARCH_BUDGET);
  assert.ok(r.quota.units < 5000);
  assert.ok(r.deep.map.rows.length > 0);
  assert.ok(r.deep.niches.length > 0);
  assert.ok(r.deep.anglers.length > 0);
  assert.ok(r.deep.outliers.total > 0);
  assert.ok(r.handoff.human.length >= 5);
  assert.ok(r.deep.money.outliersWithMoney > 0);
  // 優先度の高い順
  const p = r.handoff.human.map((t) => t.priority);
  assert.deepEqual(p, [...p].sort((a, b) => b - a));
});

test('テーマの語がすべて題名に入っている動画だけをテーマの動画と数える', async () => {
  const { onTheme } = await import('../src/deep/analyze.js');
  assert.equal(onTheme('【作業用】AI BGM 1時間', 'AI BGM'), true);
  assert.equal(onTheme('ＡＩで作ったＢＧＭ', 'AI BGM'), true); // 全角も揃える
  assert.equal(onTheme('生成AIのニュース', 'AI BGM'), false);
});
