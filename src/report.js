// 結果 JSON から「下見」1枚の HTML を作る。LLM は呼ばない（同じ JSON からは常に同じページ）。
//
// 書き方の約束:
//   - 「やるべき」とは書かない。材料と反証と、次に確かめる1つだけを出す
//   - 埋まらなかった欄は「記録なし」
//   - 数字には取得日と出どころを付ける

import { INTENTS } from './demand.js';
import { VERDICT_LABEL } from './supply.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('ja-JP'));
export const compact = (n) => {
  if (n == null) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}億`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return num(n);
};
export const NONE = '<p class="none">記録なし</p>';

const KIND_LABEL = { citation: '本文で引用', 'search-result': '検索結果', 'opened-page': '開いて確認' };

function intentBars(d) {
  const rows = [...INTENTS.map((i) => ({ id: i.id, label: i.label })), { id: 'other', label: 'その他' }];
  const max = Math.max(1, ...rows.map((r) => d.intentTotals[r.id] ?? 0));
  return rows
    .map((r) => {
      const v = d.intentTotals[r.id] ?? 0;
      return `<div class="bar"><span class="bar-label">${esc(r.label)}</span><span class="bar-track"><span class="bar-fill i-${r.id}" style="width:${Math.round((v / max) * 100)}%"></span></span><span class="bar-val">${v}</span></div>`;
    })
    .join('');
}

const chip = (t) => `<span class="chip i-${t.intents[0] ?? 'other'}">${esc(t.term)}<small>${t.hits}</small></span>`;

const CHIPS_SHOWN = 12;

function termChips(terms) {
  const shown = terms.slice(0, CHIPS_SHOWN).map(chip).join('');
  const rest = terms.slice(CHIPS_SHOWN, 24);
  if (!rest.length) return `<div class="chips">${shown}</div>`;
  return `<div class="chips">${shown}</div>
<details class="more"><summary>残り${rest.length}語を見る</summary><div class="chips">${rest.map(chip).join('')}</div></details>`;
}

// 意図の短い呼び名（凡例で使う）。INTENTS の label から括弧の前だけを取る
const INTENT_SHORT = Object.fromEntries([...INTENTS.map((i) => [i.id, i.label.replace(/（.*$/, '')]), ['other', 'その他']]);
const VERDICT_ORDER = ['target', 'crowded', 'gap', 'thin', 'unknown'];

/**
 * 冒頭に置く「ひと目で」の材料。供給の判定を数えて、一番多い判定と、その語の意図がそろっているかだけを見る。
 * 新しい解釈は足さない（判定と意図はどちらも result.json に入っている値）
 */
export function summarize(supply) {
  const n = supply.length;
  if (!n) return null;
  const groups = VERDICT_ORDER.concat(supply.map((s) => s.verdict).filter((v) => !VERDICT_ORDER.includes(v)))
    .map((verdict) => ({ verdict, rows: supply.filter((s) => s.verdict === verdict) }))
    .filter((g) => g.rows.length)
    .sort((a, b) => b.rows.length - a.rows.length); // 同数なら VERDICT_ORDER の順
  const top = groups[0];
  const label = (v) => VERDICT_LABEL[v]?.label ?? v;
  const tie = groups[1] && groups[1].rows.length === top.rows.length;

  let line;
  if (tie) line = `測った${n}語の内訳: ${groups.map((g) => `「${label(g.verdict)}」${g.rows.length}語`).join('、')}`;
  else if (top.rows.length === n) line = `測った${n}語すべてが「${label(top.verdict)}」`;
  else line = `測った${n}語のうち${top.rows.length}語が「${label(top.verdict)}」`;

  // 一番多い判定の語（2語以上）が、全部同じ意図を持つときだけ書き添える
  let sharedIntent = null;
  if (!tie && top.rows.length >= 2) {
    sharedIntent = INTENTS.map((i) => i.id).find((id) => top.rows.every((s) => (s.intents ?? []).includes(id))) ?? null;
    if (sharedIntent) line += `。その${top.rows.length}語は、すべて「${INTENTS.find((i) => i.id === sharedIntent).label}」の語`;
  }
  return { n, top: { verdict: top.verdict, count: top.rows.length }, tie, sharedIntent, line, groups };
}

// 検索語からテーマの部分を外して短く見せる（表示だけ。テーマで始まらない語はそのまま）
function shortKeyword(keyword, theme) {
  const k = String(keyword);
  const t = String(theme ?? '').trim().toLowerCase();
  return t && k.toLowerCase().startsWith(`${t} `) ? k.slice(t.length + 1) : k;
}

function gistBox(r, s) {
  const ev = r.evidence;
  const evOk = ev?.ok;
  const count = (items) => (evOk ? `${items?.length ?? 0}件` : '記録なし');
  const stats = `<nav class="stats">
<a href="#money"><b>${count(ev?.payments)}</b><span>お金の根拠</span></a>
<a href="#counter"><b>${count(ev?.counters)}</b><span>反証</span></a>
<a href="#next"><b>${evOk && ev.next_check ? '1つ' : '記録なし'}</b><span>次に確かめる</span></a>
</nav>`;
  const note = '<p class="gist-note">判断の材料です。「やる／やらない」は書いていません。</p>';
  if (!s) return `<section class="gist"><p class="none">席の空きは記録なし</p>${stats}</section>${note}`;

  const used = new Set(r.supply.map((x) => x.intents?.[0] ?? 'other'));
  const legend = [...INTENTS.map((i) => i.id), 'other']
    .filter((id) => used.has(id))
    .map((id) => `<span><i class="dot i-${id}"></i>${esc(INTENT_SHORT[id])}</span>`)
    .join('');
  const groups = s.groups
    .map(
      (g) => `<div class="vgroup">
<div class="vgroup-h"><span class="verdict v-${esc(g.verdict)}">${esc(VERDICT_LABEL[g.verdict]?.label ?? g.verdict)}</span><span class="vgroup-n">${g.rows.length}語</span></div>
<div class="chips">${g.rows.map((x) => `<span class="chip i-${x.intents?.[0] ?? 'other'}">${esc(shortKeyword(x.keyword, r.theme))}</span>`).join('')}</div>
</div>`,
    )
    .join('');
  return `<section class="gist">
<div class="big v-${esc(s.top.verdict)}"><b>${s.top.count}</b><span>/${s.n}語</span></div>
<p class="gist-line">${esc(s.line)}</p>
<div class="gist-map">
<div class="legend-inline">語の色: ${legend}</div>
${groups}
</div>
${stats}
</section>
${note}`;
}

function verdictNotes(s) {
  if (!s) return '';
  return `<ul class="vnotes">${s.groups
    .map((g) => `<li><span class="verdict v-${esc(g.verdict)}">${esc(VERDICT_LABEL[g.verdict]?.label ?? g.verdict)}</span>${esc(VERDICT_LABEL[g.verdict]?.note ?? '')}</li>`)
    .join('')}</ul>`;
}

function supplyTable(rows) {
  if (!rows.length) return NONE;
  const body = rows
    .map((r) => {
      const v = VERDICT_LABEL[r.verdict] ?? { label: r.verdict };
      const fmt = r.best_format === 'short' ? 'Shorts' : r.best_format === 'long' ? '通常動画' : '—';
      return `<tr>
<td class="kw">${esc(r.keyword)}</td>
<td data-label="席の空き"><span class="verdict v-${esc(r.verdict)}">${esc(v.label)}</span></td>
<td class="n" data-label="直近1年の本数"><span>${num(r.recent_count)}<small>/${num(r.sampled)}</small></span></td>
<td class="n" data-label="上位の登録者（中央値）">${compact(r.rival_median_subs)}</td>
<td class="n" data-label="直近の再生 Shorts">${compact(r.median_short)}</td>
<td class="n" data-label="直近の再生 通常">${compact(r.median_long)}</td>
<td data-label="回りやすい形式">${fmt}</td>
</tr>`;
    })
    .join('');
  return `<div class="tbl"><table>
<thead><tr><th>検索語</th><th>席の空き</th><th>直近1年の本数<br><small>/上位の本数</small></th><th>上位チャンネルの<br>登録者（中央値）</th><th>直近の再生<br>Shorts（中央値）</th><th>直近の再生<br>通常（中央値）</th><th>回りやすい形式</th></tr></thead>
<tbody>${body}</tbody></table></div>`;
}

// サムネは保存せず YouTube の画像を直接表示する（権利は作者にある。差し替えられたら今の画像になる）
export const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
export const watch = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

function duration(sec, isLive) {
  if (isLive) return 'ライブ';
  if (sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 回っている：直近1年の動画で、登録者数より多く再生されている */
const HOT_RATIO = 1;
/** 新しいチャンネル：開設から半年以内に出た動画 */
const NEW_CHANNEL_DAYS = 183;
const isHot = (v) => v.age_days <= 365 && v.ratio >= HOT_RATIO;
const monthOf = (days) => Math.floor(days / 30.4) + 1;

function tags(v) {
  const t = [];
  if (isHot(v)) t.push(`<span class="tag hot">登録者の${v.ratio}倍</span>`);
  if (v.channel_age_days != null && v.channel_age_days <= NEW_CHANNEL_DAYS) t.push(`<span class="tag new">開設${monthOf(v.channel_age_days)}ヶ月目の動画</span>`);
  if (v.is_short) t.push('<span class="tag">Shorts</span>');
  return t.join('');
}

function tile(v, i) {
  const d = duration(v.duration_seconds, v.is_live);
  return `<a class="tile${isHot(v) ? ' is-hot' : ''}" href="${watch(v.video_id)}" target="_blank" rel="noopener noreferrer">
<span class="thumb"><img src="${thumb(v.video_id)}" alt="" loading="lazy" width="320" height="180"><span class="rank">${i + 1}</span>${d ? `<span class="dur">${esc(d)}</span>` : ''}</span>
<span class="t-title">${esc(v.title)}</span>
<span class="t-meta">${esc(v.channel)} ・ 登録者 ${v.subscribers == null ? '非公開' : compact(v.subscribers)}</span>
<span class="t-meta">${compact(v.views)}回再生 ・ ${num(v.age_days)}日前</span>
${tags(v) ? `<span class="tags">${tags(v)}</span>` : ''}
</a>`;
}

function wallGrid(row) {
  const hot = row.wall.filter(isHot).length;
  return `<p class="wall-kw">「${esc(row.keyword)}」の上位${row.wall.length}本<small>うち回っている動画 ${hot}本</small></p>
<div class="wall">${row.wall.map(tile).join('')}</div>`;
}

function walls(rows) {
  const withWall = rows.filter((r) => r.wall?.length);
  if (!withWall.length) return NONE;
  const [first, ...rest] = withWall;
  return `${wallGrid(first)}
${rest.map((r) => `<details class="more"><summary>「${esc(r.keyword)}」の並びを見る</summary>${wallGrid(r)}</details>`).join('')}`;
}

function leaders(rows) {
  const all = rows.flatMap((r) => (r.leaders ?? []).map((l) => ({ ...l, keyword: r.keyword })));
  const seen = new Set();
  const uniq = all.filter((l) => (seen.has(l.channel_id) ? false : seen.add(l.channel_id))).sort((a, b) => b.ratio - a.ratio).slice(0, 6);
  if (!uniq.length) return NONE;
  return `<div class="cards">${uniq
    .map(
      (l) => `<div class="card lead">
<a class="thumb" href="${watch(l.video_id)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(l.video_title)}"><img src="${thumb(l.video_id)}" alt="" loading="lazy" width="320" height="180"></a>
<div class="lead-ch">${esc(l.channel)}</div>
<div class="lead-meta">登録者 ${l.subscribers == null ? '非公開' : compact(l.subscribers)}${l.started_at ? ` ・ 開設 ${esc(l.started_at)}` : ''}</div>
<a class="lead-video" href="${watch(l.video_id)}" target="_blank" rel="noopener noreferrer">${esc(l.video_title)}</a>
<div class="lead-meta">${compact(l.views)}回再生 ・ ${num(l.age_days)}日前 ・ ${l.is_live ? 'ライブ配信' : l.is_short ? 'Shorts' : '通常動画'} ・ 登録者の${l.ratio}倍</div>
${l.channel_age_days != null && l.channel_age_days <= NEW_CHANNEL_DAYS ? `<div class="tags"><span class="tag new">開設${monthOf(l.channel_age_days)}ヶ月目の動画</span></div>` : ''}
<div class="lead-kw">見つかった検索語: ${esc(l.keyword)}</div>
</div>`,
    )
    .join('')}</div>`;
}

export function evidenceList(items) {
  if (!items?.length) return NONE;
  return `<ul class="ev">${items
    .map((e) => {
      let host = '';
      try { host = new URL(e.url).hostname.replace(/^www\./, ''); } catch { /* 表示だけ */ }
      const kinds = (e.kinds ?? []).map((k) => KIND_LABEL[k] ?? k).join('・');
      return `<li><span>${esc(e.claim)}</span><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(host)}</a><small>${esc(kinds)}</small></li>`;
    })
    .join('')}</ul>`;
}

/** 結果ページの共通の見た目。調べ切り版（src/deep/report.js）も使う */
export const REPORT_CSS = `:root{--bg:#fafaf7;--card:#fff;--ink:#1f2328;--sub:#59636e;--line:#d8dee4;--accent:#1f6f5c;--soft:#e3f1ec;--gray:#f1f3f5;
--maker:#2554a6;--viewer:#1f6f5c;--compare:#8a4fb0;--price:#9a5b00;--other:#8c959f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 64px;overflow-wrap:anywhere}
header .brand{font-size:.8rem;color:var(--sub);letter-spacing:.05em}
h1{font-size:1.5rem;margin:4px 0 2px;line-height:1.35}
.meta{color:var(--sub);font-size:.82rem}
h2{font-size:1.1rem;margin:34px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h2 small{font-weight:400;color:var(--sub);font-size:.78rem;margin-left:6px}
.gist{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px 12px;margin:14px 0 6px;box-shadow:0 1px 2px rgba(31,35,40,.05)}
.big{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 8px;line-height:1.1}
.big b{font-size:3rem;font-weight:800;letter-spacing:-.02em}
.big span{font-size:1.1rem;color:var(--sub);font-weight:600}
.big.v-target b{color:#155c3b}.big.v-crowded b{color:#8b2d2d}.big.v-gap b{color:#8a5200}
.big.v-target,.big.v-crowded,.big.v-gap,.big.v-thin,.big.v-unknown{background:none}
.gist-line{font-size:1.08rem;font-weight:700;line-height:1.6;margin:6px 0 12px}
.gist-map{border-top:1px solid var(--line);padding-top:10px}
.legend-inline,.legend{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:.76rem;color:var(--sub);margin:0 0 6px}
.dot{display:inline-block;width:.7em;height:.7em;border-radius:50%;margin-right:4px;vertical-align:-.05em}
.vgroup{margin:8px 0}
.vgroup-h{display:flex;align-items:center;gap:8px}
.vgroup-n{font-size:.8rem;color:var(--sub)}
.vgroup .chips{margin-top:6px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px;border-top:1px solid var(--line);padding-top:12px}
.stats a{display:flex;flex-direction:column;align-items:center;text-align:center;gap:2px;background:var(--gray);border-radius:10px;padding:8px 4px;color:var(--ink);text-decoration:none}
.stats b{font-size:1.1rem}
.stats span{font-size:.72rem;color:var(--sub);line-height:1.35}
.gist-note{font-size:.78rem;color:var(--sub);margin:0 2px 8px}
.vnotes{list-style:none;padding:0;margin:8px 0}
.vnotes li{font-size:.86rem;margin:4px 0;display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}
details.more{margin-top:10px}
details.more>summary{cursor:pointer;color:var(--accent);font-size:.86rem;padding:6px 0}
.none{color:var(--sub);font-style:italic}
.bar{display:grid;grid-template-columns:minmax(120px,190px) 1fr 32px;gap:8px;align-items:center;font-size:.86rem;margin:4px 0}
.bar-track{background:var(--gray);border-radius:4px;height:12px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:4px}
.bar-val{text-align:right;color:var(--sub)}
.i-maker{background:var(--maker)}.i-viewer{background:var(--viewer)}.i-compare{background:var(--compare)}.i-price{background:var(--price)}.i-other{background:var(--other)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{color:#fff;border-radius:99px;padding:2px 10px;font-size:.82rem}
.chip small{opacity:.8;margin-left:6px}
.legend{margin-top:12px}
.tbl{overflow-x:auto;margin-top:8px}
table{border-collapse:collapse;width:100%;min-width:640px;font-size:.84rem;background:var(--card)}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--gray);font-weight:600;font-size:.78rem}
td.n{text-align:right;white-space:nowrap}
td small,th small{color:var(--sub);font-weight:400}
td.kw{font-weight:600}
.verdict{display:inline-block;border-radius:4px;padding:0 6px;font-size:.78rem;white-space:nowrap}
.v-target{background:#dff3e8;color:#155c3b}.v-gap{background:#fdf3e1;color:#8a5200}.v-crowded{background:#f3e3e3;color:#8b2d2d}.v-thin,.v-unknown{background:var(--gray);color:var(--sub)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.lead-ch{font-weight:700}
.lead .thumb{margin:-2px -4px 8px}
.thumb{position:relative;display:block;aspect-ratio:16/9;background:var(--gray);border-radius:8px;overflow:hidden}
.thumb img{display:block;width:100%;height:100%;object-fit:cover}
.rank{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.72);color:#fff;font-size:.72rem;font-weight:700;border-radius:4px;padding:0 6px}
.dur{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.8);color:#fff;font-size:.72rem;border-radius:4px;padding:0 5px}
.wall-kw{font-weight:700;margin:14px 0 6px}
.wall-kw small{font-weight:400;color:var(--sub);font-size:.8rem;margin-left:8px}
.wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px 12px}
.tile{display:flex;flex-direction:column;gap:2px;color:var(--ink);text-decoration:none;border-radius:10px;padding:4px;border:2px solid transparent}
.tile.is-hot{border-color:#2f9e6a;background:#f0faf4}
.t-title{font-size:.84rem;font-weight:600;line-height:1.45;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.t-meta{font-size:.74rem;color:var(--sub);line-height:1.5}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.tag{font-size:.7rem;border-radius:4px;padding:0 6px;background:var(--gray);color:var(--sub)}
.tag.hot{background:#dff3e8;color:#155c3b;font-weight:700}
.tag.new{background:#e7eefb;color:#2554a6}
.wall-note{font-size:.82rem;color:var(--sub);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0}
.wall-note b{color:var(--ink)}
.lead-meta,.lead-kw{font-size:.78rem;color:var(--sub)}
.lead-video{display:block;margin:4px 0;color:var(--accent);font-size:.88rem;word-break:break-word}
.ev{list-style:none;padding:0;margin:8px 0}
.ev li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:6px 0;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
.ev li span{flex:1 1 100%}
.ev a{color:var(--accent);font-size:.82rem}
.ev small{color:var(--sub);font-size:.74rem}
ul.plain{margin:6px 0;padding-left:1.2em}
.next{background:#e7eefb;border:1px solid #9fb6e0;border-radius:10px;padding:12px 14px}
@media (max-width:640px){
  .wall{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 8px}
  table{min-width:0}
  thead{display:none}
  table,tbody,tr,td{display:block;width:100%}
  tr{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:6px 10px;background:var(--card)}
  td{border:0;padding:2px 0;display:flex;justify-content:space-between;gap:12px;text-align:right}
  td.kw{font-size:.95rem;text-align:left;display:block}
  td[data-label]::before{content:attr(data-label);color:var(--sub);font-size:.78rem;text-align:left}
}
footer{margin-top:40px;font-size:.78rem;color:var(--sub);border-top:1px solid var(--line);padding-top:12px}
footer ul{padding-left:1.2em;margin:4px 0}
`;

export function renderReport(r) {
  const ev = r.evidence;
  const evOk = ev?.ok;
  const s = summarize(r.supply);
  const costText = r.cost?.llm?.usd != null ? `$${r.cost.llm.usd.toFixed(3)}（推定）` : '未計測';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>下見: ${esc(r.theme)}</title>
<style>
${REPORT_CSS}</style>
</head>
<body>
<main>
<header>
<div class="brand">shitami ・ 需要の下見</div>
<h1>${esc(r.theme)}</h1>
<div class="meta">対象: ${esc(r.regionLabel)} ／ 取得日: ${esc(r.date)} ／ 測った検索語: ${r.supply.length}語</div>
</header>

${gistBox(r, s)}

<h2>1. 検索されているか<small>テーマを含む検索候補 ${num(r.demand.onThemeTerms ?? r.demand.uniqueTerms)}語から</small></h2>
<p>「${esc(r.theme)}」に続けて入力されやすい語を、検索意図で分けました。数字は検索候補に出た回数で、検索回数そのものではありません。</p>
${intentBars(r.demand)}
<div class="legend">語の色: <span><i class="dot i-maker"></i>作る側</span><span><i class="dot i-viewer"></i>聴く・使う側</span><span><i class="dot i-compare"></i>比較</span><span><i class="dot i-price"></i>無料・料金</span><span><i class="dot i-other"></i>その他</span></div>
${termChips(r.demand.terms)}

<h2>2. 席は空いているか<small>検索上位50本を測定</small></h2>
<p>各語で検索したときの上位50本のうち、直近1年に出た動画の数と、上位を占めるチャンネルの規模を比べました。語ごとの判定は冒頭のとおりです。</p>
${verdictNotes(s)}
${r.supply.length ? `<details class="more"><summary>語ごとの数字を見る（${r.supply.length}語）</summary>${supplyTable(r.supply)}</details>` : NONE}

<h2>3. 検索結果に並ぶサムネ<small>YouTube の検索画面と同じ順</small></h2>
<p>その語で検索したときに、あなたの動画と並ぶことになる上位の動画です。自分のサムネをこの中に置いたとき、テーマに合って見えるか・目に留まるかを確かめる材料にしてください。</p>
<div class="wall-note"><b>緑の枠</b>＝直近1年の動画で、登録者数より多く再生されているもの。<b>開設○ヶ月目</b>＝チャンネルを始めて半年以内に出た動画（始めたばかりでも届いた例）。<br>伸びた理由がサムネだとは限りません。サムネが何割クリックされたかは作者の管理画面でしか見られないため、ここでは並べるだけにしています。</div>
${walls(r.supply)}

<h2>4. 先行事例<small>登録者数の割に回っている直近の動画</small></h2>
${leaders(r.supply)}

<h2 id="money">5. お金が動いているか</h2>
${evOk ? evidenceList(ev.payments) : `<p class="none">${esc(ev?.reason ?? '調べていません')}</p>`}

<h2 id="counter">6. 反証（成り立たない・難しい根拠）</h2>
${evOk ? evidenceList(ev.counters) : NONE}

<h2>7. まだ分からないこと</h2>
${evOk && ev.unknowns.length ? `<ul class="plain">${ev.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : NONE}

<h2 id="next">8. 次に確かめる1つ</h2>
${evOk && ev.next_check ? `<div class="next">${esc(ev.next_check)}</div>` : NONE}

<footer>
<div>データの出どころと注意</div>
<ul>
<li>検索候補: YouTube の検索候補（${esc(r.regionLabel)}向け）。公式に提供されている API ではないため、件数は目安です</li>
<li>席の空き: YouTube Data API（${esc(r.date)} 時点の検索結果・再生数・登録者数）。判定のしきい値は yt-research-radar の実測から決めた値です</li>
<li>サムネ: YouTube の画像を直接表示しています（保存していません）。作者が差し替えると、取得日とは違う画像が出ることがあります。権利は各動画の作者にあります</li>
<li>お金の根拠・反証: Web 検索（${esc(ev?.model ?? '—')}）。調査で実際に参照した URL が付いている項目だけを載せています${evOk && ev.dropped ? `（参照先を確認できず外した項目 ${ev.dropped}件）` : ''}</li>
<li>この1枚の調査費用: ${esc(costText)} ／ YouTube 検索 ${num(r.quota?.searchCalls)}回</li>
</ul>
</footer>
</main>
</body>
</html>`;
}
