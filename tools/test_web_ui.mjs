// tools/test_web_ui.mjs
// ---------------------------------------------------------------------------
// docs/index.html + app.js を jsdom 上で実際に動かし、画面操作の一通り
//   単語入力 → AI生成 → ストック表示 → プレビュー → .apkg 出力
// が動くことを確認する。
//
// 【Gemini API は呼ばない】
// fetch をモックして固定の応答を返すため、APIキーも割り当ても消費しない。
// 逆に言うと「実際のGeminiが期待どおりのJSONを返すか」はこのテストの対象外で、
// そこは実機での確認が必要。
//
// 【使い方】
//   cd tools && npm install && node test_web_ui.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(dirname(HERE), 'docs');

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AI が返す想定の応答(実際の Gemini の出力形式に合わせている)
const FAKE_CARD = {
  reading: '/<b>ˈsleɪ</b>tɪd/',
  pos: 'adj. (Past Participle)',
  meaning: '予定されている',
  example: 'The update is <b>slated</b> for release.<br>Ex1. It is <b>slated</b>.',
  example_ja: 'その更新は公開が予定されている。<br>予定されている。',
  example_blank: 'The update is ------- for release.',
  note: '【語源】slate に由来する。',
};

console.log('Web版UIの通し動作テスト(jsdom / Gemini APIはモック)\n');

// --- ページを読み込む ---
const html = readFileSync(join(DOCS, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:8000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// ブラウザ相当のグローバルを用意する(app.js は module として自前で読み込む)
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.confirm = () => true;
globalThis.alert = () => {};
window.confirm = globalThis.confirm;
window.alert = globalThis.alert;
// jsdom の window.crypto は getter のみで代入できないため、
// guid.js が使う crypto.subtle を Node のものに差し替える
Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true });

// index.html が CDN から読む sql.js / JSZip は Node 側の実体を割り当てる。
// apkg.js は locateFile に CDN の URL を渡すが、Node ではそれをローカルパスと
// して開こうとして失敗するため、テスト時は locateFile を無視して
// node_modules 同梱の wasm を使わせる(ブラウザ実行時はCDNで正しく動く)。
const realInitSqlJs = require('sql.js');
window.initSqlJs = () => realInitSqlJs();
window.JSZip = require('jszip');
globalThis.initSqlJs = window.initSqlJs;
globalThis.JSZip = window.JSZip;

// <dialog> は jsdom が未実装なので最小限の代替を入れる
window.HTMLDialogElement = window.HTMLElement;
const dlg = window.document.getElementById('preview-dialog');
let dialogOpened = false;
dlg.showModal = () => { dialogOpened = true; };
dlg.close = () => { dialogOpened = false; };

// --- fetch のモック(共有アセットはローカルから、Gemini は固定応答) ---
let geminiCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('./') || u.startsWith('http://localhost')) {
    const rel = u.replace('http://localhost:8000/', '').replace(/^\.\//, '');
    const body = readFileSync(join(DOCS, rel), 'utf8');
    return { ok: true, status: 200, text: async () => body };
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    geminiCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(FAKE_CARD) }] } }],
      }),
    };
  }
  throw new Error(`想定外のfetch: ${u}`);
};
window.fetch = globalThis.fetch;

// ダウンロードを捕まえる(実ファイルは書き出さず、Blob だけ受け取る)
let downloaded = null;
globalThis.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:test'; };
globalThis.URL.revokeObjectURL = () => {};
window.URL.createObjectURL = globalThis.URL.createObjectURL;
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL;
window.HTMLAnchorElement.prototype.click = () => {};

localStorage.clear();

// --- app.js を読み込む(内部で共有アセットの取得が走る) ---
console.log('[1] ページ初期化');
await import(new URL('../docs/app.js', import.meta.url));
await sleep(300);

const $ = (id) => window.document.getElementById(id);

if ($('stock-empty').hidden === false) ok('起動直後は「カードがありません」を表示');
else fail('起動直後の空表示がおかしい');

// --- APIキーを入力 ---
console.log('\n[2] APIキーの保存');
$('api-key').value = 'DUMMY-KEY-FOR-TEST';
$('api-key').dispatchEvent(new window.Event('change'));
if (localStorage.getItem('anki_tool_gemini_api_key') === 'DUMMY-KEY-FOR-TEST') {
  ok('APIキーが localStorage に保存される');
} else {
  fail('APIキーが保存されない');
}

// --- 単語を入力して生成 ---
console.log('\n[3] 単語入力 → AI生成');
$('word-input').value = 'slated | The update is slated for release.\ngive up';
$('generate').click();
for (let i = 0; i < 100 && geminiCalls < 2; i += 1) await sleep(50);
await sleep(200);

if (geminiCalls === 2) ok(`2行の入力に対して Gemini を 2 回呼んだ(1件ずつ直列)`);
else fail(`Gemini 呼び出し回数: ${geminiCalls}(期待:2)`);

const items = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (items.length === 2) ok('ストックに 2 件保存された');
else fail(`ストック件数: ${items.length}(期待:2)`);

if (items[0]?.word === 'slated' && items[1]?.word === 'give up') {
  ok('「単語 | 文脈」のパースが正しい(give up の空白も保持)');
} else {
  fail(`パース結果: ${JSON.stringify(items.map((i) => i.word))}`);
}
if (items[0]?.meaning === FAKE_CARD.meaning) ok('AI応答の各フィールドが取り込まれている');
else fail('AI応答の取り込みに失敗');

if ($('word-input').value === '') ok('全件成功したので入力欄がクリアされた');
else fail('入力欄がクリアされていない');

if ($('stock-list').children.length === 2) ok('一覧に 2 件描画された');
else fail(`一覧の行数: ${$('stock-list').children.length}`);

// --- プレビュー ---
console.log('\n[4] カードプレビュー');
$('stock-list').querySelector('button').click();
await sleep(100);
if (dialogOpened) {
  const srcdoc = $('preview-frame').srcdoc || '';
  if (srcdoc.includes('slated') && srcdoc.includes('.card')) {
    ok('実テンプレート + CSS でレンダリングされた');
  } else {
    fail('プレビュー内容が想定と異なる');
  }
} else {
  fail('プレビューダイアログが開かない');
}

// --- apkg 出力 ---
console.log('\n[5] .apkg の書き出し');
$('export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);

if (!downloaded) {
  fail('.apkg が生成されなかった');
} else {
  const zip = await window.JSZip.loadAsync(Buffer.from(await downloaded.arrayBuffer()));
  const names = Object.keys(zip.files).sort();
  if (names.join(',') === 'collection.anki2,media') ok(`zip の中身: ${names.join(', ')}`);
  else fail(`zip の中身が想定外: ${names}`);

  const { DatabaseSync } = await import('node:sqlite');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const tmp = join(HERE, '.uitest_tmp.anki2');
  writeFileSync(tmp, await zip.file('collection.anki2').async('nodebuffer'));
  try {
    const db = new DatabaseSync(tmp);
    const notes = db.prepare('SELECT guid, flds FROM notes ORDER BY id').all();
    const cards = db.prepare('SELECT COUNT(*) AS n FROM cards').get();
    if (notes.length === 2) ok('apkg 内のノートが 2 件');
    else fail(`apkg 内のノート数: ${notes.length}`);
    if (cards.n === 4) ok('カードが 4 枚(2ノート × テンプレート2種)');
    else fail(`カード枚数: ${cards.n}(期待:4)`);
    if (notes[0].flds.split('\x1f')[0] === 'slated') ok('フィールドが正しい順で格納されている');
    else fail('フィールドの並びが想定外');
    db.close();
  } finally {
    try { unlinkSync(tmp); } catch { /* 残っても検証結果に影響しない */ }
  }
}

// --- 削除 ---
console.log('\n[6] 選択削除');
$('stock-list').querySelector('input[type="checkbox"]').checked = true;
$('delete-selected').click();
await sleep(100);
const after = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (after.length === 1 && after[0].word === 'give up') ok('選択した1件だけが削除された');
else fail(`削除後のストック: ${JSON.stringify(after.map((i) => i.word))}`);

console.log(failures
  ? `\n❌ ${failures} 件の問題があります。`
  : '\n✅ Web版UIの通し動作(生成→一覧→プレビュー→apkg→削除)はすべて正常です。');
process.exit(failures ? 1 : 0);
