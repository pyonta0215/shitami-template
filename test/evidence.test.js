import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, dropOverlap, gateBySources } from '../src/evidence.js';

test('出典集合に無い URL の項目は捨て、件数を数える', () => {
  const sources = [{ url: 'https://example.com/a/', kinds: ['search-result'] }];
  const { kept, dropped } = gateBySources(
    [
      { claim: '1曲3,000円で販売', url: 'https://example.com/a' },
      { claim: 'モデルが書いただけ', url: 'https://made-up.example/x' },
      { claim: '', url: 'https://example.com/a' },
      { claim: 'URL なし' },
    ],
    sources,
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].kinds, ['search-result']);
  assert.equal(dropped, 3);
});

test('反証の指示に兆候の項目と「見つからなければそう書く」が入っている', () => {
  const prompt = buildPrompt({ theme: '作曲', regionLabel: '日本', topTerms: ['作曲 やり方'] });
  for (const word of ['OSS', '払う気がない', '強すぎる競合', '集める手段', '利益率', '作業が重すぎる', '法規制・資格', 'AI・自動化で代替', '一過性', '反証は見つからなかった', '口コミ・SNS']) {
    assert.ok(prompt.includes(word), `プロンプトに「${word}」が無い`);
  }
});

test('payments と同じ URL の反証は落とし、件数を数える', () => {
  const payments = [{ claim: '1曲3,000円で販売', url: 'https://example.com/a/' }];
  const counters = [
    { claim: '無料素材で足りる', url: 'https://example.com/a#top' },
    { claim: '競合が多い', url: 'https://example.com/b' },
  ];
  const { kept, overlapped } = dropOverlap(counters, payments);
  assert.deepEqual(kept.map((c) => c.url), ['https://example.com/b']);
  assert.equal(overlapped, 1);
});
