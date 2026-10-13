import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, scoreSupply } from '../src/supply.js';

test('判定は Radar と同じ境界で分かれる', () => {
  assert.equal(judge({ sampled: 5, recent: 5, level: 2, total: 1e6 }), 'thin');
  assert.equal(judge({ sampled: 50, recent: 3, level: null, total: 1e6 }), 'gap');
  assert.equal(judge({ sampled: 50, recent: 20, level: null, total: 1e6 }), 'unknown');
  assert.equal(judge({ sampled: 50, recent: 20, level: 1, total: 1e6 }), 'target');
  assert.equal(judge({ sampled: 50, recent: 20, level: 0.5, total: 1e6 }), 'crowded');
});

test('本数が足りない形式にはスコアを付けない', () => {
  const s = scoreSupply({ sampled: 50, recent_count: 20, recent_short_count: 2, recent_long_count: 18, median_short: 1e6, median_long: 60000, rival_median_subs: 10000, total_results: 1e6 });
  assert.equal(s.score_short, null);
  assert.equal(s.best_format, 'long');
  assert.equal(s.verdict, 'target'); // 60000 / 11000 = 5.45 ≥ 5
});

test('ライブ配信（再生時間0秒）は Shorts にも通常動画にも数えない', async () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const recentIso = '2026-09-01T00:00:00Z';
  const videos = [
    ...Array.from({ length: 6 }, (_, i) => ({ videoId: `s${i}`, channelId: 'c1', title: '', publishedAt: recentIso, durationSeconds: 30, views: 100 })),
    ...Array.from({ length: 6 }, (_, i) => ({ videoId: `l${i}`, channelId: 'c1', title: '', publishedAt: recentIso, durationSeconds: 0, views: 9e6 })),
  ];
  const yt = {
    searchVideos: async () => ({ hits: videos.map((v) => ({ videoId: v.videoId })), totalResults: 1e6 }),
    videos: async () => videos,
    channels: async () => [{ channelId: 'c1', title: 'c', subscribers: 1000, publishedAt: '' }],
  };
  const { measureSupply } = await import('../src/supply.js');
  const r = await measureSupply(yt, 'x', { regionCode: 'US', relevanceLanguage: 'en' }, { now });
  assert.equal(r.recent_short_count, 6);
  assert.equal(r.recent_long_count, 0);
  assert.equal(r.recent_live_count, 6);
  assert.equal(r.median_short, 100);
});

test('検索結果の壁は検索の順位どおりに並び、開設から何日目の動画かを持つ', async () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const videos = [
    { videoId: 'b', channelId: 'c1', title: 'B', publishedAt: '2026-09-01T00:00:00Z', durationSeconds: 600, views: 5000 },
    { videoId: 'a', channelId: 'c2', title: 'A', publishedAt: '2026-08-01T00:00:00Z', durationSeconds: 600, views: 100 },
  ];
  const yt = {
    // videos() は検索順と違う順で返ることがある
    searchVideos: async () => ({ hits: [{ videoId: 'a' }, { videoId: 'b' }], totalResults: 1e6 }),
    videos: async () => videos,
    channels: async () => [
      { channelId: 'c1', title: 'one', subscribers: 1000, publishedAt: '2026-08-02T00:00:00Z' },
      { channelId: 'c2', title: 'two', subscribers: 9000, hiddenSubscriberCount: true, publishedAt: '' },
    ],
  };
  const { measureSupply } = await import('../src/supply.js');
  const r = await measureSupply(yt, 'x', { regionCode: 'JP', relevanceLanguage: 'ja' }, { now });
  assert.deepEqual(r.wall.map((v) => v.video_id), ['a', 'b']);
  assert.equal(r.wall[1].ratio, 2.5); // 5000 / (1000 + 1000)
  assert.equal(r.wall[1].channel_age_days, 30);
  assert.equal(r.wall[0].channel_age_days, null);
  assert.equal(r.wall[0].ratio, null); // 登録者が非公開なら倍率を出さない
});
