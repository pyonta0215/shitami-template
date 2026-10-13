# セットアップの案内役としての約束

このファイルは、このリポジトリで作業する AI エージェント（Claude Code、Codex、Cursor など）向けの指示です。

このリポジトリには、同じ計算を動かす2つの形があります。

- スプレッドシート版（`gas/`）：配布のシートをコピーして使う。セットアップの手伝いは要らないことが多い
- Cloudflare 版（`worker/`・`web/`・`public/`）：このファイルの「進め方」で立てる

このリポジトリを開いた人は、多くがエンジニアではありません。「AGENTS.md に沿ってセットアップして」と頼まれたら、まずスプレッドシート版で足りないかを聞き、Cloudflare 版を選んだら README の「Cloudflare 版」の手順1〜5を、1つずつ確認しながら進めてください。

## 進め方

1. `node -v` で Node.js 22 以上があるか確かめる。無ければ入れ方を案内する
2. `npm install` と `npm test` を実行する（テストが落ちたら先に進まない）
3. `npx wrangler whoami` でログイン状態を見る。未ログインなら `npx wrangler login` を実行し、ブラウザで「Allow」を押すよう伝える
4. YouTube の APIキーは**本人が**作る。README の手順3を画面の言葉どおりに案内する。この道具専用の新しい Google Cloud プロジェクトにすること、API の制限で YouTube Data API v3 だけを選ぶことを必ず伝える
5. キーは本人に `npx wrangler secret put YOUTUBE_API_KEY` で貼ってもらう
6. `npx wrangler deploy` を実行し、出た URL を伝える
7. README の手順5（Access）を案内する。設定後に URL を開き、「鍵がかかっていません」の表示が消えたかを本人に確かめてもらう
8. 最初の動作確認は1テーマだけ。終わったら「結果を開く」でページが出るかを確かめる

## してはいけないこと

- APIキーやトークンを、チャット・ファイル・コマンドの引数・ログに書かない。読み取ることも求めない。`wrangler secret put` の入力は本人に任せる
- `.dev.vars` を git に入れない（`.gitignore` 済み）
- 本人の許可なく `wrangler delete`・KV の削除・キーの削除をしない
- 1日の検索の上限（`SEARCH_DAILY_CAP`）を、無料枠の100回を超える値にしない

## 中身を変えるとき

- 計算は `src/deep/`、中継は `worker/index.js`、画面は `public/index.html` と `web/app.js`、スプレッドシート版は `gas/`
- 変えたら `npm test` を通す。Cloudflare 版は `npx wrangler deploy`、スプレッドシート版は `npm run build:gas` で `gas/dist/` を作り直してコミットする
- スプレッドシート版には fetch・URL・setTimeout が無い。`gas/shim.js` で補っているので、`src/` で新しい Web の機能を使うときは、そこで足りるか確かめる
- `src/deep/` の段は、`shouldStop()` が true を返したら区切りよく止まり、次回そこから続けられるようにしておく（Apps Script は1回6分まで）
- 外への呼び出しを足すときは、`web/app.js` の `toProxyUrl` と `worker/index.js` の両方に中継を足す。APIキーはブラウザに出さない
