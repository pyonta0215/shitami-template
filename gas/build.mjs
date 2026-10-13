// Apps Script に貼る形（gas/dist/）を作る。
//   Code.js       … 計算と本体を1つにまとめたもの。メニューやトリガーから呼ぶ関数を上に出す
//   Sidebar.html  … サイドバー
//   appsscript.json … 権限と YouTube 拡張サービスの設定
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const ENTRY_FUNCTIONS = ['onOpen', 'showSidebar', 'showResults', 'openResult', 'setOpenAiKey', 'getStatus', 'startRun', 'resumeRun', 'continueRun', 'cleanup'];

mkdirSync('gas/dist', { recursive: true });
const out = await build({
  entryPoints: ['gas/main.js'],
  bundle: true,
  format: 'iife',
  globalName: 'Shitami',
  platform: 'neutral',
  target: 'es2019',
  write: false,
  legalComments: 'inline',
});
const stubs = ENTRY_FUNCTIONS.map((f) => `function ${f}(a, b) { return Shitami.${f}(a, b); }`).join('\n');
const header = `// shitami ・ 調べ切り（スプレッドシート版）\n// このファイルは gas/build.mjs が作ったものです。直すときは gas/main.js と src/ を直して作り直してください。\n// https://github.com/pyonta0215/shitami-template\n\n`;
writeFileSync('gas/dist/Code.js', `${header}${stubs}\n\n${out.outputFiles[0].text}`);
copyFileSync('gas/Sidebar.html', 'gas/dist/Sidebar.html');
copyFileSync('gas/appsscript.json', 'gas/dist/appsscript.json');
console.log(`gas/dist/Code.js ${(readFileSync('gas/dist/Code.js').length / 1024).toFixed(0)}KB`);
