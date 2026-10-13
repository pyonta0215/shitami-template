// 調べ切り版の予算と、search 枠の配り方。実行の前にこの表を確定させ、結果にそのまま残す。
//
// YouTube Data API の枠は2つ:
//   search 枠 … search.list 1回ごと。1日100回（希少。発見だけに使う）
//   合算枠    … videos / channels / playlistItems など1回1 unit。1日10,000 units（深掘りに使う）
//
// 切り口（cut）は「共通の地図」「① ニッチ探し」「② 真似探し」に分かれる。
// 検索の2ページ目とチャンネル検索は youtube-kit v0.1.1 が対応していないので、
// 設計案でその2つに充てていた回数は、対応済みの切り口（尺別・直近半年の人気順）に振り替えた。

export const SEARCH_BUDGET = 75;      // 発見に使う回数
export const SEARCH_RETRY = 10;       // 失敗したときのやり直しに残す回数（発見と合わせて 85 で止める）
export const SEARCH_HARD_CAP = SEARCH_BUDGET + SEARCH_RETRY;
export const COMBINED_CAP = 5000;     // 合算枠の打ち切り上限

/** 深掘りの人数 */
export const DEEPEN = {
  channels: 200,          // 投稿履歴を取るチャンネル数（通常動画用・Shorts 用を各1ページ）
  copyCandidates: 40,     // 最初の動画まで全履歴を取る「真似の候補」の数
  copyHistoryPages: 4,    // 全履歴は最大4ページ（200本）
};

/**
 * 切り口の定義。budget は初期配分で、飽和したら残りを追加枠（extra）へ戻す。
 * direction は 'map'（共通）/ 'niche'（①）/ 'copy'（②）。
 */
export const CUTS = [
  { id: 'map', direction: 'map', label: '主検索（関連度順）', budget: 15, params: { order: 'relevance' } },
  { id: 'niche_date', direction: 'niche', label: 'ニッチ候補の新着順', budget: 12, params: { order: 'date' } },
  { id: 'niche_region', direction: 'niche', label: '別の地域との比較', budget: 8, params: { order: 'relevance' }, otherRegion: true },
  { id: 'niche_format', direction: 'niche', label: '有望な池の尺別', budget: 8, params: { order: 'relevance' } },
  { id: 'copy_vc1y', direction: 'copy', label: '直近1年の人気順', budget: 12, params: { order: 'viewCount' }, publishedWithinDays: 365 },
  { id: 'copy_vc6m', direction: 'copy', label: '直近半年の人気順', budget: 10, params: { order: 'viewCount' }, publishedWithinDays: 182 },
];
export const EXTRA_BUDGET = SEARCH_BUDGET - CUTS.reduce((s, c) => s + c.budget, 0); // 10

/** 飽和の判定（Guest ほか 2020 の規則を、新しく見つかるチャンネル数に置き換えたもの） */
export const SATURATION = { base: 4, run: 2, threshold: 0.05 };

/** 計画として結果に残す形 */
export function planSummary() {
  return {
    search: { budget: SEARCH_BUDGET, retry: SEARCH_RETRY, extra: EXTRA_BUDGET, cuts: CUTS.map(({ id, direction, label, budget }) => ({ id, direction, label, budget })) },
    combinedCap: COMBINED_CAP,
    deepen: DEEPEN,
    saturation: SATURATION,
    // 撤退条件。何が見つかったら「このテーマで個人が入る余地は小さい」と読むかを、調べる前に書いておく
    killCriteria: [
      { id: 'no_newcomer', text: '② 開設2年以内で当たりが3本以上あるチャンネルが1つも無い（後から入って釣れた人がいない）' },
      { id: 'concentrated', text: '外れ値の7割以上が上位3チャンネルに集中している（新しく入った人が釣れていない）' },
      { id: 'tiny_pools', text: '① ニッチ候補のどれも、直近の動画の再生中央値が1,000回に届かない（池が小さすぎる）' },
      { id: 'no_money', text: '説明欄に販売先・アフィリエイト・メンバーシップのリンクが、外れ値の1割にも無い（お金の流れが見えない）' },
    ],
  };
}

/**
 * 切り口ごとの飽和を判定する。calls は [{ newChannels }]（その切り口の呼び出し順）。
 * 最初の base 回で見つかった数を基準に、直近 run 回で新しく出た数が基準の threshold 以下なら飽和。
 */
export function isSaturated(calls, { base, run, threshold } = SATURATION) {
  if (calls.length < base + run) return false;
  const baseCount = calls.slice(0, base).reduce((s, c) => s + c.newChannels, 0);
  if (baseCount === 0) return true; // 何も見つからない切り口は続けても仕方ない
  const recent = calls.slice(-run).reduce((s, c) => s + c.newChannels, 0);
  return recent / baseCount <= threshold;
}

/** 太平洋時間の日付（YouTube の枠はこの0時に戻る）。夏時間は Intl に任せる */
export function ptDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
