// 調べ切りの段の進め方。ブラウザ（web/app.js）から1段ずつ呼ぶ。
//
// 段ごとに状態（state）を保存して次の段へ渡す。タブを閉じても、保存した段から続けられる。
// 外への呼び出しはすべて fetchImpl を通るので、ブラウザでは Worker の中継（/api/*）に差し替える。

import { createQuotaMeter, createYouTubeClient } from '@pyonta0215/youtube-kit';
import { REGIONS } from '../demand.js';
import { collectEvidence } from '../evidence.js';
import { planSummary } from './plan.js';
import { expandDeep } from './expand.js';
import { discover, deepen } from './discover.js';
import { analyze } from './analyze.js';
import { handoff } from './handoff.js';

export const STAGES = ['expand', 'discover', 'deepen', 'evidence', 'analyze'];
export const STAGE_TEXT = {
  expand: '検索候補を3段まで広げています',
  discover: '切り口を変えて検索し、チャンネルを集めています',
  deepen: '投稿履歴を掘っています',
  evidence: 'お金の根拠と反証を Web で調べています',
  analyze: '漁場マップと人に渡すリストをまとめています',
  done: 'できました',
};

export function newDeepState({ id, theme, region, date, now = Date.now() }) {
  return {
    id, mode: 'deep', theme, region, regionLabel: REGIONS[region].label, date,
    createdAt: new Date(now).toISOString(),
    next: 'expand',
    quota: { searchCalls: 0, units: 0, failed: 0 },
    expand: null, searches: [], saturated: {}, videos: {}, channels: {}, uploads: {}, history: {}, copyCandidates: [],
    evidence: null, measuredAt: null,
  };
}

function meterFrom(state) {
  const m = createQuotaMeter();
  Object.assign(m, { searchCalls: state.quota.searchCalls, units: state.quota.units, failed: state.quota.failed });
  return m;
}

/** 進み具合として画面に見せる数字（状態は大きいので丸ごとは渡さない） */
export function progressOf(state) {
  const ok = state.searches.filter((s) => s.ok);
  const cuts = {};
  for (const s of ok) cuts[s.cut] = (cuts[s.cut] ?? 0) + 1;
  return {
    stage: state.next,
    terms: state.expand?.onThemeTerms ?? null,
    clusters: state.expand?.clusters.length ?? null,
    searchCalls: state.quota.searchCalls,
    units: state.quota.units,
    channels: new Set(ok.flatMap((s) => s.channels)).size,
    videos: Object.keys(state.videos).length,
    cuts,
    saturated: Object.keys(state.saturated ?? {}),
  };
}

/**
 * 次の段を1つ進める。終わったら state.result が入り、state.next は 'done' になる。
 * shouldStop() が true を返したら、その段の途中で区切って戻る（state.next は変わらない）
 */
export async function runDeepStage(state, { youtubeApiKey, openAiApiKey, withEvidence = true, log = () => {}, fetchImpl, now = Date.now(), shouldStop }) {
  const stage = state.next;
  const meter = meterFrom(state);
  const yt = createYouTubeClient({ apiKey: youtubeApiKey, meter, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const ctx = { yt, meter, region: state.region, now: state.measuredAt ? Date.parse(state.measuredAt) : now, log, shouldStop };

  if (stage === 'expand') {
    state.expand = await expandDeep(state.theme, state.region, { log, ...(fetchImpl ? { fetchImpl } : {}) });
  } else if (stage === 'discover') {
    state.measuredAt ??= new Date(now).toISOString(); // 続きから再開しても、測った日時は最初のまま
    ctx.now = Date.parse(state.measuredAt);
    await discover(state, ctx);
  } else if (stage === 'deepen') {
    await deepen(state, ctx);
  } else if (stage === 'evidence') {
    state.evidence = withEvidence && state.expand.clusters.length
      ? await collectEvidence({
          apiKey: openAiApiKey,
          theme: state.theme,
          regionLabel: state.regionLabel,
          topTerms: state.expand.clusters.slice(0, 12).map((c) => c.rep),
          maxSearches: 8,
          counterFirst: true,
          ...(fetchImpl ? { fetchImpl } : {}),
        }).catch((e) => ({ ok: false, reason: `調査に失敗しました（${e.kind ?? 'error'}）` }))
      : { ok: false, reason: withEvidence ? '検索候補が見つからなかったため調べていません' : '調べていません' };
  } else if (stage === 'analyze') {
    state.result = buildResult(state);
  } else {
    throw new Error(`unknown stage ${stage}`);
  }

  state.quota = { searchCalls: meter.searchCalls, units: meter.units, failed: meter.failed };
  if (state.partial) {
    // 区切りの時間で途中まで進んだ。同じ段を次回もう一度呼ぶ（済んだ分は飛ばす）
    delete state.partial;
    return state;
  }
  state.next = STAGES[STAGES.indexOf(stage) + 1] ?? 'done';
  return state;
}

/** 結果 JSON。状態から作るので、測り直さずに何度でも作り直せる */
export function buildResult(state) {
  const now = Date.parse(state.measuredAt ?? state.createdAt);
  const plan = planSummary();
  const deep = analyze(state, now, plan);
  const ev = state.evidence ?? { ok: false, reason: '調べていません' };
  return {
    id: state.id, version: 2, mode: 'deep', theme: state.theme, region: state.region, regionLabel: state.regionLabel,
    date: state.date, createdAt: state.createdAt, measuredAt: state.measuredAt,
    plan,
    expand: {
      requests: state.expand.requests, failures: state.expand.failures, onThemeTerms: state.expand.onThemeTerms,
      intentTotals: state.expand.intentTotals,
      clusters: state.expand.clusters.slice(0, 40).map((c) => ({ ...c, terms: c.terms.slice(0, 8) })),
    },
    searches: state.searches.map((s) => ({ cut: s.cut, q: s.q, region: s.region, order: s.order, publishedAfter: s.publishedAfter, videoDuration: s.videoDuration, ok: s.ok, error: s.error ?? null, sampled: s.hits.length, newChannels: s.newChannels, total: s.total ?? null })),
    saturated: Object.keys(state.saturated ?? {}),
    searchStop: state.searchStop ?? null,
    counts: { channels: Object.keys(state.channels).length, videos: Object.keys(state.videos).length, uploads: Object.keys(state.uploads).length, histories: Object.keys(state.history).length },
    deep,
    handoff: handoff(deep, { theme: state.theme }),
    evidence: ev,
    quota: state.quota,
    cost: { llm: ev.cost ?? { usd: null, basis: 'unmeasured' } },
  };
}
