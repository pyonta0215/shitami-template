// 説明欄から「お金の流れ」を拾う。ドメインと決まった言い回しの辞書で分け、LLM は使わない。
// 説明欄の本文は保存しない（ここで分類したら捨てる）。

export const LINK_KINDS = {
  sales: { label: '販売', domains: ['booth.pm', 'gumroad.com', 'note.com', 'base.shop', 'thebase.in', 'stores.jp', 'coconala.com', 'udemy.com', 'patreon.com', 'fanbox.cc', 'ko-fi.com', 'buymeacoffee.com', 'skeb.jp', 'dlsite.com', 'bandcamp.com', 'etsy.com', 'teachable.com', 'kajabi.com', 'shopify.com', 'myshopify.com', 'lemonsqueezy.com', 'payhip.com', 'audiostock.jp', 'pixiv.net'] },
  affiliate: { label: 'アフィリエイト', domains: ['amzn.to', 'amzn.asia', 'amazon.co.jp', 'amazon.com', 'a.r10.to', 'hb.afl.rakuten.co.jp', 'af.moshimo.com', 'px.a8.net', 'ck.jp.ap.valuecommerce.com', 'click.linksynergy.com', 'geni.us', 'shareasale.com', 'impact.com', 'partner.'] },
  membership: { label: 'メンバーシップ', patterns: [/youtube\.com\/(channel\/[\w-]+|@[\w.-]+)\/join/i, /メンバーシップ/, /\bjoin (my|the) membership\b/i] },
  sponsor: { label: '提供・PR', patterns: [/#PR\b/, /【PR】/, /提供[:：]/, /プロモーションを含みます/, /\bsponsored by\b/i, /\bpaid promotion\b/i] },
  license: { label: '素材・ライセンス', domains: ['epidemicsound.com', 'artlist.io', 'audiojungle.net', 'envato.com', 'dova-s.jp', 'amachamusic.chagasi.com', 'pond5.com', 'soundstripe.com'] },
};

const URL_RE = /https?:\/\/[^\s)」』>]+/g;

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** 説明欄の本文から、当てはまる種類の配列を返す（重複なし） */
export function classifyLinks(description) {
  const text = String(description ?? '');
  if (!text) return [];
  const hosts = (text.match(URL_RE) ?? []).map(hostOf).filter(Boolean);
  const out = [];
  for (const [kind, def] of Object.entries(LINK_KINDS)) {
    const byDomain = def.domains?.some((d) => hosts.some((h) => (d.endsWith('.') ? h.startsWith(d) : h === d || h.endsWith(`.${d}`))));
    const byPattern = def.patterns?.some((re) => re.test(text));
    if (byDomain || byPattern) out.push(kind);
  }
  return out;
}

/** お金につながる種類（素材・ライセンスは作り手が払う側なので数えない） */
export const MONEY_KINDS = ['sales', 'affiliate', 'membership', 'sponsor'];
export const hasMoney = (links) => (links ?? []).some((k) => MONEY_KINDS.includes(k));
