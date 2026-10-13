import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsTheme, classifyIntent, summarizeDemand, pickForSupply } from '../src/demand.js';

test('テーマを含む語だけを拾う（英数字の単語の途中は拾わない）', () => {
  assert.equal(containsTheme('ai bgm 作り方', 'AI BGM'), true);
  assert.equal(containsTheme('aibgm', 'AI BGM'), true);
  assert.equal(containsTheme('作業用bgm', 'bgm'), true);
  assert.equal(containsTheme('ai bgmi sensitivity', 'AI BGM'), false);
  assert.equal(containsTheme('aiフトゥーbgm', 'AI BGM'), false);
  assert.equal(containsTheme('ai ポケモン bgm', 'AI BGM'), false);
  assert.equal(containsTheme('ai bgm maker', 'AI BGM'), true);
  assert.equal(containsTheme('free ai bgm', 'AI BGM'), true);
});

test('意図は辞書で分け、漏れた語はどの箱にも入れない', () => {
  assert.deepEqual(classifyIntent('ai bgm 収益化'), ['maker']);
  assert.deepEqual(classifyIntent('lofi study music'), ['viewer']);
  assert.deepEqual(classifyIntent('ai bgm'), []);
  assert.deepEqual(classifyIntent('lofi girl', 'lofi'), []);
  assert.deepEqual(classifyIntent('lofi study music', 'lofi'), ['viewer']);
});

test('需要の要約はテーマそのものと外れた語を除き、出現回数順に並べる', () => {
  const counts = new Map([['ai bgm', 9], ['ai bgm 作り方', 2], ['ai bgm 自動生成', 3], ['bgmi', 5]]);
  const d = summarizeDemand('AI BGM', counts);
  assert.deepEqual(d.terms.map((t) => t.term), ['ai bgm 自動生成', 'ai bgm 作り方']);
  assert.equal(d.onThemeTerms, 2);
  assert.equal(d.intentTotals.maker, 2);
});

test('供給を測る語は意図ごとの最上位を先に取り、件数を超えない', () => {
  const terms = [
    { term: 'a 作り方', hits: 5, intents: ['maker'] },
    { term: 'a 収益化', hits: 4, intents: ['maker'] },
    { term: 'a 作業用', hits: 1, intents: ['viewer'] },
  ];
  const picked = pickForSupply(terms, 2).map((t) => t.term);
  assert.deepEqual(picked, ['a 作り方', 'a 作業用']);
});
