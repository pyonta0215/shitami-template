// 単価は llm-kit の目録から引く。目録は公式の料金ページから転記した正本で、各行に確かめた日と出典を持つ。
// 表示するときは「推定」と書く（API が返した使用量 × この単価で、請求額ではない）。
// キャッシュ書き込みの単価がある行は、使用量に書き込み数が返らないので、キャッシュされなかった入力を
// すべて書き込みとして数える（多めの上限値）。272K 超の割増も目録が持つ。
import { MODEL_CATALOG, WEB_SEARCH_PER_CALL } from '@pyonta0215/llm-kit/catalog';

export const MODEL_PRICES = MODEL_CATALOG;
// Web 検索はページを開く操作も数える多めの見積もりにする。
export const WEB_SEARCH_PRICING = { perCallUsd: WEB_SEARCH_PER_CALL.openai.perCallUsd, count: 'all-calls' };
