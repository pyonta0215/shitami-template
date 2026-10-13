// 調べ切り版の結果 JSON から報告ページを作る。LLM は呼ばない（同じ JSON からは常に同じページ）。
//
// 書き方の約束は1枚版と同じ:
//   - 「やるべき」とは書かない。材料と反証と、人が確かめることを出す
//   - 埋まらなかった欄は「記録なし」
//   - 数字には取得日と出どころを付け、推定は推定と書く

import { esc, num, compact, thumb, watch, evidenceList, NONE, REPORT_CSS } from '../report.js';
import { QUADRANTS } from './analyze.js';
import { CUTS } from './plan.js';

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const FMT = { long: '通常動画', short: 'Shorts', live: 'ライブ', unknown: '不明' };
const DIRECTION = { map: '共通の地図', niche: '① ニッチ', copy: '② 真似' };

const EXTRA_CSS = `
.q-copy{background:#f5ecdd;color:#7a4e10}.q-go{background:#dff3e8;color:#155c3b}.q-niche{background:#e4ebf4;color:#2d4f7c}.q-avoid{background:#f3e3e3;color:#8b2d2d}.q-tiny{background:var(--gray);color:var(--sub)}
.qpill{display:inline-block;border-radius:4px;padding:0 6px;font-size:.78rem;white-space:nowrap}
.mapfig{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;overflow-x:auto}
.mapfig svg{display:block;width:100%;min-width:560px;height:auto}
.mapfig text{font-family:inherit}
.dir{font-size:.72rem;font-weight:700;letter-spacing:.04em;color:var(--sub)}
.card h3{font-size:1rem;margin:2px 0 4px;line-height:1.45}
.kv{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:.82rem;margin:6px 0}
.kv dt{color:var(--sub)}
.kv dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.deep-cards{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
.flags{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
.flag{font-size:.72rem;border-radius:4px;padding:0 6px;background:var(--gray);color:var(--sub)}
.flag.on{background:#dff3e8;color:#155c3b;font-weight:600}
.flag.warn{background:#f3e3e3;color:#8b2d2d}
.card.copyable{border-color:#2f9e6a}
.mini{font-size:.78rem;color:var(--sub)}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0;font-size:.78rem}
.compare div{background:var(--gray);border-radius:6px;padding:6px 8px}
.compare b{display:block;font-size:.72rem;color:var(--sub);font-weight:600}
.task{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}
.task-h{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.task-h b{font-size:.95rem}
.task .why,.task .how{font-size:.84rem;margin:4px 0 0}
.task .why{color:var(--sub)}
.task .hint{font-size:.82rem;background:#e7eefb;border-radius:6px;padding:6px 10px;margin-top:6px}
.task .links a{font-size:.8rem;color:var(--accent);margin-right:10px}
.prio{font-size:.72rem;border-radius:4px;padding:0 6px;background:var(--gray);color:var(--sub);font-variant-numeric:tabular-nums}
.kill li{margin:4px 0}
.kill .hit{color:#8b2d2d;font-weight:700}
.kill .miss{color:#155c3b}
`;

// ---- 漁場マップの図（魚の量は対数、釣り人の数はそのまま） ----
function mapSvg(map) {
  const rows = map.rows.filter((r) => r.fishSum > 0);
  if (rows.length < 2) return NONE;
  const W = 720, H = 380, L = 70, R = 20, T = 20, B = 50;
  const lx = (v) => Math.log10(Math.max(1, v));
  const xs = rows.map((r) => lx(r.fishSum));
  const x0 = Math.floor(Math.min(...xs));
  const x1 = Math.max(Math.ceil(Math.max(...xs)), x0 + 1);
  const yMax = Math.ceil(Math.max(5, ...rows.map((r) => r.anglers90)) * 1.15);
  const X = (v) => L + ((lx(v) - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => H - B - (v / yMax) * (H - T - B);
  const COLORS = { copy: '#9a6b1f', go: '#1f8a5a', niche: '#2d4f7c', avoid: '#9b2f2f', tiny: '#8c959f' };
  const ticks = [];
  for (let e = x0; e <= x1; e += 1) ticks.push(`<line x1="${X(10 ** e)}" y1="${T}" x2="${X(10 ** e)}" y2="${H - B}" stroke="#eef0f2"/><text x="${X(10 ** e)}" y="${H - B + 16}" font-size="11" text-anchor="middle" fill="#59636e">${compact(10 ** e)}</text>`);
  const yTicks = [0, Math.round(yMax / 2), yMax].map((v) => `<text x="${L - 8}" y="${Y(v) + 4}" font-size="11" text-anchor="end" fill="#59636e">${v}</text>`);
  const mx = map.fishMid ? X(map.fishMid) : null;
  const my = map.anglerMid != null ? Y(map.anglerMid) : null;
  // ラベルが重ならないよう、上下にずらせる位置を順に試す（釣り人の数は整数なので同じ高さに並びやすい）
  const placed = rows.map((r) => ({ x0: X(r.fishSum) - 6, x1: X(r.fishSum) + 6, y: Y(r.anglers90) + 4 }));
  const pts = rows.map((r) => {
    const cx = X(r.fishSum), cy = Y(r.anglers90);
    const label = r.term.length > 18 ? `${r.term.slice(0, 17)}…` : r.term;
    const w = [...label].reduce((s, c) => s + (c.charCodeAt(0) > 255 ? 10.5 : 6), 0);
    const left = cx > W * 0.7;
    const x0 = left ? cx - 7 - w : cx + 7;
    let dy = 0;
    for (const d of [0, 12, -12, 24, -24, 36, -36]) {
      const y = cy + 4 + d;
      if (!placed.some((p) => x0 < p.x1 && x0 + w > p.x0 && Math.abs(y - p.y) < 12)) { dy = d; break; }
    }
    placed.push({ x0, x1: x0 + w, y: cy + 4 + dy });
    return {
      dot: `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${COLORS[r.quadrant]}" fill-opacity=".85"><title>${esc(r.term)}: 再生合計 ${num(r.fishSum)}・釣り人 ${r.anglers90}</title></circle>`,
      // 点より後に描いて、ほかの点に隠れないようにする（白い縁取りで読みやすく）
      text: `<text x="${(left ? cx - 7 : cx + 7).toFixed(1)}" y="${(cy + 4 + dy).toFixed(1)}" font-size="10.5" fill="#1f2328" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="${left ? 'end' : 'start'}">${esc(label)}</text>`,
    };
  });
  return `<div class="mapfig"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="漁場マップ。横が魚の量、縦が釣り人の数">
${ticks.join('')}
<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#8c959f"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#8c959f"/>
${mx ? `<line x1="${mx}" y1="${T}" x2="${mx}" y2="${H - B}" stroke="#b9c2cc" stroke-dasharray="4 4"/>` : ''}
${my != null ? `<line x1="${L}" y1="${my}" x2="${W - R}" y2="${my}" stroke="#b9c2cc" stroke-dasharray="4 4"/>` : ''}
<text x="${W - R - 4}" y="${T + 14}" font-size="12" text-anchor="end" fill="#9a6b1f" font-weight="700">② 真似で入る漁場</text>
<text x="${L + 6}" y="${H - B - 8}" font-size="12" fill="#2d4f7c" font-weight="700">① ニッチの池</text>
<text x="${W - R - 4}" y="${H - B - 8}" font-size="12" text-anchor="end" fill="#1f8a5a" font-weight="700">すぐ入る</text>
<text x="${L + 6}" y="${T + 14}" font-size="12" fill="#9b2f2f" font-weight="700">避ける</text>
${yTicks.join('')}
${pts.map((p) => p.dot).join('')}
${pts.map((p) => p.text).join('')}
<text x="${(L + W - R) / 2}" y="${H - 10}" font-size="12" text-anchor="middle" fill="#59636e">魚の量（上位50本のうち直近1年の動画の再生合計・対数）→ 多い</text>
<text x="16" y="${(T + H - B) / 2}" font-size="12" text-anchor="middle" fill="#59636e" transform="rotate(-90 16 ${(T + H - B) / 2})">釣り人の数（直近90日に投稿）→</text>
</svg></div>`;
}

function mapTable(map, tri) {
  if (!map.rows.length) return NONE;
  const triBy = new Map(tri.map((t) => [t.term, t]));
  const body = map.rows.slice().sort((a, b) => b.fishSum - a.fishSum).map((r) => {
    const t = triBy.get(r.term);
    const layers = t ? [t.searched ? '検索' : null, t.watched ? '視聴' : null, t.paid ? 'お金' : null].filter(Boolean).join('・') || '—' : '—';
    return `<tr><td class="kw">${esc(r.term)}</td>
<td data-label="置き場所"><span class="qpill q-${r.quadrant}">${esc(QUADRANTS[r.quadrant].label)}</span></td>
<td class="n" data-label="魚（再生合計）">${compact(r.fishSum)}</td>
<td class="n" data-label="再生中央値">${compact(r.fishMedian)}</td>
<td class="n" data-label="釣り人（90日）">${num(r.anglers90)}</td>
<td class="n" data-label="古い動画の居座り">${pct(r.staleRate)}</td>
<td class="n" data-label="小さなチャンネルの上位率">${pct(r.smallTopRate)}</td>
<td class="n" data-label="お金のリンク">${pct(r.money)}</td>
<td data-label="そろった層">${esc(layers)}${t?.verdict === 'demand' ? ' <b>需要あり</b>' : ''}</td></tr>`;
  }).join('');
  return `<div class="tbl"><table><thead><tr><th>検索語</th><th>置き場所</th><th>魚<br><small>直近1年の再生合計</small></th><th>再生中央値</th><th>釣り人<br><small>直近90日</small></th><th>古い動画の<br>居座り率</th><th>登録者1万人未満の<br>上位率</th><th>お金の<br>リンク</th><th>三角測量</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function nicheCard(n) {
  return `<div class="card">
<div class="dir">① ニッチカード</div>
<h3><a href="https://www.youtube.com/results?search_query=${encodeURIComponent(n.term)}" target="_blank" rel="noopener noreferrer">${esc(n.term)}</a></h3>
<dl class="kv">
<dt>新しく来た人の再生中央値</dt><dd>${compact(n.catchMedian)}</dd>
<dt>釣り人（直近90日）</dt><dd>${num(n.anglers90)}</dd>
<dt>直近30日の新しい投稿</dt><dd>${num(n.uploads30)}本</dd>
<dt>池の大きさ（再生合計）</dt><dd>${compact(n.poolSum)}</dd>
<dt>古い動画の居座り率</dt><dd>${pct(n.staleRate)}</dd>
<dt>小さなチャンネルの上位率</dt><dd>${pct(n.smallTopRate)}</dd>
<dt>尺別の再生中央値 Shorts</dt><dd>${compact(n.formats?.short)}</dd>
<dt>尺別の再生中央値 通常</dt><dd>${compact(n.formats?.long)}</dd>
<dt>別の地域の釣り人</dt><dd>${n.otherRegion ? num(n.otherRegion.anglers90) : '—'}</dd>
<dt>お金のリンク</dt><dd>${pct(n.money)}</dd>
</dl>
<div class="flags">${n.regionGap ? '<span class="flag on">海外にはいて国内にはいない</span>' : ''}${n.tiny ? '<span class="flag warn">池が小さすぎる</span>' : ''}${(n.staleRate ?? 0) >= 0.3 ? '<span class="flag on">供給が追いついていない</span>' : ''}</div>
</div>`;
}

function anglerCard(a) {
  const f = a.flags;
  const flag = (on, text, warn = false) => `<span class="flag${on ? (warn ? ' warn' : ' on') : ''}">${text}</span>`;
  const best = a.best[0];
  const pat = (p) => (p?.length ? p.map((x) => esc(x.token)).join('・') : '—');
  const fmtMix = (m) => `通常${pct(m.long)}・Shorts${pct(m.short)}`;
  return `<div class="card${a.copyable ? ' copyable' : ''}">
<div class="dir">② 釣り人カード${a.copyable ? ' ・ 真似の手本の候補' : ''}</div>
${best ? `<a class="thumb" href="${watch(best.video_id)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(best.title)}"><img src="${thumb(best.video_id)}" alt="" loading="lazy" width="320" height="180"></a>` : ''}
<h3><a href="https://www.youtube.com/channel/${encodeURIComponent(a.channel_id)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3>
<div class="flags">${flag(f.newcomer, '開設2年以内')}${flag(f.repeated, `当たり${a.hits}本`)}${flag(f.personal_pace, `週${a.per_week}本`)}${flag(f.pattern_visible, '題名の型あり')}${flag(f.on_theme, `テーマの動画 ${pct(a.on_theme)}`)}${f.too_big ? flag(true, '大手（手本にしない）', true) : ''}${f.small ? flag(true, '登録者1,000人未満', true) : ''}</div>
<dl class="kv">
<dt>登録者</dt><dd>${a.subscribers == null ? '非公開' : compact(a.subscribers)}</dd>
<dt>開設</dt><dd title="${esc(a.started_at ?? '')}">${a.age_days == null ? '—' : `${num(a.age_days)}日前`}</dd>
<dt>最初の当たり</dt><dd>${a.first_hit ? `${a.first_hit.nth}本目・${num(a.first_hit.days_from_start)}日目` : '—'}</dd>
<dt>当たり率（中央値の3倍超）</dt><dd>${pct(a.hit_rate)}</dd>
<dt>形式</dt><dd>${fmtMix(a.formats)}</dd>
<dt>通常動画の尺（中央値）</dt><dd>${a.long_minutes == null ? '—' : `${a.long_minutes}分`}</dd>
<dt>お金のリンク</dt><dd>${pct(a.money)}</dd>
</dl>
<div class="mini">題名の型: ${pat(a.pattern)}</div>
<div class="compare"><div><b>最初の10本</b>再生中央値 ${compact(a.first10.median_views)}<br>${fmtMix(a.first10.formats)}<br>型: ${pat(a.first10.pattern)}</div><div><b>最新の10本</b>再生中央値 ${compact(a.last10.median_views)}<br>${fmtMix(a.last10.formats)}<br>型: ${pat(a.last10.pattern)}</div></div>
${best ? `<div class="mini">一番の当たり: <a href="${watch(best.video_id)}" target="_blank" rel="noopener noreferrer">${esc(best.title)}</a>（${best.multiplier}倍・${compact(best.views)}回）</div>` : ''}
<div class="mini">見つかった検索語: ${esc(a.found_by.join('、') || '—')}</div>
</div>`;
}

function outlierTiles(o) {
  const list = o.list.filter((x) => !x.small).slice(0, 12);
  if (!list.length) return NONE;
  return `<div class="wall">${list.map((v) => `<a class="tile${v.extreme ? '' : ' is-hot'}" href="${watch(v.video_id)}" target="_blank" rel="noopener noreferrer">
<span class="thumb"><img src="${thumb(v.video_id)}" alt="" loading="lazy" width="320" height="180"></span>
<span class="t-title">${esc(v.title)}</span>
<span class="t-meta">${esc(v.channel)} ・ 登録者 ${v.subscribers == null ? '非公開' : compact(v.subscribers)}</span>
<span class="t-meta">${compact(v.views)}回 ・ ${num(v.age_days)}日前 ・ ${esc(FMT[v.fmt] ?? v.fmt)}</span>
<span class="tags"><span class="tag hot">チャンネル内の${v.multiplier}倍</span>${v.extreme ? '<span class="tag">20倍超（再現しにくい）</span>' : ''}${v.money ? '<span class="tag new">お金のリンクあり</span>' : ''}</span>
</a>`).join('')}</div>`;
}

function signalTable(s) {
  const rows = [
    ['似た名前のチャンネルの群れ（最大）', `${num(s.clones)}チャンネル`, '混み始めた兆候', 'その型は他人にも再現できた証拠'],
    ['釣り人の数（中央値・直近90日）', num(s.anglersMedian), '多ければ避ける理由', '魚がいる証拠で、手本も多い'],
    ['上位に古い動画が残っている割合（平均）', pct(s.staleRate), '高いほど好機（供給が追いついていない）', '高いほど手本が古い（今の型が無い）'],
    ['上位に大手（登録者100万人以上）がいる割合', pct(s.bigTopRate), '小さな池なら影響が小さい', '大手は手本から外す'],
    ['外れ値の上位3チャンネルへの集中', pct(s.concentration), '高ければ新しい人は釣れていない', '同左'],
    ['海外にはいて国内にはいない池', `${num(s.regionGaps)}件`, '輸入できる池の候補', '海外の手本を真似できる'],
  ];
  return `<div class="tbl"><table><thead><tr><th>信号</th><th>このテーマの値</th><th>① ニッチ探しでは</th><th>② 真似探しでは</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="kw">${esc(r[0])}</td><td class="n" data-label="値">${esc(r[1])}</td><td data-label="① ニッチ">${esc(r[2])}</td><td data-label="② 真似">${esc(r[3])}</td></tr>`).join('')}</tbody></table></div>`;
}

function taskList(tasks) {
  return tasks.map((t) => `<div class="task">
<div class="task-h"><b>${esc(t.task)}</b><span class="prio">優先度 ${t.priority}</span><span class="mini">${esc(t.effort_text)}</span></div>
<p class="why">機械で埋まらない理由: ${esc(t.why)}</p>
<p class="how">手段: ${esc(t.how)}</p>
${t.hint ? `<div class="hint">${esc(t.hint)}</div>` : ''}
${t.links?.length ? `<div class="links">${t.links.slice(0, 5).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">開く${t.links.length > 1 ? i + 1 : ''}</a>`).join('')}</div>` : ''}
</div>`).join('');
}

function cutTable(r) {
  const used = {};
  for (const s of r.searches) if (s.ok) used[s.cut] = (used[s.cut] ?? 0) + 1;
  const rows = CUTS.map((c) => `<tr><td class="kw">${esc(c.label)}</td><td data-label="方向">${esc(DIRECTION[c.direction])}</td><td class="n" data-label="計画">${c.budget}</td><td class="n" data-label="使った回数">${used[c.id] ?? 0}</td><td data-label="飽和">${r.saturated.includes(c.id) ? '飽和して打ち切り' : '—'}</td></tr>`).join('');
  return `<div class="tbl"><table><thead><tr><th>切り口</th><th>方向</th><th>計画</th><th>使った回数</th><th>飽和</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderDeepReport(r) {
  const d = r.deep;
  const ev = r.evidence;
  const evOk = ev?.ok;
  const qCount = (q) => d.map.rows.filter((x) => x.quadrant === q).length;
  const copyable = d.anglers.filter((a) => a.copyable);
  const niches = d.niches.filter((n) => !n.tiny);
  const killHits = d.kill.filter((k) => k.hit).length;
  const costText = r.cost?.llm?.usd != null ? `$${r.cost.llm.usd.toFixed(3)}（推定）` : '未計測';
  const searchOk = r.searches.filter((s) => s.ok).length;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>調べ切り: ${esc(r.theme)}</title>
<style>${REPORT_CSS}${EXTRA_CSS}</style>
</head>
<body>
<main>
<header>
<div class="brand">shitami ・ 調べ切り</div>
<h1>${esc(r.theme)}</h1>
<div class="meta">対象: ${esc(r.regionLabel)} ／ 取得日: ${esc(r.date)} ／ YouTube 検索 ${searchOk}回・チャンネル ${num(r.counts.channels)}件・動画 ${num(r.counts.videos)}本を測定</div>
</header>

<section class="gist">
<p class="gist-line">魚がいる所を2つの方向から見ました。主検索の${d.map.rows.length}語のうち、真似で入る漁場 ${qCount('copy')}語・すぐ入る ${qCount('go')}語・ニッチの池 ${qCount('niche')}語・避ける ${qCount('avoid')}語・池が小さすぎる ${qCount('tiny')}語です。</p>
<nav class="stats">
<a href="#niche"><b>${niches.length}</b><span>① ニッチの池<br>（小さすぎるものを除く）</span></a>
<a href="#copy"><b>${copyable.length}</b><span>② 真似の手本の候補</span></a>
<a href="#kill"><b>${killHits}/${d.kill.length}</b><span>撤退条件に当たった数</span></a>
</nav>
</section>
<p class="gist-note">判断の材料です。「やる／やらない」は書いていません。置き場所の境目は、このテーマの中の中央値です（ほかのテーマとの比較ではありません）。</p>

<h2>1. 漁場マップ<small>魚（再生）× 釣り人（投稿者）</small></h2>
<p>主検索（関連度順）の各語を、上位50本のうち直近1年の動画の再生合計（魚）と、直近90日に動画を出したチャンネルの数（釣り人）で置きました。魚も釣り人も多いのは、そこで稼げている人がいる証拠で、不合格の印ではありません。</p>
${mapSvg(d.map)}
<details class="more"><summary>語ごとの数字を見る（${d.map.rows.length}語）</summary>${mapTable(d.map, d.triangulation)}
<p class="mini">三角測量: 検索される（検索候補に多く出る）・見られる（魚が多い側）・払われる（説明欄のお金のリンクが1割以上）。3つそろった語だけを「需要あり」としています。コメント（言われる）は今後足します。</p></details>

<h2 id="niche">2. ① ニッチの池<small>釣り人は少ないのに魚が来ているか</small></h2>
<p>新着順の検索で「新しく来た人の動画がどれだけ回っているか」を測り、釣り人の数で割った値の大きい順に並べました。</p>
${niches.length ? `<div class="cards deep-cards">${niches.slice(0, 6).map(nicheCard).join('')}</div>` : NONE}
${d.niches.length > 6 || d.niches.some((n) => n.tiny) ? `<details class="more"><summary>ほかの池（${d.niches.length - Math.min(6, niches.length)}件）</summary><div class="cards deep-cards">${d.niches.filter((n) => !niches.slice(0, 6).includes(n)).map(nicheCard).join('')}</div></details>` : ''}

<h2 id="copy">3. ② 真似できる釣り人<small>新しく入って、当たりが続いている人</small></h2>
<p>開設2年以内のチャンネルを最初の動画まで遡り、チャンネル内の中央値の3倍を超えた動画（当たり）を数えました。緑の枠は「開設2年以内・当たり3本以上・題名にテーマの語を含む動画が1割以上・登録者1,000人以上・大手でない」をすべて満たす手本の候補です。</p>
${d.anglers.length ? `<div class="cards deep-cards">${d.anglers.slice(0, 8).map(anglerCard).join('')}</div>` : NONE}
${d.typeSuccess.length ? `<details class="more"><summary>型の成功率（伸びなかった人も数える）</summary>
<p class="mini">同じ束 × 同じ形式で動画を出しているチャンネルのうち、直近1年に登録者数より多く再生された動画を持つ割合です。伸びた人だけを見ないための目安です。</p>
<div class="tbl"><table><thead><tr><th>束</th><th>形式</th><th>チャンネル</th><th>当たった</th><th>成功率</th></tr></thead><tbody>${d.typeSuccess.map((t) => `<tr><td class="kw">${esc(t.cluster)}</td><td data-label="形式">${esc(FMT[t.fmt] ?? t.fmt)}</td><td class="n" data-label="チャンネル">${t.channels}</td><td class="n" data-label="当たった">${t.won}</td><td class="n" data-label="成功率">${pct(t.rate)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}

<h2>4. 同じ信号を、方向によって逆に読む</h2>
${signalTable(d.signals)}
${d.clones.length ? `<details class="more"><summary>似た名前のチャンネルの群れ</summary><ul class="plain">${d.clones.map((c) => `<li>${c.count}チャンネル: ${esc(c.examples.join('、'))}</li>`).join('')}</ul></details>` : ''}

<h2>5. チャンネル内の外れ値<small>普段の3倍以上回った動画</small></h2>
<p>同じチャンネル・同じ形式の中央値と比べた倍率です。登録者1,000人未満のチャンネルは分母が小さく倍率が膨らむので外しています（${num(d.outliers.small)}本）。20倍超は外部要因が多く、再現しにくい印を付けました。</p>
<p class="mini">外れ値 ${num(d.outliers.counted)}本・${num(d.outliers.channels)}チャンネル ／ 上位3チャンネルへの集中 ${pct(d.outliers.concentration)}</p>
${outlierTiles(d.outliers)}

<h2 id="money">6. お金が動いているか</h2>
<p>外れ値の説明欄にあるリンクを種類ごとに数えました（説明欄の本文は保存していません）。</p>
<div class="tbl"><table><thead><tr><th>種類</th><th>外れ値のうち</th><th>測った動画全体のうち</th></tr></thead><tbody>${d.money.kinds.map((k) => `<tr><td class="kw">${esc(k.label)}${k.money ? '' : ' <small>（作り手が払う側）</small>'}</td><td class="n" data-label="外れ値">${pct(k.outliers)}</td><td class="n" data-label="全体">${pct(k.all)}</td></tr>`).join('')}</tbody></table></div>
<h3>Web で見つかった根拠</h3>
${evOk ? evidenceList(ev.payments) : `<p class="none">${esc(ev?.reason ?? '調べていません')}</p>`}
<h3 id="counter">反証（成り立たない・難しい根拠）</h3>
${evOk ? evidenceList(ev.counters) : NONE}
${evOk && ev.unknowns?.length ? `<h3>まだ分からないこと</h3><ul class="plain">${ev.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}

<h2 id="kill">7. 撤退条件<small>調べる前に決めたもの</small></h2>
<ul class="kill plain">${d.kill.map((k) => `<li><span class="${k.hit ? 'hit' : 'miss'}">${k.hit ? '当たった' : '当たらない'}</span>（${esc(k.value)}）: ${esc(k.text)}</li>`).join('')}</ul>

<h2 id="next">8. 人が確かめること<small>優先度 = 判断を変えうるか × 確信がないか ÷ 手間</small></h2>
${taskList(r.handoff.human)}
<h3>機械に回す続き</h3>
<ul class="plain">${r.handoff.machine.map((m) => `<li>${esc(m.task)}: ${esc(m.how)}${m.channels?.length ? `（${m.channels.length}チャンネル）` : ''}</li>`).join('')}</ul>

<h2>9. 調べ方の記録</h2>
<p>search 枠は発見だけに使い、切り口ごとに新しいチャンネルが出なくなったら打ち切って、残りを別の切り口へ回しました${r.searchStop ? `（${r.searchStop === 'quota-exceeded' ? '1日の枠を使い切って止まりました' : '上限に達して止まりました'}）` : ''}。</p>
${cutTable(r)}
<details class="more"><summary>検索の一覧（${r.searches.length}回）</summary><div class="tbl"><table><thead><tr><th>切り口</th><th>検索語</th><th>条件</th><th>新しいチャンネル</th></tr></thead><tbody>${r.searches.map((s) => `<tr><td>${esc(CUTS.find((c) => c.id === s.cut)?.label ?? s.cut)}</td><td class="kw">${esc(s.q)}</td><td data-label="条件">${esc([s.order, s.region !== r.region ? s.region : null, s.publishedAfter ? `${s.publishedAfter}以降` : null, s.videoDuration].filter(Boolean).join('・'))}${s.ok ? '' : `（失敗: ${esc(s.error)}）`}</td><td class="n" data-label="新しいチャンネル">${num(s.newChannels)}</td></tr>`).join('')}</tbody></table></div></details>
<details class="more"><summary>検索候補の束（${r.expand.clusters.length}件）</summary><div class="chips">${r.expand.clusters.map((c) => `<span class="chip i-${c.intents[0] ?? 'other'}">${esc(c.key)}<small>${c.hits}</small></span>`).join('')}</div></details>

<footer>
<div>データの出どころと注意</div>
<ul>
<li>検索候補: YouTube の検索候補（${esc(r.regionLabel)}向け、${num(r.expand.requests)}回問い合わせ）。公式の API ではないため、件数は目安です</li>
<li>漁場・外れ値・釣り人: YouTube Data API（${esc(r.date)} 時点）。search ${num(r.quota.searchCalls)}回・合算枠 ${num(r.quota.units)} units（うち ${num(r.quota.failed)}回は、その種類の動画が無いチャンネルの再生リストを問い合わせて空振りしたものなど）</li>
<li>サムネ: YouTube の画像を直接表示しています（保存していません）。権利は各動画の作者にあります</li>
<li>お金の根拠・反証: Web 検索（${esc(ev?.model ?? '—')}）。調査で実際に参照した URL が付いている項目だけを載せています</li>
<li>このページの調査費用: ${esc(costText)}</li>
<li>このページは YouTube API の利用規約に合わせ、公開から30日で消えます</li>
</ul>
</footer>
</main>
</body>
</html>`;
}
