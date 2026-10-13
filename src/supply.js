// 供給の側：その語で検索したとき、上位の席が空いているかを測る。
//
// 判定ロジック（TARGET_SCORE / judge / 形式ごとの中央値）は yt-research-radar の
// src/demand.js を写したもの。しきい値は Radar の実測270語から決めた値で、ここでは変えていない。
// YouTube API の呼び出しは共通ライブラリ youtube-kit に寄せた。

import { isLiveByDuration, isShortByDuration } from '@pyonta0215/youtube-kit';

/** 精査する上位本数 */
const SAMPLE = 50;
/** 「直近」とみなす日数 */
const RECENT_DAYS = 365;
/** 検索結果の壁（サムネの並び）に残す上位本数 */
export const WALL_SIZE = 12;

export const TARGET_SCORE = { short: 30, long: 5 };
const GAP_COUNT = 3;
const MIN_FORMAT_SAMPLE = 5;
const THIN_TOTAL = 10000;

export const VERDICT_LABEL = {
  target: { label: '入り込む余地あり', note: '競合の規模に対して、直近の動画がよく回っている' },
  gap: { label: '直近の動画がほぼ無い', note: '誰も作っていないか、需要が無いかのどちらか。検索結果の総数と併せて見る' },
  crowded: { label: '席が埋まっている', note: '登録者数に見合うぶんしか回っていない' },
  thin: { label: '検索需要が薄い', note: '検索結果の総数が少ない' },
  unknown: { label: '判定できない', note: '形式ごとの本数が足りない。「薄い」とは別' },
};

export function median(nums) {
  const s = nums.filter((n) => n != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function judge({ sampled, recent, level, total }) {
  if (!sampled || sampled < 10 || (total != null && total < THIN_TOTAL)) return 'thin';
  if (recent <= GAP_COUNT) return 'gap';
  if (level == null) return 'unknown';
  return level >= 1 ? 'target' : 'crowded';
}

export function scoreSupply(raw) {
  const rival = raw.rival_median_subs;
  const sc = (m, count) =>
    count >= MIN_FORMAT_SAMPLE && m != null && rival != null ? Number((m / (rival + 1000)).toFixed(2)) : null;
  const scoreShort = sc(raw.median_short, raw.recent_short_count ?? 0);
  const scoreLong = sc(raw.median_long, raw.recent_long_count ?? 0);
  const nShort = scoreShort == null ? -1 : scoreShort / TARGET_SCORE.short;
  const nLong = scoreLong == null ? -1 : scoreLong / TARGET_SCORE.long;
  const best = nShort >= nLong ? 'short' : 'long';
  const level = Math.max(nShort, nLong);
  const hasScore = level >= 0;
  return {
    score_short: scoreShort,
    score_long: scoreLong,
    best_format: hasScore ? best : null,
    level: hasScore ? Number(level.toFixed(2)) : null,
    verdict: judge({ sampled: raw.sampled, recent: raw.recent_count, level: hasScore ? level : null, total: raw.total_results }),
  };
}

/** 動画を出した時点で、チャンネル開設から何日目だったか。開設日が取れなければ null */
function channelAgeAt(ch, v) {
  const start = Date.parse(ch?.publishedAt ?? '');
  const pub = Date.parse(v.publishedAt ?? '');
  if (Number.isNaN(start) || Number.isNaN(pub)) return null;
  return Math.max(0, Math.round((pub - start) / 86400000));
}

/**
 * 1語ぶんの供給を測る。search 枠 1 回 + combined 枠 2〜3 units。
 * 上位を占めるチャンネルのうち、直近の動画で回っているものを「先行事例」として返す。
 */
export async function measureSupply(yt, keyword, regionInfo, { now = Date.now() } = {}) {
  const { hits, totalResults } = await yt.searchVideos({
    q: keyword,
    maxResults: SAMPLE,
    regionCode: regionInfo.regionCode,
    relevanceLanguage: regionInfo.relevanceLanguage,
  });
  const base = { keyword, total_results: totalResults, sampled: 0, recent_count: 0, recent_short_count: 0, recent_long_count: 0, median_short: null, median_long: null, rival_median_subs: null };
  if (!hits.length) return { ...base, ...scoreSupply(base), leaders: [], wall: [] };

  const videos = await yt.videos(hits.map((h) => h.videoId));
  const withAge = videos.map((v) => ({
    ...v,
    // ライブ配信は再生時間が 0 秒で返る。24時間ラジオが多いジャンルで Shorts の中央値を
    // 引きずらないよう、Shorts とも通常動画とも別に数える（youtube-kit v0.1.1 から 0 秒は Shorts にならない）
    isLive: isLiveByDuration(v.durationSeconds),
    isShort: isShortByDuration(v.durationSeconds),
    age: Math.max(1, Math.round((now - new Date(v.publishedAt).getTime()) / 86400000)),
  }));
  const recent = withAge.filter((v) => v.age <= RECENT_DAYS);

  let channels = [];
  try {
    channels = await yt.channels([...new Set(withAge.map((v) => v.channelId).filter(Boolean))]);
  } catch { /* 登録者が取れなくても他は返す */ }
  const subsOf = new Map(channels.map((c) => [c.channelId, c]));

  const shorts = recent.filter((v) => v.isShort);
  const longs = recent.filter((v) => !v.isShort && !v.isLive);
  const raw = {
    ...base,
    sampled: withAge.length,
    recent_count: recent.length,
    recent_short_count: shorts.length,
    recent_long_count: longs.length,
    recent_live_count: recent.filter((v) => v.isLive).length,
    median_short: median(shorts.map((v) => v.views)),
    median_long: median(longs.map((v) => v.views)),
    rival_median_subs: median(channels.map((c) => c.subscribers)),
  };

  // 先行事例：直近1年の動画のうち、登録者数の割に回っている順に上位3チャンネル
  const bestByChannel = new Map();
  for (const v of recent) {
    const ch = subsOf.get(v.channelId);
    const ratio = (v.views ?? 0) / ((ch?.subscribers ?? 0) + 1000);
    const cur = bestByChannel.get(v.channelId);
    if (!cur || ratio > cur.ratio) bestByChannel.set(v.channelId, { v, ch, ratio });
  }
  const leaders = [...bestByChannel.values()]
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 3)
    .map(({ v, ch, ratio }) => ({
      channel: ch?.title ?? v.channelTitle,
      channel_id: v.channelId,
      handle: ch?.handle ?? null,
      subscribers: ch?.hiddenSubscriberCount ? null : ch?.subscribers ?? null,
      started_at: (ch?.publishedAt ?? '').slice(0, 10) || null,
      video_id: v.videoId,
      video_title: v.title,
      views: v.views,
      age_days: v.age,
      is_short: v.isShort,
      is_live: v.isLive,
      ratio: Number(ratio.toFixed(1)),
      channel_age_days: channelAgeAt(ch, v),
    }));

  // 検索結果の壁：検索の順位どおりに上位を並べる。サムネは保存せず、動画IDから YouTube の画像を直接表示する
  const byId = new Map(withAge.map((v) => [v.videoId, v]));
  const wall = hits
    .map((h) => byId.get(h.videoId))
    .filter(Boolean)
    .slice(0, WALL_SIZE)
    .map((v) => {
      const ch = subsOf.get(v.channelId);
      const subs = ch?.hiddenSubscriberCount ? null : ch?.subscribers ?? null;
      return {
        video_id: v.videoId,
        title: v.title,
        channel: ch?.title ?? v.channelTitle,
        subscribers: subs,
        views: v.views,
        age_days: v.age,
        duration_seconds: v.durationSeconds ?? null,
        is_short: v.isShort,
        is_live: v.isLive,
        // 登録者が非公開・取れないときは比べられないので倍率を出さない（0人扱いにすると「回っている」に化ける）
        ratio: subs == null ? null : Number(((v.views ?? 0) / (subs + 1000)).toFixed(1)),
        channel_age_days: channelAgeAt(ch, v),
      };
    });

  return { ...raw, ...scoreSupply(raw), leaders, wall };
}
