// 段2「見つける」と段3「掘る」。YouTube API を呼ぶのはここだけ。
//
// search は「まだ知らないチャンネルを連れてくる」ことだけに使い、確認や取り直しには使わない。
// 見つけた動画の詳細（videos.list）・チャンネル（channels.list）・投稿履歴（playlistItems）は合算枠で取る。
//
// 状態（state）は段ごとに保存して、タブを閉じても続きから再開できる形にしてある。
// Map は JSON にできないので、videos / channels / uploads は普通のオブジェクトで持つ。

import { videoFormatByDuration } from '@pyonta0215/youtube-kit';
import { REGIONS } from '../demand.js';
import { CUTS, EXTRA_BUDGET, SEARCH_BUDGET, SEARCH_HARD_CAP, COMBINED_CAP, DEEPEN, isSaturated } from './plan.js';
import { classifyLinks } from './links.js';
import { termMetrics, channelBaselines, multiplierOf, ageDays, median, groupByChannel } from './metrics.js';

const ASCII = /^[\x20-\x7e]+$/;
const DAY = 86400000;

class StopSearch extends Error {}

function compactVideo(v) {
  return {
    id: v.videoId,
    ch: v.channelId,
    chTitle: v.channelTitle,
    title: v.title,
    pub: v.publishedAt,
    dur: v.durationSeconds,
    fmt: videoFormatByDuration(v.durationSeconds),
    views: v.views,
    likes: v.likes,
    comments: v.comments,
    links: classifyLinks(v.description),
  };
}

/** 知らない動画だけ videos.list で取る（50本で1 unit） */
async function fillVideos(state, yt, ids) {
  const missing = [...new Set(ids)].filter((id) => !state.videos[id]);
  if (!missing.length) return;
  for (const v of await yt.videos(missing)) state.videos[v.videoId] = compactVideo(v);
}

function makeSearcher(state, ctx) {
  const { yt, meter, region, now, log } = ctx;
  const home = REGIONS[region];
  const other = REGIONS[region === 'jp' ? 'en' : 'jp'];
  const seen = new Set(state.searches.flatMap((s) => s.channels ?? []));

  return async function search(cut, q, extra = {}) {
    if (meter.searchCalls >= SEARCH_HARD_CAP) throw new StopSearch('hard-cap');
    const r = cut.otherRegion ? other : home;
    const publishedAfter = cut.publishedWithinDays ? new Date(now - cut.publishedWithinDays * DAY).toISOString() : undefined;
    const rec = { cut: cut.id, q, region: cut.otherRegion ? (region === 'jp' ? 'en' : 'jp') : region, order: cut.params.order, publishedAfter: publishedAfter?.slice(0, 10) ?? null, videoDuration: extra.videoDuration ?? null };
    try {
      const { hits, totalResults } = await yt.searchVideos({
        q, maxResults: 50, regionCode: r.regionCode, relevanceLanguage: r.relevanceLanguage,
        order: cut.params.order, publishedAfter, videoDuration: extra.videoDuration,
      });
      const channels = [...new Set(hits.map((h) => h.channelId))];
      const fresh = channels.filter((c) => !seen.has(c));
      for (const c of fresh) seen.add(c);
      await fillVideos(state, yt, hits.map((h) => h.videoId));
      Object.assign(rec, { ok: true, total: totalResults, hits: hits.map((h) => h.videoId), channels, newChannels: fresh.length });
      log(`search ${cut.id} 「${q}」${rec.videoDuration ? `(${rec.videoDuration})` : ''} → ${hits.length}本・新しいチャンネル${fresh.length}`);
    } catch (e) {
      if (e instanceof StopSearch) throw e;
      Object.assign(rec, { ok: false, error: e.kind ?? 'error', hits: [], channels: [], newChannels: 0 });
      log(`search ${cut.id} 「${q}」→ 失敗 (${e.kind ?? e.message})`);
      if (e.kind === 'quota-exceeded') { state.searches.push(rec); throw new StopSearch('quota-exceeded'); }
    }
    state.searches.push(rec);
    return rec;
  };
}

const callsOf = (state, cutId) => state.searches.filter((s) => s.cut === cutId && s.ok);

/**
 * 1つの切り口を、予算か飽和か問い合わせ候補の尽きるまで回す。使わなかった回数を返す
 */
async function runCut(state, search, cut, queue, budget) {
  const done = new Set(state.searches.filter((s) => s.cut === cut.id).map((s) => `${s.q}|${s.videoDuration ?? ''}`));
  let used = callsOf(state, cut.id).length;
  for (const item of queue) {
    if (used >= budget) break;
    if (isSaturated(callsOf(state, cut.id))) {
      state.saturated[cut.id] = true;
      break;
    }
    const key = `${item.q}|${item.videoDuration ?? ''}`;
    if (done.has(key)) continue;
    done.add(key);
    const rec = await search(cut, item.q, item);
    if (rec.ok) used += 1;
  }
  return Math.max(0, budget - used);
}

// ---- 問い合わせ候補の作り方（前の切り口の結果を見て決める） ----

function mapQueue(state) {
  const reps = state.expand.clusters.map((c) => c.rep);
  const extraTerms = state.expand.terms.map((t) => t.term).filter((t) => !reps.includes(t));
  return [...reps, ...extraTerms].slice(0, 40).map((q) => ({ q }));
}

function mapTermStats(state, now) {
  return callsOf(state, 'map').map((s) => ({ q: s.q, ...termMetrics(s, state, now) }));
}

/** ニッチ候補: 主検索で釣り人が少なめだった語（魚の多い順）と、まだ測っていない細かい語 */
export function nicheQueue(state, now) {
  const stats = mapTermStats(state, now);
  const anglersMid = median(stats.map((s) => s.anglers90));
  const quiet = stats.filter((s) => anglersMid == null || s.anglers90 <= anglersMid).sort((a, b) => (b.fishSum ?? 0) - (a.fishSum ?? 0)).map((s) => s.q);
  const measured = new Set(stats.map((s) => s.q));
  const longTail = state.expand.clusters.flatMap((c) => c.terms.slice(1).filter((t) => t.hits >= 2).map((t) => t.term)).filter((t) => !measured.has(t));
  // 語が少ないテーマ（日本語に多い）でも追加枠を使えるよう、釣り人の多い語も最後に並べておく
  const rest = stats.map((s) => s.q).filter((q) => !quiet.includes(q));
  return [...new Set([...quiet, ...longTail, ...rest])].slice(0, 40).map((q) => ({ q }));
}

function regionQueue(state, region) {
  const cands = [...callsOf(state, 'niche_date').map((s) => s.q), ...callsOf(state, 'map').map((s) => s.q)];
  // 日本語の語を米国で検索しても比較にならないので、日本→英語圏は英数字だけの語に絞る
  const usable = region === 'jp' ? cands.filter((q) => ASCII.test(q)) : cands;
  return [...new Set(usable)].slice(0, 20).map((q) => ({ q }));
}

/** 新着順で「新しく来た人がどれだけ釣れているか」が大きかった池を、尺で分けて測り直す */
function formatQueue(state, now) {
  const ranked = callsOf(state, 'niche_date')
    .map((s) => ({ q: s.q, catch: median(s.hits.map((id) => state.videos[id]).filter((v) => v && ageDays(v, now) >= 14 && ageDays(v, now) <= 180).map((v) => v.views)) ?? 0 }))
    .sort((a, b) => b.catch - a.catch)
    .map((x) => x.q);
  return ranked.slice(0, 10).flatMap((q) => [{ q, videoDuration: 'short' }, { q, videoDuration: 'long' }]);
}

function copyQueue(state, now) {
  const stats = mapTermStats(state, now).sort((a, b) => (b.fishSum ?? 0) - (a.fishSum ?? 0));
  return stats.map((s) => ({ q: s.q })).slice(0, 25);
}

export async function discover(state, ctx) {
  state.saturated ??= {};
  const search = makeSearcher(state, ctx);
  const cut = (id) => CUTS.find((c) => c.id === id);
  const leftover = {};
  try {
    leftover.map = await runCut(state, search, cut('map'), mapQueue(state), cut('map').budget);
    leftover.niche_date = await runCut(state, search, cut('niche_date'), nicheQueue(state, ctx.now), cut('niche_date').budget);
    leftover.niche_region = await runCut(state, search, cut('niche_region'), regionQueue(state, ctx.region), cut('niche_region').budget);
    leftover.niche_format = await runCut(state, search, cut('niche_format'), formatQueue(state, ctx.now), cut('niche_format').budget);
    leftover.copy_vc1y = await runCut(state, search, cut('copy_vc1y'), copyQueue(state, ctx.now), cut('copy_vc1y').budget);
    leftover.copy_vc6m = await runCut(state, search, cut('copy_vc6m'), copyQueue(state, ctx.now), cut('copy_vc6m').budget);

    // 追加枠: 使わなかった回数と追加枠を、飽和していない切り口へ順番に配る
    let pool = EXTRA_BUDGET + Object.values(leftover).reduce((s, n) => s + n, 0);
    const queues = { map: () => mapQueue(state), niche_date: () => nicheQueue(state, ctx.now), copy_vc1y: () => copyQueue(state, ctx.now), copy_vc6m: () => copyQueue(state, ctx.now) };
    let progressed = true;
    while (pool > 0 && progressed) {
      progressed = false;
      for (const id of Object.keys(queues)) {
        if (pool <= 0 || state.saturated[id]) continue;
        const okBefore = state.searches.filter((s) => s.ok).length;
        if (okBefore >= SEARCH_BUDGET) { pool = 0; break; }
        const c = cut(id);
        const left = await runCut(state, search, c, queues[id](), callsOf(state, id).length + 1);
        if (left === 0) { pool -= 1; progressed = true; }
      }
    }
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    state.searchStop = e.message;
  }
  return state;
}

// ---- 段3「掘る」 ----

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const playlist = (channelId, prefix) => `${prefix}${channelId.slice(2)}`;

async function uploads(yt, channelId, prefix, limit) {
  try {
    return (await yt.playlistVideoIds(playlist(channelId, prefix), limit)).ids;
  } catch (e) {
    if (e.kind === 'not-found' || e.kind === 'bad-request' || e.kind === 'forbidden') return null; // 非公開の再生リストIDが使えない
    throw e;
  }
}

export async function deepen(state, ctx) {
  const { yt, meter, now, log } = ctx;
  const capped = () => meter.units >= COMBINED_CAP;

  // 見つかったチャンネルすべての登録者・開設日
  const channelIds = [...new Set(Object.values(state.videos).map((v) => v.ch).filter(Boolean))];
  const missing = channelIds.filter((id) => !state.channels[id]);
  for (const c of await yt.channels(missing)) {
    state.channels[c.channelId] = { title: c.title, handle: c.handle, pub: c.publishedAt, subs: c.hiddenSubscriberCount ? null : c.subscribers, views: c.views, videoCount: c.videoCount, country: c.country };
  }
  log(`チャンネル: ${Object.keys(state.channels).length}件`);

  // 検索で何回出てきたかの順に上位を選び、通常動画と Shorts の投稿履歴を1ページずつ
  const appear = new Map();
  for (const s of state.searches) for (const id of s.hits ?? []) {
    const ch = state.videos[id]?.ch;
    if (ch) appear.set(ch, (appear.get(ch) ?? 0) + 1);
  }
  const top = [...appear.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => state.channels[id]).slice(0, DEEPEN.channels);
  await pool(top.filter((id) => !state.uploads[id]), 4, async (id) => {
    if (capped()) return;
    let long = await uploads(yt, id, 'UULF', 50);
    let short = long == null ? null : await uploads(yt, id, 'UUSH', 50);
    let src = 'UULF+UUSH';
    if (long == null) { long = (await uploads(yt, id, 'UU', 50)) ?? []; short = []; src = 'UU'; }
    state.uploads[id] = { long, short: short ?? [], src };
  });
  await fillVideos(state, yt, Object.values(state.uploads).flatMap((u) => [...u.long, ...u.short]));
  log(`投稿履歴: ${Object.keys(state.uploads).length}チャンネル・動画 ${Object.keys(state.videos).length}本・合算枠 ${meter.units} units`);

  // 真似の候補: 開設2年以内で、チャンネル内の中央値の3倍を超えた動画があるチャンネル
  const cands = copyCandidates(state, now).slice(0, DEEPEN.copyCandidates);
  state.copyCandidates = cands.map((c) => c.id);
  await pool(cands.filter((c) => !state.history[c.id]), 4, async (c) => {
    if (capped()) return;
    state.history[c.id] = (await uploads(yt, c.id, 'UU', DEEPEN.copyHistoryPages * 50)) ?? [];
  });
  await fillVideos(state, yt, Object.values(state.history).flat());
  log(`真似の候補: ${cands.length}チャンネルの全履歴・合算枠 ${meter.units} units`);
  return state;
}

/** 真似の候補を選ぶ。純粋関数（テスト用に分けてある） */
export function copyCandidates(state, now) {
  const out = [];
  const byChannel = groupByChannel(state.videos);
  for (const [id, ch] of Object.entries(state.channels)) {
    const age = ch.pub ? (now - Date.parse(ch.pub)) / DAY : null;
    if (age == null || age > 730) continue;
    const vids = byChannel.get(id) ?? [];
    const base = channelBaselines(vids, now);
    const mults = vids.map((v) => multiplierOf(v, base, now)).filter((m) => m != null);
    const hits = mults.filter((m) => m >= 3).length;
    const best = Math.max(0, ...vids.map((v) => (v.views ?? 0) / ((ch.subs ?? 0) + 1000)));
    if (!hits && best < 1) continue;
    out.push({ id, hits, best });
  }
  return out.sort((a, b) => b.hits - a.hits || b.best - a.best);
}
