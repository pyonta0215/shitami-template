// 段6「渡す」: 機械で埋まらないものを、問い・理由・手段・目安時間つきで人のリストにする。
// 並び順は「判断を変えうるか × いま確信がないか ÷ 手間」（それぞれ1〜3）。
// 白紙で渡さず、機械が立てた仮の答えを添える。

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const n = (x) => (x == null ? '—' : Number(x).toLocaleString('ja-JP'));

export function handoff(deep, { theme }) {
  const tasks = [];
  const add = (t) => tasks.push({ ...t, priority: Number(((t.impact * t.uncertainty) / t.effort).toFixed(2)) });

  const top = deep.outliers.list.filter((o) => !o.small && !o.extreme).slice(0, 5);
  add({
    who: 'human', direction: 'common',
    task: '伸びている動画を5本見て、なぜ見られたかを言葉にする',
    why: '数字は「どれが」までで、「なぜ」は見ないと分からない',
    how: '視聴し、企画・冒頭30秒・サムネと題名の約束を1行ずつ書き留める',
    effort_text: '1時間', impact: 3, uncertainty: 3, effort: 2,
    hint: top.length ? `候補: ${top.map((o) => `「${o.title}」（${o.multiplier}倍）`).join('、')}` : '伸びている動画が見つからなかったので、検索の上位を見る',
    links: top.map((o) => watchUrl(o.video_id)),
  });

  const copyable = deep.anglers.filter((a) => a.copyable).slice(0, 3);
  if (copyable.length) {
    add({
      who: 'human', direction: 'copy',
      task: '② 真似先の、最初の10本と最新10本を見比べる',
      why: '「最初は何をしていて、何を変えたら当たったか」は数字に出ない',
      how: '見比べて、変えた点（企画・尺・題名の型・頻度）を書き留める',
      effort_text: '1時間', impact: 3, uncertainty: 3, effort: 2,
      hint: copyable.map((a) => `${a.title}: 最初の10本の中央値 ${n(a.first10.median_views)}回 → 最新10本 ${n(a.last10.median_views)}回${a.first_hit ? `、最初の当たりは${a.first_hit.nth}本目（開設${a.first_hit.days_from_start ?? '—'}日目）` : ''}`).join(' ／ '),
      links: copyable.map((a) => `https://www.youtube.com/channel/${a.channel_id}`),
    });
    add({
      who: 'human', direction: 'copy',
      task: '② 制作の重さ（道具・外注・顔出し・1本にかかる時間）を推定する',
      why: '説明欄から一部は推せるが確定しない',
      how: '視聴して推定する。分からなければ作り手に聞く',
      effort_text: '30分', impact: 2, uncertainty: 3, effort: 1,
      hint: copyable.map((a) => `${a.title}: 週${a.per_week}本・通常動画の尺 ${a.long_minutes ?? '—'}分`).join(' ／ '),
      links: [],
    });
    add({
      who: 'human', direction: 'copy',
      task: '② 真似で終わらせない差分を1つ決める',
      why: 'テンプレートどおりの量産は収益化の対象外になりうる（YouTube の inauthentic content）。何を足すかは自分の強みで決まる',
      how: '手本の題名の型は借り、中身（素材・解説・編集）で足すものを1つ決める',
      effort_text: '30分', impact: 3, uncertainty: 2, effort: 1,
      hint: copyable[0].pattern.length ? `手本の題名の型: ${copyable[0].pattern.map((p) => p.token).join('・')}` : '',
      links: [],
    });
  } else {
    add({
      who: 'human', direction: 'copy',
      task: '② 真似先が見つからなかった理由を確かめる',
      why: '開設2年以内で当たりが続いているチャンネルが無かった。新規参入が難しいのか、測り方の外にいるのかは見ないと分からない',
      how: '主検索の上位を見て、新しいチャンネルがいない理由（大手の独占・規約・流行の終わり）を探す',
      effort_text: '30分', impact: 3, uncertainty: 3, effort: 1,
      hint: '', links: [],
    });
  }

  const niches = deep.niches.filter((x) => !x.tiny).slice(0, 3);
  if (niches.length) {
    add({
      who: 'human', direction: 'niche',
      task: '① 穴場の上位の動画を見て、視聴者として物足りない点を探す',
      why: '投稿者が少ない理由が「見る人が少ないから」か「誰も気づいていないから」かは、見ないと分からない',
      how: '上位10本を見て、足りないもの（新しさ・尺・言語・切り口）を1行で書く',
      effort_text: '30分', impact: 3, uncertainty: 3, effort: 1,
      hint: niches.map((x) => `「${x.term}」: 投稿者${x.anglers90}人・新しく来た人の再生中央値 ${n(x.catchMedian)}回`).join(' ／ '),
      links: niches.map((x) => `https://www.youtube.com/results?search_query=${encodeURIComponent(x.term)}`),
    });
    add({
      who: 'human', direction: 'niche',
      task: '① 自分がその穴場の動画を作れるか確かめる',
      why: '素材・知識・機材は本人にしか分からない',
      how: '作れないなら、近い語の穴場を見る',
      effort_text: '15分', impact: 3, uncertainty: 2, effort: 1,
      hint: '', links: [],
    });
  }

  add({
    who: 'human', direction: 'common',
    task: 'クリック率・視聴維持率・流入元を確かめる',
    why: '作者の YouTube Studio にしかない',
    how: '作り手に聞く／自分で1本出して見る',
    effort_text: '数日', impact: 2, uncertainty: 3, effort: 3,
    hint: '', links: [],
  });
  add({
    who: 'human', direction: 'common',
    task: '視聴者が検索している語と、似た視聴者が見ている動画を見る',
    why: 'Studio の Research タブと「視聴者の検索」は自分のチャンネルでしか見えない（Research タブは試験提供中）',
    how: '自分の YouTube Studio で確かめる',
    effort_text: '15分', impact: 2, uncertainty: 2, effort: 1,
    hint: '', links: [],
  });
  if ((deep.money.outliersWithMoney ?? 0) > 0) {
    const sales = deep.money.kinds.find((k) => k.kind === 'sales');
    add({
      who: 'human', direction: 'common',
      task: '販売されている商品を1つ買って、中身と値付けを確かめる',
      why: '買わないと中身は分からない',
      how: '伸びている動画の説明欄で一番多い販売先から1つ選ぶ',
      effort_text: '数百〜数千円', impact: 2, uncertainty: 2, effort: 2,
      hint: sales?.outliers != null ? `伸びている動画のうち販売リンクがあるのは ${Math.round(sales.outliers * 100)}%` : '',
      links: [],
    });
  }
  add({
    who: 'human', direction: 'common',
    task: '作り手の実感（作業量・収益・やめた理由）を聞く',
    why: '公開情報に出ない',
    how: 'DM・オフ会・カジュアル面談',
    effort_text: '1件30分', impact: 3, uncertainty: 3, effort: 2,
    hint: '', links: [],
  });
  add({
    who: 'human', direction: 'common',
    task: '季節性と長期の伸びを見る',
    why: 'Google Trends の API はアルファ版で申請制',
    how: 'ブラウザで Trends を開き、5年の推移を見る',
    effort_text: '10分', impact: 2, uncertainty: 2, effort: 1,
    hint: '', links: [`https://trends.google.com/trends/explore?date=today%205-y&gprop=youtube&q=${encodeURIComponent(theme)}`],
  });

  // 日をおいて、もう一度調べると分かること
  const watch = deep.anglers.filter((a) => a.copyable).slice(0, 10).map((a) => a.channel_id);
  const machine = [
    { who: 'machine', task: '伸び方の推移を見る', how: '数週間おいて同じテーマをもう一度調べ切り、真似先の再生数と投稿の続き方を比べる', channels: watch },
  ];

  return { human: tasks.sort((a, b) => b.priority - a.priority), machine };
}
