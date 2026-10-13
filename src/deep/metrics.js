// 数字の定義。どれも純粋関数で、同じ状態からは同じ値が出る。
//
// 外れ値は分母を疑う（登録者7人のチャンネルが9万再生すると1万倍を超える）。
// だから倍率は「同じチャンネル・同じ形式の中央値」と比べ、生の再生数と登録者の下限を必ず添える。

const DAY = 86400000;

export function median(nums) {
  const s = nums.filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const ageDays = (v, now) => Math.max(1, Math.round((now - Date.parse(v.pub)) / DAY));

export function groupByChannel(videos) {
  const m = new Map();
  for (const v of Object.values(videos)) {
    if (!v.ch) continue;
    const a = m.get(v.ch) ?? [];
    a.push(v);
    m.set(v.ch, a);
  }
  return m;
}

/** 倍率の基準に使う最低の経過日数。公開直後は再生が伸びきっていない */
export const SETTLED_DAYS = 14;
/** 基準を出すのに要る本数 */
export const MIN_BASELINE = 5;
/** 外れ値の目安（OutlierKit の目安: 3倍で「何かが効いた」、20倍超は外部要因が多い） */
export const OUTLIER = { hit: 3, extreme: 20 };
/** 登録者の下限（YouTube パートナープログラムの条件と同じ1,000人） */
export const SUB_FLOOR = 1000;

/** チャンネル内の形式ごとの再生中央値。ライブと尺不明は混ぜない */
export function channelBaselines(videos, now) {
  const out = {};
  for (const fmt of ['long', 'short']) {
    const views = videos.filter((v) => v.fmt === fmt && ageDays(v, now) >= SETTLED_DAYS).map((v) => v.views);
    const m = median(views);
    out[fmt] = views.length >= MIN_BASELINE && m ? { median: m, n: views.length } : null;
  }
  return out;
}

export function multiplierOf(v, baselines, now) {
  const b = baselines[v.fmt];
  if (!b || v.views == null || ageDays(v, now) < SETTLED_DAYS) return null;
  return Number((v.views / b.median).toFixed(1));
}

const within = (v, now, days) => ageDays(v, now) <= days;

/**
 * 1回の検索結果から、魚（再生）と釣り人（投稿者）の量を測る。
 *   fishSum      直近1年の動画の再生合計（池の大きさの目安）
 *   fishMedian   直近1年の動画の再生中央値
 *   anglers90    直近90日に動画を出したチャンネルの数（釣り人の数）
 *   staleRate    上位20本のうち2年以上前の動画の割合（高いほど新しい供給が追いついていない）
 *   smallTopRate 上位20本のうち登録者1万人未満のチャンネルの割合
 *   bigTopRate   上位20本のうち登録者100万人以上のチャンネルの割合
 */
export function termMetrics(search, state, now) {
  const vids = (search.hits ?? []).map((id) => state.videos[id]).filter(Boolean);
  const recent = vids.filter((v) => within(v, now, 365));
  const top20 = vids.slice(0, 20);
  const subsOf = (v) => state.channels?.[v.ch]?.subs;
  const share = (arr, pred) => (arr.length ? Number((arr.filter(pred).length / arr.length).toFixed(2)) : null);
  const known = top20.filter((v) => subsOf(v) != null);
  return {
    sampled: vids.length,
    total: search.total ?? null,
    recentCount: recent.length,
    fishSum: recent.reduce((s, v) => s + (v.views ?? 0), 0),
    fishMedian: recent.length >= 5 ? Math.round(median(recent.map((v) => v.views))) : null,
    anglers90: new Set(vids.filter((v) => within(v, now, 90)).map((v) => v.ch)).size,
    staleRate: share(top20, (v) => ageDays(v, now) > 730),
    smallTopRate: known.length ? share(known, (v) => subsOf(v) < 10000) : null,
    bigTopRate: known.length ? share(known, (v) => subsOf(v) >= 1e6) : null,
  };
}

/** 新着順の検索結果から「新しく来た人がどれだけ釣れているか」を測る */
export function catchMetrics(search, state, now) {
  const vids = (search.hits ?? []).map((id) => state.videos[id]).filter(Boolean);
  const settled = vids.filter((v) => ageDays(v, now) >= SETTLED_DAYS && ageDays(v, now) <= 180);
  return {
    anglers90: new Set(vids.filter((v) => within(v, now, 90)).map((v) => v.ch)).size,
    uploads30: vids.filter((v) => within(v, now, 30)).length,
    catchMedian: settled.length >= 5 ? Math.round(median(settled.map((v) => v.views))) : null,
    catchRatio: settled.length >= 5 ? median(settled.map((v) => (v.views ?? 0) / ((state.channels?.[v.ch]?.subs ?? 0) + 1000))) : null,
    settled: settled.length,
    newestDays: vids.length ? Math.min(...vids.map((v) => ageDays(v, now))) : null,
  };
}
