// 段0–1「広げる」: 検索候補を3段まで展開し、語をクラスタ（言い換えの束）に分ける。API の枠は使わない。
//
// 1段目と2段目は demand.js の expandTheme（接頭辞の展開と、上位語の再問い合わせ）をそのまま使い、
// 3段目でまだ問い合わせていない上位語と、疑問詞・用途語の種を足す。
// クラスタはテーマを取り除いた残りの先頭の語で分ける（「作業用bgm 秋」「作業用bgm 集中」→「作業用」）。
// LLM を使わないので、同じ入力からは同じ束ができる。

import { expandTheme, suggest, containsTheme, classifyIntent, INTENTS } from '../demand.js';

const SEEDS = {
  jp: ['なぜ', 'やり方', 'おすすめ', '無料', '初心者', '稼ぐ', '比較', '人気', '作り方', '使い方', 'とは', '方法'],
  en: ['how to', 'best', 'for', 'free', 'beginner', 'vs', 'without', 'tutorial', 'ideas', 'tips', 'make money', 'review'],
};

const squash = (x) => x.toLowerCase().replace(/[\s　]+/g, '');
const spaced = (x) => x.toLowerCase().replace(/[\s　]+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 語からテーマの部分を取り除いた残り（空白区切りの語の配列） */
export function modifierTokens(term, theme) {
  let t = spaced(term);
  for (const b of [spaced(theme), squash(theme)].filter(Boolean)) t = t.split(b).join(' ');
  return t.split(/\s+/).filter(Boolean);
}

/** 語をクラスタに分ける。キーは修飾語の先頭。テーマだけの語は入れない */
export function clusterTerms(terms, theme) {
  const map = new Map();
  for (const t of terms) {
    const tokens = modifierTokens(t.term, theme);
    if (!tokens.length) continue;
    const key = tokens[0];
    const c = map.get(key) ?? { key, terms: [], hits: 0, intents: new Set() };
    c.terms.push(t);
    c.hits += t.hits;
    for (const i of t.intents) c.intents.add(i);
    map.set(key, c);
  }
  return [...map.values()]
    .map((c) => {
      const sorted = c.terms.sort((a, b) => b.hits - a.hits || a.term.length - b.term.length || a.term.localeCompare(b.term));
      return { key: c.key, rep: sorted[0].term, hits: c.hits, size: sorted.length, intents: [...c.intents], terms: sorted.map((t) => ({ term: t.term, hits: t.hits })) };
    })
    .sort((a, b) => b.hits - a.hits || a.key.localeCompare(b.key));
}

export async function expandDeep(theme, region, { fetchImpl = fetch, delayMs = 120, depth2 = 20, depth3 = 30, log = () => {} } = {}) {
  const first = await expandTheme(theme, region, { fetchImpl, delayMs, depth2 });
  const counts = first.counts;
  let requests = first.requests;
  let failures = first.failures;

  // 2段目で問い合わせた語（expandTheme と同じ選び方）を除いて、次の上位語を3段目に回す
  const onTheme = [...counts.entries()].filter(([k]) => squash(k) !== squash(theme) && containsTheme(k, theme)).sort((a, b) => b[1] - a[1]);
  const asked = new Set(onTheme.slice(0, depth2).map(([k]) => k));
  const third = onTheme.filter(([k]) => !asked.has(k)).slice(0, depth3).map(([k]) => k);
  const seeds = (SEEDS[region] ?? SEEDS.jp).map((s) => `${theme} ${s}`);
  for (const q of [...seeds, ...third]) {
    requests += 1;
    try {
      for (const s of await suggest(q, region, { fetchImpl })) {
        const k = s.trim().toLowerCase();
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    } catch {
      failures += 1;
    }
    if (delayMs) await sleep(delayMs);
  }
  log(`検索候補: ${requests}回問い合わせ（失敗${failures}）`);

  const base = theme.trim().toLowerCase();
  const terms = [...counts.entries()]
    .filter(([k]) => k !== base && containsTheme(k, base))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 300)
    .map(([term, hits]) => ({ term, hits, intents: classifyIntent(term, theme) }));

  const intentTotals = Object.fromEntries([...INTENTS.map((i) => [i.id, 0]), ['other', 0]]);
  for (const t of terms) {
    if (!t.intents.length) intentTotals.other += 1;
    for (const id of t.intents) intentTotals[id] += 1;
  }
  const clusters = clusterTerms(terms, theme);
  return { terms, clusters, intentTotals, requests, failures, onThemeTerms: terms.length };
}
