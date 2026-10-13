// 単価表。research-kit は単価を持たない方針なので、利用側で転記日と出典を管理する。
// 転記元: gpt-6-* は OpenAI 公式のモデル別ページ（2026-09-29 確認。書き込み単価と 272K 超の倍率も同ページ）、gpt-5.6-* は mekiki packages/domain/src/cost.ts（2026-08-27 実測時に使用した値）。
// gpt-5.6-* は過去の実行記録の費用を読むために残している。
// 表示するときは「推定」と書く（API が返した使用量 × この単価で、請求額ではない）。

// GPT-6 はキャッシュ書き込みが入力の 1.25 倍。使用量に書き込み数が返らないので、キャッシュされなかった入力は
// すべて書き込みとして数える（多めの上限値）。入力が 272K トークンを超えるリクエストは全体が入力・キャッシュ 2 倍、出力 1.5 倍。
const GPT_6_LONG_CONTEXT = { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 };

export const MODEL_PRICES = {
  'gpt-6-luna': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.5, cachedInputPerMillionUsd: 0.01, cacheWritePerMillionUsd: 0.125, longContext: GPT_6_LONG_CONTEXT },
  'gpt-6-sol': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0, cachedInputPerMillionUsd: 0.2, cacheWritePerMillionUsd: 2.5, longContext: GPT_6_LONG_CONTEXT },
  'gpt-5.6-luna': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2, cachedInputPerMillionUsd: 0.02 },
  'gpt-5.6-terra': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 12.0, cachedInputPerMillionUsd: 0.2 },
};

// OpenAI 公式 web_search（reasoning model 向け）$10.00 / 1,000 calls。
// ページを開く操作も数える多めの見積もりにする。
export const WEB_SEARCH_PRICING = { perCallUsd: 0.01, count: 'all-calls' };
