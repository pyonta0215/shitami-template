// テスト用の偽の YouTube。同じ問い合わせには必ず同じ答えを返す（API の枠を使わずに全段を通すため）。

const NOW = Date.parse('2026-10-10T00:00:00Z');
const DAY = 86400000;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0;
  return h;
}

const CHANNELS = 300;
const PER_CHANNEL = 60;
const chId = (n) => `UC${String(n).padStart(22, '0')}`;
const vidId = (c, i) => `v${String(c).padStart(4, '0')}_${String(i).padStart(3, '0')}`;
const chNo = (id) => Number(id.slice(2));

function video(c, i) {
  const h = hash(`${c}:${i}`);
  const ageDays = 5 + ((c * 7 + i * 11) % 700);
  const base = 200 + (hash(c) % 20000);
  const views = Math.round(base * (h % 97 === 0 ? 40 : h % 13 === 0 ? 6 : 0.3 + (h % 100) / 60));
  return {
    id: vidId(c, i),
    snippet: { channelId: chId(c), channelTitle: `ch${c}`, title: `theme video ${c}-${i}`, description: h % 5 === 0 ? 'https://www.amazon.co.jp/dp/x' : '', publishedAt: new Date(NOW - ageDays * DAY).toISOString() },
    contentDetails: { duration: h % 3 === 0 ? 'PT45S' : `PT${3 + (h % 50)}M` },
    statistics: { viewCount: String(views), likeCount: '1', commentCount: '0' },
  };
}

const json = (body, status = 200) => ({ status, text: JSON.stringify(body) });

/** 同期で答える（Apps Script の偽物から使う）。{ status, text } */
export function respond(raw) {
  {
    const u = new URL(raw);
    if (u.host === 'suggestqueries.google.com') {
      const q = u.searchParams.get('q');
      const words = ['作業用', '睡眠', 'ゲーム', '作り方', 'stream', 'lofi', 'ピアノ', 'カフェ', '勉強', '雨'];
      return json([q, words.map((w, i) => `${q.trim()} ${w}${hash(q) % (i + 2) === 0 ? ' 1時間' : ''}`)]);
    }
    const method = u.pathname.split('/').pop();
    const p = u.searchParams;
    if (method === 'search') {
      const h = hash(`${p.get('q')}|${p.get('order')}|${p.get('regionCode')}|${p.get('videoDuration')}`);
      const items = Array.from({ length: 50 }, (_, k) => {
        const c = (h + k * 37) % CHANNELS;
        const i = (h >> 3) % PER_CHANNEL;
        return { id: { videoId: vidId(c, (i + k) % PER_CHANNEL) }, snippet: { channelId: chId(c), title: 't', channelTitle: `ch${c}`, publishedAt: '' } };
      });
      return json({ items, pageInfo: { totalResults: 1000 } });
    }
    if (method === 'videos') {
      return json({ items: p.get('id').split(',').filter((id) => /^v\d{4}_\d{3}$/.test(id)).map((id) => video(Number(id.slice(1, 5)), Number(id.slice(6)))) });
    }
    if (method === 'channels') {
      return json({ items: p.get('id').split(',').map((id) => {
        const c = chNo(id);
        return { id, snippet: { title: `ch${c}`, publishedAt: new Date(NOW - (100 + (c * 13) % 2000) * DAY).toISOString() }, statistics: { subscriberCount: String(500 + (hash(c) % 300000)), viewCount: '1', videoCount: String(PER_CHANNEL) }, contentDetails: {} };
      }) });
    }
    if (method === 'playlistItems') {
      const pl = p.get('playlistId');
      const c = Number(pl.replace(/^UU(LF|SH)?/, ''));
      const all = Array.from({ length: PER_CHANNEL }, (_, i) => vidId(c, i));
      const start = Number(p.get('pageToken') ?? 0);
      const size = Number(p.get('maxResults') ?? 50);
      const page = all.slice(start, start + size);
      return json({ items: page.map((id) => ({ contentDetails: { videoId: id } })), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
    }
    return json({ error: { errors: [{ reason: 'notFound' }] } }, 404);
  }
}

export function createFakeFetch({ counter = { calls: 0 } } = {}) {
  return async function fakeFetch(raw) {
    counter.calls += 1;
    const { status, text } = respond(raw);
    return { ok: status < 400, status, headers: { get: () => 'application/json' }, text: async () => text, json: async () => JSON.parse(text) };
  };
}

export const FAKE_NOW = NOW;
