// 段4–5「聞く・まとめる」のうち、機械で数えられる部分。状態（state）から結果の deep 欄を作る。
// YouTube も LLM も呼ばない。同じ状態からは常に同じ結果になる。
//
// 問いは「席は空いているか」ではなく「魚はいるか、自分が釣れるか」。
//   魚     … 視聴（再生）
//   釣り人 … その語で動画を出しているチャンネル
// 2つの方向で見る:
//   ① ニッチ … 釣り人は少ないのに魚が来ている小さな池
//   ② 真似   … 魚も釣り人もいる漁場で、個人が真似できるやり方で釣れている人

import { median, ageDays, groupByChannel, channelBaselines, multiplierOf, termMetrics, catchMetrics, OUTLIER, SUB_FLOOR } from './metrics.js';
import { hasMoney, LINK_KINDS, MONEY_KINDS } from './links.js';
import { modifierTokens } from './expand.js';

const DAY = 86400000;
const okCalls = (state, cut) => state.searches.filter((s) => s.cut === cut && s.ok);

export const QUADRANTS = {
  copy: { label: '真似で入る漁場', note: '魚も釣り人も多い。新しく入って釣れている人がいるかを見る' },
  go: { label: 'すぐ入る', note: '魚が多いのに釣り人が追いついていない' },
  niche: { label: 'ニッチの池', note: '魚はそこそこ、釣り人は少ない。池の大きさを見る' },
  avoid: { label: '避ける', note: '釣り人のほうが魚より多い' },
  tiny: { label: '池が小さすぎる', note: '直近の動画の再生がほとんど無い' },
};
/** 池が小さすぎるとみなす目安。直近1年の再生中央値がこれ未満 */
const TINY_MEDIAN = 1000;

/** 漁場マップ: 主検索の各語を、魚の量 × 釣り人の数で4つに置く。境目はこのテーマの中の中央値 */
export function fishingMap(state, now) {
  const rows = okCalls(state, 'map').map((s) => ({ term: s.q, cluster: clusterOf(state, s.q), ...termMetrics(s, state, now) }));
  const fishMid = median(rows.map((r) => r.fishSum));
  const anglerMid = median(rows.map((r) => r.anglers90));
  for (const r of rows) {
    if (r.fishMedian != null && r.fishMedian < TINY_MEDIAN) r.quadrant = 'tiny';
    else {
      const fishHigh = r.fishSum >= fishMid;
      const crowded = r.anglers90 >= anglerMid && r.anglers90 > 0;
      r.quadrant = fishHigh ? (crowded ? 'copy' : 'go') : crowded ? 'avoid' : 'niche';
    }
    r.money = moneyShare(r.term, state);
  }
  return { rows, fishMid, anglerMid };
}

function clusterOf(state, term) {
  const c = state.expand.clusters.find((x) => x.terms.some((t) => t.term === term));
  return c?.key ?? (modifierTokens(term, state.theme)[0] ?? null);
}

/** その語の検索結果のうち、説明欄にお金のリンクがある動画の割合 */
function moneyShare(term, state) {
  const ids = [...new Set(state.searches.filter((s) => s.q === term && s.ok).flatMap((s) => s.hits))];
  const vids = ids.map((id) => state.videos[id]).filter(Boolean);
  if (!vids.length) return null;
  return Number((vids.filter((v) => hasMoney(v.links)).length / vids.length).toFixed(2));
}

/** ① ニッチカード。新着順で測った池ごとに1枚 */
export function nicheCards(state, now, mapRows) {
  const byTerm = new Map(mapRows.map((r) => [r.term, r]));
  const regionBy = new Map(okCalls(state, 'niche_region').map((s) => [s.q, s]));
  const formatBy = new Map();
  for (const s of okCalls(state, 'niche_format')) {
    const vids = s.hits.map((id) => state.videos[id]).filter((v) => v && ageDays(v, now) <= 365);
    const m = formatBy.get(s.q) ?? {};
    m[s.videoDuration] = vids.length >= 5 ? Math.round(median(vids.map((v) => v.views))) : null;
    formatBy.set(s.q, m);
  }
  const cards = okCalls(state, 'niche_date').map((s) => {
    const c = catchMetrics(s, state, now);
    const map = byTerm.get(s.q);
    const reg = regionBy.get(s.q);
    const regCatch = reg ? termMetrics(reg, state, now) : null;
    const homeAnglers = map?.anglers90 ?? c.anglers90;
    const card = {
      term: s.q,
      cluster: clusterOf(state, s.q),
      anglers90: c.anglers90,
      uploads30: c.uploads30,
      catchMedian: c.catchMedian,
      catchRatio: c.catchRatio == null ? null : Number(c.catchRatio.toFixed(2)),
      poolSum: map?.fishSum ?? null,
      staleRate: map?.staleRate ?? null,
      smallTopRate: map?.smallTopRate ?? null,
      otherRegion: regCatch ? { anglers90: regCatch.anglers90, fishMedian: regCatch.fishMedian } : null,
      regionGap: regCatch ? regCatch.anglers90 >= 5 && homeAnglers <= 2 : null,
      formats: formatBy.get(s.q) ?? null,
      money: moneyShare(s.q, state),
    };
    card.tiny = card.catchMedian != null && card.catchMedian < TINY_MEDIAN;
    // 並び順: 新しく来た人の取り分（再生中央値）を、釣り人の数で割ったもの
    card.score = card.catchMedian == null ? -1 : Math.round(card.catchMedian / Math.max(1, card.anglers90));
    return card;
  });
  return cards.sort((a, b) => b.score - a.score);
}

// ---- ② 真似できる釣り人 ----

/** 題名の型: 3割以上の題名に出てくる記号・言い回し */
export function titlePattern(titles) {
  if (!titles.length) return [];
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const t of titles) {
    const seen = new Set();
    const add = (k) => { if (k && !seen.has(k)) { seen.add(k); bump(k); } };
    if (/【[^】]+】/.test(t)) add('【】');
    if (/[|｜]/.test(t)) add('｜区切り');
    if (/#\S+/.test(t)) add('#ハッシュタグ');
    if (/\d+\s*(時間|hours?|hrs?)/i.test(t)) add('○時間');
    if (/\p{Extended_Pictographic}/u.test(t)) add('絵文字');
    for (const m of t.matchAll(/【([^】]{1,16})】/g)) add(`【${m[1]}】`);
    for (const w of t.toLowerCase().split(/[\s|｜/・,，、。!！?？()（）[\]「」【】#\-–—:：]+/).filter((x) => x.length >= 2 && x.length <= 16)) add(w);
  }
  return [...counts.entries()].filter(([, n]) => n / titles.length >= 0.3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ token: k, share: Number((n / titles.length).toFixed(2)) }));
}

const roundOrNull = (x) => (x == null ? null : Math.round(x));

const fmtShare = (vids) => {
  const n = vids.length || 1;
  const c = (f) => Number((vids.filter((v) => v.fmt === f).length / n).toFixed(2));
  return { long: c('long'), short: c('short'), live: c('live') };
};

/** 題名にテーマの語がすべて入っているか（「AI BGM」なら ai と bgm の両方） */
export function onTheme(title, theme) {
  const t = String(title ?? '').toLowerCase().normalize('NFKC');
  const words = String(theme ?? '').toLowerCase().normalize('NFKC').split(/[\s\u3000]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => t.includes(w));
}
/** テーマの動画がこの割合に届かないチャンネルは、たまたま検索に出ただけとみなして手本にしない */
export const ON_THEME_MIN = 0.1;

/** 釣り人カード。全履歴を取った真似の候補ごとに1枚 */
export function anglerCards(state, now) {
  const byChannel = groupByChannel(state.videos);
  return (state.copyCandidates ?? []).map((id) => {
    const ch = state.channels[id] ?? {};
    const vids = (byChannel.get(id) ?? []).slice().sort((a, b) => Date.parse(a.pub) - Date.parse(b.pub));
    const base = channelBaselines(vids, now);
    const withMult = vids.map((v) => ({ v, m: multiplierOf(v, base, now) }));
    const hits = withMult.filter((x) => x.m != null && x.m >= OUTLIER.hit);
    const judged = withMult.filter((x) => x.m != null);
    const started = Date.parse(ch.pub ?? '') || (vids[0] ? Date.parse(vids[0].pub) : null);
    const firstHit = hits[0];
    const recent90 = vids.filter((v) => ageDays(v, now) <= 90);
    const first10 = vids.slice(0, 10);
    const last10 = vids.slice(-10);
    const longs = vids.filter((v) => v.fmt === 'long');
    const card = {
      channel_id: id,
      title: ch.title ?? vids[0]?.chTitle ?? '',
      handle: ch.handle ?? null,
      subscribers: ch.subs ?? null,
      started_at: ch.pub ? ch.pub.slice(0, 10) : null,
      age_days: started ? Math.round((now - started) / DAY) : null,
      videos_known: vids.length,
      video_count: ch.videoCount ?? null,
      hits: hits.length,
      hit_rate: judged.length ? Number((hits.length / judged.length).toFixed(2)) : null,
      first_hit: firstHit ? { video_id: firstHit.v.id, title: firstHit.v.title, multiplier: firstHit.m, views: firstHit.v.views, days_from_start: started ? Math.round((Date.parse(firstHit.v.pub) - started) / DAY) : null, nth: vids.indexOf(firstHit.v) + 1 } : null,
      best: hits.slice().sort((a, b) => b.m - a.m).slice(0, 3).map((x) => ({ video_id: x.v.id, title: x.v.title, multiplier: x.m, views: x.v.views, fmt: x.v.fmt })),
      per_week: Number((recent90.length / (90 / 7)).toFixed(1)),
      formats: fmtShare(vids),
      long_minutes: longs.length ? Math.round(median(longs.map((v) => v.dur)) / 60) : null,
      pattern: titlePattern(vids.map((v) => v.title)),
      first10: { median_views: roundOrNull(median(first10.map((v) => v.views))), formats: fmtShare(first10), pattern: titlePattern(first10.map((v) => v.title)) },
      last10: { median_views: roundOrNull(median(last10.map((v) => v.views))), formats: fmtShare(last10), pattern: titlePattern(last10.map((v) => v.title)) },
      money: vids.length ? Number((vids.filter((v) => hasMoney(v.links)).length / vids.length).toFixed(2)) : null,
      found_by: foundBy(state, id),
      on_theme: vids.length ? Number((vids.filter((v) => onTheme(v.title, state.theme)).length / vids.length).toFixed(2)) : null,
    };
    card.flags = {
      newcomer: card.age_days != null && card.age_days <= 730,
      repeated: card.hits >= 3,
      personal_pace: card.per_week > 0 && card.per_week <= 7,
      pattern_visible: card.pattern.length > 0,
      too_big: (card.subscribers ?? 0) >= 1e6,
      small: card.subscribers != null && card.subscribers < SUB_FLOOR,
      on_theme: (card.on_theme ?? 0) >= ON_THEME_MIN,
    };
    // 登録者1,000人未満は倍率の分母が小さく、当たりが膨らむ（OutlierKit の睡眠・環境音の監査で 15.8% → 6.7%）
    card.copyable = card.flags.newcomer && card.flags.repeated && card.flags.on_theme && !card.flags.too_big && !card.flags.small;
    return card;
  }).sort((a, b) => Number(b.copyable) - Number(a.copyable) || Number(b.flags.on_theme) - Number(a.flags.on_theme) || (b.hit_rate ?? 0) - (a.hit_rate ?? 0) || b.hits - a.hits);
}

function foundBy(state, channelId) {
  const counts = new Map();
  for (const s of state.searches) if (s.ok && s.hits.some((id) => state.videos[id]?.ch === channelId)) counts.set(s.q, (counts.get(s.q) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([q]) => q);
}

/**
 * 型の成功率（目安）: 同じ束（クラスタ）× 同じ形式で動画を出しているチャンネルのうち、
 * 直近1年に登録者数より多く再生された動画を持つ割合。伸びなかった人も数えるための数字。
 */
export function typeSuccess(state, now) {
  const groups = new Map();
  for (const s of state.searches) {
    if (!s.ok) continue;
    const cluster = clusterOf(state, s.q);
    for (const id of s.hits) {
      const v = state.videos[id];
      if (!v || v.fmt === 'unknown') continue;
      const key = `${cluster}|${v.fmt}`;
      const g = groups.get(key) ?? { cluster, fmt: v.fmt, channels: new Map() };
      const subs = state.channels[v.ch]?.subs;
      const won = ageDays(v, now) <= 365 && subs != null && (v.views ?? 0) >= subs + 1000;
      g.channels.set(v.ch, (g.channels.get(v.ch) ?? false) || won);
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .map((g) => ({ cluster: g.cluster, fmt: g.fmt, channels: g.channels.size, won: [...g.channels.values()].filter(Boolean).length }))
    .filter((g) => g.channels >= 5)
    .map((g) => ({ ...g, rate: Number((g.won / g.channels).toFixed(2)) }))
    .sort((a, b) => b.channels - a.channels)
    .slice(0, 12);
}

/** チャンネル内の外れ値（全チャンネル横断） */
export function outliers(state, now) {
  const byChannel = groupByChannel(state.videos);
  const out = [];
  for (const [id, vids] of byChannel) {
    const base = channelBaselines(vids, now);
    const ch = state.channels[id] ?? {};
    for (const v of vids) {
      const m = multiplierOf(v, base, now);
      if (m == null || m < OUTLIER.hit) continue;
      out.push({ video_id: v.id, title: v.title, channel_id: id, channel: ch.title ?? v.chTitle, subscribers: ch.subs ?? null, views: v.views, multiplier: m, fmt: v.fmt, age_days: ageDays(v, now), money: hasMoney(v.links), links: v.links, small: ch.subs == null || ch.subs < SUB_FLOOR, extreme: m > OUTLIER.extreme });
    }
  }
  out.sort((a, b) => b.multiplier - a.multiplier);
  const counted = out.filter((o) => !o.small);
  // サムネで学ぶための一覧。20倍超（外部要因が多い）と小さなチャンネルを外し、
  // 検索に直接出てきた動画（テーマに沿っている）を先に、チャンネルの履歴から見つけた動画を後に並べる
  const found = new Set(state.searches.flatMap((s) => s.hits ?? []));
  const learnable = counted.filter((o) => !o.extreme);
  const wall = [...learnable.filter((o) => found.has(o.video_id)), ...learnable.filter((o) => !found.has(o.video_id))].slice(0, 12);
  const byCh = new Map();
  for (const o of counted) byCh.set(o.channel_id, (byCh.get(o.channel_id) ?? 0) + 1);
  const top3 = [...byCh.values()].sort((a, b) => b - a).slice(0, 3).reduce((s, n) => s + n, 0);
  return {
    list: out,
    wall,
    total: out.length,
    counted: counted.length,
    small: out.length - counted.length,
    extreme: out.filter((o) => o.extreme).length,
    concentration: counted.length ? Number((top3 / counted.length).toFixed(2)) : null,
    channels: byCh.size,
  };
}

/** 量産型: 名前がよく似たチャンネルの群れ。正規化した名前の先頭6文字が同じものを数える */
export function clones(state) {
  const norm = (t) => String(t ?? '').toLowerCase().normalize('NFKC').replace(/[\p{Extended_Pictographic}\s\d\p{P}\p{S}]+/gu, '');
  const groups = new Map();
  for (const [id, ch] of Object.entries(state.channels)) {
    const n = norm(ch.title);
    if (n.length < 6) continue;
    const key = n.slice(0, 6);
    const g = groups.get(key) ?? [];
    g.push({ id, title: ch.title });
    groups.set(key, g);
  }
  return [...groups.entries()].filter(([, g]) => g.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([key, g]) => ({ key, count: g.length, examples: g.slice(0, 4).map((x) => x.title) }));
}

/** お金の流れ: 外れ値の説明欄にある種類ごとの割合 */
export function moneyFlow(outl, state) {
  const list = outl.list;
  const all = Object.values(state.videos);
  const share = (arr, k) => (arr.length ? Number((arr.filter((v) => (v.links ?? []).includes(k)).length / arr.length).toFixed(2)) : null);
  return {
    kinds: Object.entries(LINK_KINDS).map(([k, d]) => ({ kind: k, label: d.label, outliers: share(list, k), all: share(all, k), money: MONEY_KINDS.includes(k) })),
    outliersWithMoney: list.length ? Number((list.filter((o) => o.money).length / list.length).toFixed(2)) : null,
    allWithMoney: all.length ? Number((all.filter((v) => hasMoney(v.links)).length / all.length).toFixed(2)) : null,
  };
}

/** 三角測量: 検索される・見られる・払われる の3層。コメント（言われる）は案Bで足す */
export function triangulate(mapRows, state) {
  const hitsOf = new Map(state.expand.terms.map((t) => [t.term, t.hits]));
  const hitsMid = median(mapRows.map((r) => hitsOf.get(r.term) ?? 0));
  return mapRows.map((r) => {
    const searched = (hitsOf.get(r.term) ?? 0) >= Math.max(1, hitsMid ?? 1);
    const watched = r.quadrant === 'copy' || r.quadrant === 'go';
    const paid = (r.money ?? 0) >= 0.1;
    const layers = [searched, watched, paid].filter(Boolean).length;
    return { term: r.term, searched, watched, paid, layers, verdict: layers === 3 ? 'demand' : layers ? 'clue' : 'none' };
  });
}

/** 計画段で書いた撤退条件に当たったか */
export function killCheck(plan, { anglers, outl, niches, money }) {
  const res = {
    no_newcomer: { hit: !anglers.some((a) => a.copyable), value: `${anglers.filter((a) => a.copyable).length}チャンネル` },
    concentrated: { hit: outl.concentration != null && outl.concentration >= 0.7, value: outl.concentration == null ? '記録なし' : `${Math.round(outl.concentration * 100)}%` },
    tiny_pools: { hit: niches.length > 0 && niches.every((n) => n.catchMedian == null || n.catchMedian < 1000), value: `${niches.filter((n) => n.catchMedian != null && n.catchMedian >= 1000).length}/${niches.length}池` },
    no_money: { hit: money.outliersWithMoney != null && money.outliersWithMoney < 0.1, value: money.outliersWithMoney == null ? '記録なし' : `${Math.round(money.outliersWithMoney * 100)}%` },
  };
  return plan.killCriteria.map((k) => ({ ...k, ...res[k.id] }));
}

/** 同じ信号を、方向によって逆に読む表の値 */
export function signals({ map, cl, outl, niches }) {
  const avg = (xs) => { const a = xs.filter((x) => x != null); return a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(2)) : null; };
  return {
    clones: cl[0]?.count ?? 0,
    anglersMedian: map.anglerMid,
    staleRate: avg(map.rows.map((r) => r.staleRate)),
    bigTopRate: avg(map.rows.map((r) => r.bigTopRate)),
    concentration: outl.concentration,
    regionGaps: niches.filter((n) => n.regionGap).length,
  };
}

export function analyze(state, now, plan) {
  const map = fishingMap(state, now);
  const niches = nicheCards(state, now, map.rows);
  const anglers = anglerCards(state, now);
  const outl = outliers(state, now);
  const cl = clones(state);
  const money = moneyFlow(outl, state);
  return {
    map,
    niches,
    anglers,
    typeSuccess: typeSuccess(state, now),
    outliers: { ...outl, list: outl.list.slice(0, 60) },
    clones: cl,
    money,
    triangulation: triangulate(map.rows, state),
    kill: killCheck(plan, { anglers, outl, niches, money }),
    signals: signals({ map, cl, outl, niches }),
  };
}
