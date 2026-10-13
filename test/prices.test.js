import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidPrice, tokenCostUsd } from '@pyonta0215/research-kit/cost';
import { MODEL_PRICES } from '../src/prices.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

test('単価表はすべて research-kit の検査を通る', () => {
  for (const [model, price] of Object.entries(MODEL_PRICES)) assertValidPrice(price, `price for ${model}`);
});

test('gpt-6 はキャッシュされなかった入力を書き込み単価で数える', () => {
  // 150k×$0.125/M + 50k×$0.01/M + 10k×$0.5/M
  close(tokenCostUsd(MODEL_PRICES['gpt-6-luna'], { inputTokens: 200_000, cachedInputTokens: 50_000, outputTokens: 10_000 }), 0.01875 + 0.0005 + 0.005);
});

test('gpt-6 は入力が 272K を超えたリクエスト全体に割増をかける', () => {
  close(tokenCostUsd(MODEL_PRICES['gpt-6-luna'], { inputTokens: 272_000, outputTokens: 10_000 }), 0.034 + 0.005);
  close(tokenCostUsd(MODEL_PRICES['gpt-6-luna'], { inputTokens: 300_000, outputTokens: 10_000 }), 0.075 + 0.0075);
});
