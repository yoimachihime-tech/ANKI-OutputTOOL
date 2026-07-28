// tools/test_web_ui.mjs
// ---------------------------------------------------------------------------
// docs/index.html + app.js を jsdom 上で実際に動かし、画面操作の一通り
//   [単語タブ]       単語入力 → AI生成 → ストック表示 → プレビュー → .apkg 出力 → 削除
//   [AIに質問タブ]   質問入力 → AI生成(3問+習熟用4問目) → ストック表示 → プレビュー →
//                     .apkg 出力 → 削除
//   [習熟用(音読)タブ] AIに質問の4問目として自動追加されたことの確認 → プレビュー →
//                     .apkg 出力(出力後にストックが空になり、続き番号が進むこと) → 削除
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
const FAKE_WORD_CARD = {
  reading: '/<b>ˈsleɪ</b>tɪd/',
  pos: 'adj. (Past Participle)',
  meaning: '予定されている',
  example: 'The update is <b>slated</b> for release.<br>Ex1. It is <b>slated</b>.',
  example_ja: 'その更新は公開が予定されている。<br>予定されている。',
  example_blank: 'The update is ------- for release.',
  note: '【語源】slate に由来する。',
};

const FAKE_GRAMMAR_MULTI_NOTES = [
  {
    pattern: '選択問題',
    question: "空所に入る最も適切な語を選択肢から選びなさい。'She showed great ___.'",
    choices: [{ opt: 'A', text: 'patient' }, { opt: 'B', text: 'patience' }, { opt: 'C', text: 'patiently' }],
    answer: 'patience',
    correct_opt: 'B',
    examples: [['She has a lot of patience.', '彼女は忍耐力がある。']],
    why: '空所には名詞が入ります。',
    whynot: [{ opt: 'A', reason: 'patient は形容詞。' }, { opt: 'C', reason: 'patiently は副詞。' }],
  },
  {
    pattern: '誤り訂正問題',
    question: "次の英文を訂正してください。'I go to school yesterday.'",
    choices: [], answer: 'I went to school yesterday.', correct_opt: '',
    examples: [], why: '過去の出来事なので過去形にします。', whynot: [],
  },
  {
    pattern: '記述式・書き換え問題',
    question: '次の2文を1文にまとめてください。',
    choices: [], answer: 'It was raining, but we went out anyway.', correct_opt: '',
    examples: [], why: '逆接のbutで結びます。', whynot: [],
  },
];

// AIに質問タブの「4問目」(習熟用/音読)としてGeminiが返す想定の応答。
const FAKE_SHUUJUKU_ITEM = {
  pattern: "She doesn't 動詞",
  meaning: '三人称単数の否定文',
  examples: [["She doesn't like coffee.", '彼女はコーヒーが好きではない。']],
  expl: "三人称単数の否定は doesn't を使う。",
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
// 質問文に「選択問題」を含む場合はGrammar Multiの3問応答、それ以外は単語
// カードの応答を返す(呼び出し元のプロンプトを見て判別するのではなく、
// 単語タブ/AIに質問タブでそれぞれ別のテスト区間から呼ぶため、フラグで
// 切り替える方が単純で確実)。
let geminiMode = 'word';
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
    // grammar_multi モードでは、onAiAskGenerate()が「3問生成」の後に続けて
    // 「習熟用4問目」も生成するため、1回目と2回目で別の応答を返す必要がある
    // (呼び出し順は実装上always 3問→4問目の順で固定)。
    let text;
    if (geminiMode === 'grammar_multi') {
      text = geminiCalls === 1 ? JSON.stringify(FAKE_GRAMMAR_MULTI_NOTES) : JSON.stringify(FAKE_SHUUJUKU_ITEM);
    } else {
      text = JSON.stringify(FAKE_WORD_CARD);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
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

if ($('word-stock-empty').hidden === false) ok('起動直後は「カードがありません」を表示');
else fail('起動直後の空表示がおかしい');

if ($('settings').hidden === true && $('main-content').hidden === false) {
  ok('起動直後は設定が隠れ、通常画面(タブ)が表示されている');
} else {
  fail('起動直後の設定/通常画面の表示状態がおかしい');
}

// --- 設定の開閉(2026-07-28追加: 開いている間は通常画面を隠す) ---
console.log('\n[1.5] 設定の開閉');
$('settings-toggle').click();
if ($('settings').hidden === false && $('main-content').hidden === true) {
  ok('設定を開くと、通常画面(タブバー+タブの中身)が隠れる');
} else {
  fail('設定を開いても通常画面が隠れない');
}
$('settings-toggle').click();
if ($('settings').hidden === true && $('main-content').hidden === false) {
  ok('設定を閉じると、通常画面が元通り表示される');
} else {
  fail('設定を閉じても通常画面が復帰しない');
}

// --- APIキーを入力 ---
console.log('\n[2] APIキーの保存');
$('api-key').value = 'DUMMY-KEY-FOR-TEST';
$('api-key').dispatchEvent(new window.Event('change'));
if (localStorage.getItem('anki_tool_gemini_api_key') === 'DUMMY-KEY-FOR-TEST') {
  ok('APIキーが localStorage に保存される');
} else {
  fail('APIキーが保存されない');
}

async function dumpApkgAndCheck(blob, { expectedNoteCount, expectedCardCount, firstFieldEquals, tmpName }) {
  const zip = await window.JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const names = Object.keys(zip.files).sort();
  if (names.join(',') === 'collection.anki2,media') ok(`zip の中身: ${names.join(', ')}`);
  else fail(`zip の中身が想定外: ${names}`);

  const { DatabaseSync } = await import('node:sqlite');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const tmp = join(HERE, tmpName);
  writeFileSync(tmp, await zip.file('collection.anki2').async('nodebuffer'));
  try {
    const db = new DatabaseSync(tmp);
    const notes = db.prepare('SELECT guid, flds FROM notes ORDER BY id').all();
    const cards = db.prepare('SELECT COUNT(*) AS n FROM cards').get();
    if (notes.length === expectedNoteCount) ok(`apkg 内のノートが ${notes.length} 件`);
    else fail(`apkg 内のノート数: ${notes.length}(期待:${expectedNoteCount})`);
    if (cards.n === expectedCardCount) ok(`カードが ${cards.n} 枚`);
    else fail(`カード枚数: ${cards.n}(期待:${expectedCardCount})`);
    if (notes[0].flds.split('\x1f')[0] === firstFieldEquals) ok('フィールドが正しい順で格納されている');
    else fail(`フィールドの並びが想定外: ${notes[0].flds.split('\x1f')[0]}`);
    db.close();
  } finally {
    try { unlinkSync(tmp); } catch { /* 残っても検証結果に影響しない */ }
  }
}

// ===========================================================================
// 単語タブ
// ===========================================================================
console.log('\n[3] 単語タブ: 単語入力 → AI生成');
geminiMode = 'word';
geminiCalls = 0;
$('word-input').value = 'slated | The update is slated for release.\ngive up';
$('word-generate').click();

// 生成中のローディング表示(スピナー)を確認する。fetchはモックのため即座に
// 解決してしまうので、click()が同期的に実行する最初のawait直前
// (showLoading呼び出し)の時点、つまりclick()直後に確認する必要がある
// (sleepを挟むと、モックの高速な応答で生成そのものが終わってしまう)。
if ($('word-generate-status').classList.contains('loading')) {
  ok('生成中はローディング表示(スピナー)になる');
} else {
  fail('生成中にローディング表示が出ていない');
}

for (let i = 0; i < 100 && geminiCalls < 2; i += 1) await sleep(50);
await sleep(200);

if (geminiCalls === 2) ok('2行の入力に対して Gemini を 2 回呼んだ(1件ずつ直列)');
else fail(`Gemini 呼び出し回数: ${geminiCalls}(期待:2)`);

if (!$('word-generate-status').classList.contains('loading')) {
  ok('生成完了後はローディング表示が消える');
} else {
  fail('生成完了後もローディング表示が残っている');
}

const wordItems = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordItems.length === 2) ok('ストックに 2 件保存された');
else fail(`ストック件数: ${wordItems.length}(期待:2)`);

if (wordItems[0]?.word === 'slated' && wordItems[1]?.word === 'give up') {
  ok('「単語 | 文脈」のパースが正しい(give up の空白も保持)');
} else {
  fail(`パース結果: ${JSON.stringify(wordItems.map((i) => i.word))}`);
}
if (wordItems[0]?.meaning === FAKE_WORD_CARD.meaning) ok('AI応答の各フィールドが取り込まれている');
else fail('AI応答の取り込みに失敗');

if ($('word-input').value === '') ok('全件成功したので入力欄がクリアされた');
else fail('入力欄がクリアされていない');

if ($('word-stock-list').children.length === 2) ok('一覧に 2 件描画された');
else fail(`一覧の行数: ${$('word-stock-list').children.length}`);

console.log('\n[4] 単語タブ: カードプレビュー');
$('word-stock-list').querySelector('button').click();
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
dlg.close();

console.log('\n[5] 単語タブ: .apkg の書き出し');
downloaded = null;
$('word-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) {
  fail('.apkg が生成されなかった');
} else {
  await dumpApkgAndCheck(downloaded, {
    expectedNoteCount: 2,
    expectedCardCount: 4, // 2ノート × テンプレート2種
    firstFieldEquals: 'slated',
    tmpName: '.uitest_word.anki2',
  });
}

console.log('\n[6] 単語タブ: 選択削除');
$('word-stock-list').querySelector('input[type="checkbox"]').checked = true;
$('word-delete-selected').click();
await sleep(100);
const wordAfter = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfter.length === 1 && wordAfter[0].word === 'give up') ok('選択した1件だけが削除された');
else fail(`削除後のストック: ${JSON.stringify(wordAfter.map((i) => i.word))}`);

// ===========================================================================
// AIに質問タブ(Grammar Multi)
// ===========================================================================
console.log('\n[7] タブ切り替え: AIに質問');
document.querySelector('[data-tab="ai_ask"]').click();
if ($('tab-ai_ask').hidden === false && $('tab-word').hidden === true) {
  ok('AIに質問タブに切り替わった');
} else {
  fail('タブ切り替えが機能していない');
}

console.log('\n[8] AIに質問タブ: 質問入力 → AI生成(3問)');
geminiMode = 'grammar_multi';
geminiCalls = 0;
$('ai-ask-input').value = 'patience と patient の使い分けを教えて';
$('ai-ask-generate').click();

// click()直後(同期的に実行されるshowLoading呼び出しの直後)に確認する
// (単語タブと同じ理由。sleepを挟むとモックの高速応答で生成が終わってしまう)。
if ($('ai-ask-generate-status').classList.contains('loading')) {
  ok('生成中はローディング表示(スピナー)になる');
} else {
  fail('生成中にローディング表示が出ていない');
}

for (let i = 0; i < 100 && geminiCalls < 2; i += 1) await sleep(50);
await sleep(200);

if (geminiCalls === 2) ok('1つの質問に対して Gemini を 2 回呼んだ(3問まとめて1回 + 習熟用4問目1回)');
else fail(`Gemini 呼び出し回数: ${geminiCalls}(期待:2)`);

const aiAskItems = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (aiAskItems.length === 3) ok('ストックに 3 件(選択問題/誤り訂正問題/記述式)保存された');
else fail(`ストック件数: ${aiAskItems.length}(期待:3)`);

if (aiAskItems.every((it, i) => it.note_index === i && it.topic_key)) {
  ok('topic_key・note_index が正しく付与されている(guid計算・重複検出に使う)');
} else {
  fail(`topic_key/note_index: ${JSON.stringify(aiAskItems.map((i) => [i.topic_key, i.note_index]))}`);
}
if (aiAskItems[0]?.answer === '(B) patience') {
  ok('選択問題のAnswerに正解記号 "(B) " が付与されている');
} else {
  fail(`選択問題のanswer: ${JSON.stringify(aiAskItems[0]?.answer)}`);
}
if (aiAskItems[0]?.question.includes('<br><br>')) {
  ok('日本語指示文と英文の間に<br><br>が挿入されている');
} else {
  fail(`questionの整形結果: ${JSON.stringify(aiAskItems[0]?.question)}`);
}

const shuujukuAfterGenerate = JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]');
if (shuujukuAfterGenerate.length === 1 && shuujukuAfterGenerate[0].pattern === FAKE_SHUUJUKU_ITEM.pattern) {
  ok('AIに質問の4問目として習熟用(音読)ストックに1件追加された');
} else {
  fail(`習熟用ストック: ${JSON.stringify(shuujukuAfterGenerate)}`);
}
if (shuujukuAfterGenerate[0]?.source_kind === 'chat' && shuujukuAfterGenerate[0]?.source_topic) {
  ok('習熟用アイテムに source_kind/source_topic (guid計算用)が付与されている');
} else {
  fail(`習熟用アイテムのsource_kind/source_topic: ${JSON.stringify(shuujukuAfterGenerate[0])}`);
}

if ($('ai-ask-input').value === '') ok('生成成功後、質問欄がクリアされた');
else fail('質問欄がクリアされていない');

if ($('ai-ask-stock-list').children.length === 3) ok('一覧に 3 件描画された');
else fail(`一覧の行数: ${$('ai-ask-stock-list').children.length}`);

console.log('\n[9] AIに質問タブ: カードプレビュー');
$('ai-ask-stock-list').querySelector('button').click();
await sleep(100);
if (dialogOpened) {
  const srcdoc = $('preview-frame').srcdoc || '';
  if (srcdoc.includes('patience') && srcdoc.includes('.card')) {
    ok('実テンプレート + CSS でレンダリングされた');
  } else {
    fail('プレビュー内容が想定と異なる');
  }
} else {
  fail('プレビューダイアログが開かない');
}
dlg.close();

console.log('\n[10] AIに質問タブ: .apkg の書き出し');
downloaded = null;
$('ai-ask-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) {
  fail('.apkg が生成されなかった');
} else {
  await dumpApkgAndCheck(downloaded, {
    expectedNoteCount: 3,
    expectedCardCount: 3, // 3ノート × テンプレート1種(判断問題のみ)
    firstFieldEquals: '選択問題',
    tmpName: '.uitest_ai_ask.anki2',
  });
}

console.log('\n[11] AIに質問タブ: 選択削除');
$('ai-ask-stock-list').querySelector('input[type="checkbox"]').checked = true;
$('ai-ask-delete-selected').click();
await sleep(100);
const aiAskAfter = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (aiAskAfter.length === 2 && aiAskAfter[0].pattern === '誤り訂正問題') {
  ok('選択した1件だけが削除された');
} else {
  fail(`削除後のストック: ${JSON.stringify(aiAskAfter.map((i) => i.pattern))}`);
}

// ===========================================================================
// 習熟用(音読)タブ
// このタブには直接の入力欄が無く、[8]でのAIに質問の4問目としてのみ増える。
// ===========================================================================
console.log('\n[12] タブ切り替え: 習熟用(音読)');
document.querySelector('[data-tab="shuujuku"]').click();
if ($('tab-shuujuku').hidden === false && $('tab-ai_ask').hidden === true) {
  ok('習熟用(音読)タブに切り替わった');
} else {
  fail('タブ切り替えが機能していない');
}

if ($('shuujuku-stock-list').children.length === 1) ok('一覧に(4問目由来の)1件が描画された');
else fail(`一覧の行数: ${$('shuujuku-stock-list').children.length}`);

console.log('\n[13] 習熟用(音読)タブ: カードプレビュー');
$('shuujuku-stock-list').querySelector('button').click();
await sleep(100);
if (dialogOpened) {
  const srcdoc = $('preview-frame').srcdoc || '';
  // プレビューはNum/Contentが未確定のitemを、出力予定の次番号で仮レンダリング
  // したもの(showShuujukuPreview)。esc()はhtml.escape(s, quote=False)相当
  // なのでアポストロフィはエスケープされない("doesn't"のまま)。
  if (srcdoc.includes("doesn't")) {
    if (srcdoc.includes('deck-title') && srcdoc.includes('item-card')) {
      ok('render_item()相当のHTML(deck-title・item-card)でレンダリングされた');
    } else {
      fail('プレビューHTMLにdeck-title/item-cardが含まれない');
    }
  } else {
    fail('プレビュー内容が想定と異なる');
  }
} else {
  fail('プレビューダイアログが開かない');
}
dlg.close();

console.log('\n[14] 習熟用(音読)タブ: .apkg の書き出し(出力後にストックが空になる)');
downloaded = null;
$('shuujuku-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) {
  fail('.apkg が生成されなかった');
} else {
  await dumpApkgAndCheck(downloaded, {
    expectedNoteCount: 1,
    expectedCardCount: 1,
    firstFieldEquals: '001', // Numフィールド(続き番号1件目なので001)
    tmpName: '.uitest_shuujuku.anki2',
  });
}

const shuujukuAfterExport = JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]');
if (shuujukuAfterExport.length === 0) ok('出力成功後、習熟用ストックが空になった(mark_exported相当)');
else fail(`出力後の習熟用ストック件数: ${shuujukuAfterExport.length}(期待:0)`);

if (localStorage.getItem('anki_tool_shuujuku_next_num') === '2') {
  ok('続き番号カウンタが1件分進んだ(次回は002から)');
} else {
  fail(`続き番号カウンタ: ${localStorage.getItem('anki_tool_shuujuku_next_num')}(期待:"2")`);
}

if ($('shuujuku-stock-empty').hidden === false) ok('出力後、一覧が「カードがありません」表示に戻った');
else fail('出力後の一覧表示がおかしい');

console.log(failures
  ? `\n❌ ${failures} 件の問題があります。`
  : '\n✅ Web版UIの通し動作(単語タブ・AIに質問タブ・習熟用(音読)タブとも '
    + '生成→一覧→プレビュー→apkg→削除)はすべて正常です。');
process.exit(failures ? 1 : 0);
