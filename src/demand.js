// 需要の側：YouTube の検索候補（サジェスト）から「実際に検索されている語」を集める。
//
// 手法と接頭辞の一覧は yt-research-radar の src/demand.js から持ってきた。違いは2つ:
//   - 言語と地域を切り替えられる（Radar は日本語・日本に固定）
//   - 種はテーマ1語だけ。Radar のように手書きのキーワード表を持たない
//
// サジェストは公式ドキュメントに無いエンドポイント。呼べなくても全体は止めず、
// 集まった語が少ないことをそのまま結果に残す。

const SUGGEST = 'https://suggestqueries.google.com/complete/search';

export const REGIONS = {
  jp: { hl: 'ja', gl: 'JP', label: '日本', relevanceLanguage: 'ja', regionCode: 'JP' },
  en: { hl: 'en', gl: 'US', label: '英語圏（米国）', relevanceLanguage: 'en', regionCode: 'US' },
};

const KANA = ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'こ', 'し', 'せ', 'た', 'ち', 'つ', 'て', 'と', 'な', 'に', 'ね', 'の', 'は', 'ひ', 'ふ', 'ほ', 'ま', 'み', 'む', 'も', 'や', 'ゆ', 'よ', 'ら', 'り', 'わ', 'を', 'ん'];
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');

export function suffixesFor(region) {
  return ['', ...(region === 'en' ? ALPHA : KANA)];
}

export async function suggest(query, region, { fetchImpl = fetch } = {}) {
  const r = REGIONS[region];
  const url = `${SUGGEST}?client=firefox&ds=yt&hl=${r.hl}&gl=${r.gl.toLowerCase()}&ie=utf-8&oe=utf-8&q=${encodeURIComponent(query)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`suggest ${res.status}`);
  const json = JSON.parse(await res.text());
  return (json[1] ?? []).filter((s) => typeof s === 'string');
}


const squash = (x) => x.toLowerCase().replace(/[\s\u3000]+/g, '');
const spaced = (x) => x.toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
const ASCII_WORD = /[a-z0-9]/;

/**
 * 語がテーマを含むか。空白をそろえた形と、空白を詰めた形（「aibgm」）の両方で探し、
 * 前後が英数字なら別の単語とみなす（「bgm」で「bgmi」を拾わない。「作業用bgm」「ai bgm maker」は拾う）
 */
export function containsTheme(term, theme) {
  const t = spaced(term);
  const variants = [...new Set([spaced(theme), squash(theme)])].filter(Boolean);
  for (const b of variants) {
    for (let i = t.indexOf(b); i >= 0; i = t.indexOf(b, i + 1)) {
      const edgeOk = (c, inner) => c === undefined || !(ASCII_WORD.test(c) && ASCII_WORD.test(inner));
      if (edgeOk(t[i - 1], b[0]) && edgeOk(t[i + b.length], b[b.length - 1])) return true;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * テーマ1語を接頭辞で展開する。返り値は 語 → 出現回数。
 * 出現回数が多い＝入力の途中どこからでも候補に出る＝それだけ検索されている、の代理指標。
 * 検索回数そのものではないので、画面では「出現回数」とだけ書く。
 */
export async function expandTheme(theme, region, { fetchImpl = fetch, delayMs = 120, depth2 = 10, onError } = {}) {
  const counts = new Map();
  let requests = 0;
  let failures = 0;
  for (const sfx of suffixesFor(region)) {
    requests += 1;
    try {
      for (const s of await suggest(sfx ? `${theme} ${sfx}` : theme, region, { fetchImpl })) {
        const k = s.trim().toLowerCase();
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    } catch (e) {
      failures += 1;
      onError?.(sfx, e);
    }
    if (delayMs) await sleep(delayMs);
  }

  // 2段目：1段目で多く出た語を、そのまま（接頭辞なしで）もう一度問い合わせる。
  // 日本語は接頭辞の多くがテーマから外れた候補を返すので、1段目だけだと語が薄くなる
  const second = [...counts.entries()]
    .filter(([k]) => squash(k) !== squash(theme) && containsTheme(k, theme))
    .sort((a, b) => b[1] - a[1])
    .slice(0, depth2)
    .map(([k]) => k);
  for (const q of second) {
    requests += 1;
    try {
      for (const s of await suggest(q, region, { fetchImpl })) {
        const k = s.trim().toLowerCase();
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    } catch (e) {
      failures += 1;
      onError?.(q, e);
    }
    if (delayMs) await sleep(delayMs);
  }
  return { counts, requests, failures };
}

// ---- 検索意図の仕分け ----
//
// LLM を使わず辞書で分ける。日次で回すものではないが、同じ語が毎回同じ箱に入ること
// （再現性）のほうを優先した。辞書から漏れた語は「その他」に落ちるだけで、
// 間違った箱には入らない。

export const INTENTS = [
  { id: 'maker', label: '作る側（作り方・収益化）', words: ['作り方', '作成', '自動生成', '生成', '収益化', '収益', '稼ぐ', '稼げる', '副業', 'やり方', '方法', '始め方', '編集', 'how to', 'make', 'create', 'generator', 'generate', 'monetiz', 'earn', 'money', 'tutorial', 'income', 'side hustle', 'beginner'] },
  { id: 'viewer', label: '聴く・使う側（用途・雰囲気）', words: ['作業用', '勉強', '睡眠', '寝る', '眠れる', 'カフェ', 'ドライブ', '集中', 'リラックス', '癒し', '朝', '夜', '雨', 'ゲーム', '戦闘', '配信', 'study', 'sleep', 'relax', 'focus', 'work', 'chill', 'cafe', 'lofi', 'lo-fi', 'stream', '24/7', 'playlist', 'ambient', 'meditation', 'gaming', 'background', 'asmr', 'jazz', 'piano', 'beats', 'rain', 'autumn', 'winter', 'summer', 'christmas', 'night', 'morning', 'coffee', 'anime', 'ジャズ', 'ピアノ', '秋', '冬', '夏', 'クリスマス'] },
  { id: 'compare', label: '比較・おすすめ', words: ['おすすめ', 'オススメ', '比較', 'ランキング', '人気', '最強', '違い', 'vs', 'best', 'top', 'review', 'compare', 'alternative'] },
  { id: 'price', label: '無料・料金・権利', words: ['無料', '料金', '値段', '有料', '著作権', 'フリー', '商用', 'free', 'price', 'cost', 'copyright', 'royalty', 'license', 'no copyright'] },
];

/** テーマ自体の語は判定に使わない（「lofi」がテーマなら、全語が「聴く側」になってしまう） */
export function classifyIntent(term, theme = '') {
  let t = spaced(term);
  for (const b of [spaced(theme), squash(theme)].filter(Boolean)) t = t.split(b).join(' ');
  return INTENTS.filter((i) => i.words.some((w) => t.includes(w.toLowerCase()))).map((i) => i.id);
}

/**
 * 展開結果を、出現回数の多い順に並べ、意図の内訳を付けて返す。
 * テーマそのもの（完全一致）は需要語から外す。測るのは「テーマ＋何か」の方。
 */
export function summarizeDemand(theme, counts, { limit = 40 } = {}) {
  const base = theme.trim().toLowerCase();
  // 接頭辞を足した問い合わせには、テーマから外れた候補も返ってくる（「ai bgm ふ」→「aiフトゥーbgm」など）。
  // テーマの語が連続して含まれる語だけを残す
  const onTheme = (k) => containsTheme(k, base);
  const terms = [...counts.entries()]
    .filter(([k]) => k !== base && onTheme(k))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, hits]) => ({ term, hits, intents: classifyIntent(term, theme) }));

  const intentTotals = Object.fromEntries([...INTENTS.map((i) => [i.id, 0]), ['other', 0]]);
  for (const t of terms) {
    if (!t.intents.length) intentTotals.other += 1;
    for (const id of t.intents) intentTotals[id] += 1;
  }
  return { terms, intentTotals, uniqueTerms: counts.size, onThemeTerms: [...counts.keys()].filter((k) => k !== base && onTheme(k)).length };
}

/**
 * 供給を測る語を選ぶ。出現回数の上位から、意図が偏らないように取る。
 * search.list は1日100回の別枠なので、ここで数を絞るのが費用の要。
 */
export function pickForSupply(terms, n) {
  const picked = [];
  const seen = new Set();
  // まず各意図の最上位を1つずつ、次に残りを出現回数順で埋める
  for (const intent of [...INTENTS.map((i) => i.id), 'other']) {
    const hit = terms.find((t) => (intent === 'other' ? !t.intents.length : t.intents.includes(intent)) && !seen.has(t.term));
    if (hit && picked.length < n) { picked.push(hit); seen.add(hit.term); }
  }
  for (const t of terms) {
    if (picked.length >= n) break;
    if (!seen.has(t.term)) { picked.push(t); seen.add(t.term); }
  }
  return picked.sort((a, b) => b.hits - a.hits);
}
