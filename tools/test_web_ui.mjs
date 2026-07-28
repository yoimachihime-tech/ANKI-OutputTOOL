// tools/test_web_ui.mjs
// ---------------------------------------------------------------------------
// docs/index.html + app.js を jsdom 上で実際に動かし、画面操作の一通り
//   [単語タブ]       単語入力 → AI生成 → ストック表示 → プレビュー → .apkg 出力 → 削除
//   [AIに質問タブ]   質問入力 → AI生成(3問+習熟用4問目) → ストック表示 → プレビュー →
//                     .apkg 出力 → 削除
//   [習熟用(音読)タブ] AIに質問の4問目として自動追加されたことの確認 → プレビュー →
//                     .apkg 出力(出力後にストックが空になり、続き番号が進むこと) → 削除
//   [DailyConversationタブ] Googleログイン → 英文入力 → AI添削 → シートへ追記 →
//                     未出力行の一覧 → プレビュー → .apkg 出力 → シートの
//                     「Anki出力済み」マーク → 一覧から除外
// が動くことを確認する。
//
// 【Gemini API / Sheets API / Googleログインは呼ばない】
// fetch をモックして固定の応答を返し、Google Identity Services も
// window.google の偽実装に差し替えるため、APIキーも割り当ても実データも
// 一切消費しない。逆に言うと「実際のGeminiが期待どおりのJSONを返すか」
// 「実際のシートのヘッダーが想定どおりか」はこのテストの対象外で、
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

// DailyConversationタブの添削で Gemini が返す想定の応答(構造化出力なので
// 生のJSON配列がそのまま text に入る。```json フェンスは付かない)。
const FAKE_CORRECTIONS = [{
  original: 'I go to the park yesterday.',
  corrected: 'I went to the park yesterday.',
  explanation: '過去の出来事なので過去形にします。',
  category: '文法',
  similar_expressions: [{ expression: 'I visited the park yesterday.', note: 'visit は少し硬い。' }],
  grammar_score: 60,
  naturalness_score: 70,
  comprehensibility_score: 90,
  score_comment: '時制の誤りが1点。',
}];

// ---------------------------------------------------------------------------
// 「添削結果」スプレッドシートの偽実装(メモリ上の2次元配列)。
// Sheets API のうち、このアプリが使う4つの操作だけを再現する:
//   GET  values/<sheet>          … 全行取得(fetchPendingRows)
//   GET  values/<sheet>!1:1      … ヘッダー行(appendCorrectionRows/markRowsAsExported)
//   GET  values/<sheet>!A2:A     … ID列(markRowsAsExported)
//   POST values/<sheet>:append   … 新規行の追記
//   POST values:batchUpdate      … 「Anki出力済み」列への書き込み
// ---------------------------------------------------------------------------
const SHEET_HEADERS = [
  'ID', '日時', '原文', '添削後', '解説', 'カテゴリ',
  '類似表現(英文)', '類似表現(解説)',
  '文法スコア', '自然さスコア', '伝わりやすさスコア', 'スコア解説', 'Anki出力済み',
];
const EXPORTED_COL = SHEET_HEADERS.indexOf('Anki出力済み'); // = 12 (列M)

let sheetRows = [];
function resetFakeSheet() {
  sheetRows = [
    // 未出力・誤りあり → カード化の対象
    ['id-a', '2026-07-28 09:00:00', 'She don\'t like coffee.', 'She doesn\'t like coffee.',
      '三人称単数の否定は doesn\'t。', '語彙', 'She dislikes coffee.', 'dislike は硬め。',
      '55', '65', '85', '主語と動詞の一致。', ''],
    // 未出力だがカテゴリが「誤りなし」→ 一覧には出るが .apkg には含まれない
    ['id-b', '2026-07-28 09:01:00', 'This is fine.', 'This is fine.',
      '誤りはありません。', '誤りなし', '', '', '100', '100', '100', '問題なし。', ''],
    // 既に出力済み → 一覧に出てこない
    ['id-c', '2026-07-20 09:00:00', 'Already done.', 'Already done.',
      '', '文法', '', '', '', '', '', '', '2026-07-20 10:00:00'],
  ];
}
resetFakeSheet();

/** `添削結果!M2` のようなA1表記を {col, row}(0始まり列 / 1始まり行)にする。 */
function parseA1(range) {
  const m = /!([A-Z]+)(\d+)$/.exec(range);
  const col = [...m[1]].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  return { col, row: Number(m[2]) };
}

function handleSheetsRequest(url, init) {
  const decoded = decodeURIComponent(String(url));
  if ((init.method || 'GET') === 'POST') {
    const body = JSON.parse(init.body);
    if (decoded.includes(':append')) {
      sheetRows.push(...body.values);
      return { updates: { updatedRows: body.values.length } };
    }
    if (decoded.includes('values:batchUpdate')) {
      for (const d of body.data) {
        const { col, row } = parseA1(d.range);
        sheetRows[row - 2][col] = d.values[0][0]; // 1行目はヘッダー
      }
      return { totalUpdatedCells: body.data.length };
    }
    throw new Error(`想定外のSheets POST: ${decoded}`);
  }
  if (decoded.includes('!1:1')) return { values: [SHEET_HEADERS] };
  if (/!A2:A$/.test(decoded)) return { values: sheetRows.map((r) => [r[0]]) };
  return { values: [SHEET_HEADERS, ...sheetRows] };
}

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

// Google Identity Services (accounts.google.com/gsi/client) は jsdom では
// 読み込めないため、window.google を偽実装で先に用意しておく。
// sheets.js の loadGisScript() は window.google?.accounts?.oauth2 が既にあれば
// スクリプトを注入せず即座に解決するので、これだけで本番と同じ経路を通る。
let tokenRequests = 0;
let lastTokenPrompt = null;
window.google = {
  accounts: {
    oauth2: {
      initTokenClient: (config) => {
        const client = {
          ...config,
          requestAccessToken({ prompt } = {}) {
            tokenRequests += 1;
            lastTokenPrompt = prompt;
            client.callback({ access_token: 'ya29.fake-access-token', expires_in: 3600 });
          },
        };
        return client;
      },
    },
  },
};
globalThis.google = window.google;

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
let sheetsCalls = 0;
globalThis.fetch = async (url, init = {}) => {
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
    } else if (geminiMode === 'correction') {
      text = JSON.stringify(FAKE_CORRECTIONS);
    } else {
      text = JSON.stringify(FAKE_WORD_CARD);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    };
  }
  if (u.includes('sheets.googleapis.com')) {
    sheetsCalls += 1;
    return { ok: true, status: 200, json: async () => handleSheetsRequest(u, init) };
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

if (wordItems.every((it) => /^\d{4}-\d{2}-\d{2}T/.test(it.generated_at || ''))) {
  ok('各項目に生成日時(generated_at)が記録された');
} else {
  fail(`generated_atが記録されていない項目がある: ${JSON.stringify(wordItems.map((i) => i.generated_at))}`);
}
if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test($('word-stock-list').querySelector('.meta')?.textContent || '')) {
  ok('一覧に生成日時が「YYYY-MM-DD HH:MM」形式で表示される');
} else {
  fail(`一覧の生成日時表示が想定と違う: ${$('word-stock-list').querySelector('.meta')?.textContent}`);
}

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

if (aiAskItems.every((it) => it.generated_at === aiAskItems[0].generated_at)
  && /^\d{4}-\d{2}-\d{2}T/.test(aiAskItems[0]?.generated_at || '')) {
  ok('3問とも同じ生成日時(generated_at、1回のAI呼び出しで生成)が記録された');
} else {
  fail(`generated_atが想定と違う: ${JSON.stringify(aiAskItems.map((i) => i.generated_at))}`);
}
if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test($('ai-ask-stock-list').querySelector('.meta')?.textContent || '')) {
  ok('一覧に生成日時が表示される');
} else {
  fail('一覧に生成日時が表示されない');
}

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

if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test($('shuujuku-stock-list').querySelector('.meta')?.textContent || '')) {
  ok('一覧に生成日時が表示される');
} else {
  fail('一覧に生成日時が表示されない');
}

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

// ===========================================================================
// DailyConversationタブ(「添削結果」スプレッドシート連携)
// 他のタブと違い、候補の実体はローカルのストックではなくシートそのもの。
// ===========================================================================
console.log('\n[15] タブ切り替え: DailyConversation');
document.querySelector('[data-tab="daily"]').click();
if ($('tab-daily').hidden === false && $('tab-shuujuku').hidden === true) {
  ok('DailyConversationタブに切り替わった');
} else {
  fail('タブ切り替えが機能していない');
}

console.log('\n[16] DailyConversation: スプレッドシート設定とGoogleログイン');
for (const [id, key, value] of [
  ['google-client-id', 'anki_tool_google_client_id', 'dummy.apps.googleusercontent.com'],
  ['sheets-spreadsheet-id', 'anki_tool_sheets_spreadsheet_id', 'DUMMY_SHEET_ID'],
  ['sheets-sheet-name', 'anki_tool_sheets_sheet_name', '添削結果'],
]) {
  $(id).value = value;
  $(id).dispatchEvent(new window.Event('change'));
  if (localStorage.getItem(key) !== value) fail(`${id} が localStorage に保存されない`);
}
ok('クライアントID・スプレッドシートID・シート名が localStorage に保存される');

tokenRequests = 0;
$('daily-signin').click();
await sleep(100);
if (tokenRequests === 1 && lastTokenPrompt === '') {
  ok('ログインボタンで token client を prompt:"" (同意済みなら無操作)で呼ぶ');
} else {
  fail(`token 要求の回数/prompt: ${tokenRequests} / ${JSON.stringify(lastTokenPrompt)}`);
}
if ($('daily-auth-status').textContent.includes('ログイン済み')
  && $('daily-signin').textContent === '別のアカウントでログイン'
  && $('daily-signout').disabled === false) {
  ok('ログイン後は状態表示・ボタン文言・ログアウトボタンの有効状態が切り替わる');
} else {
  fail(`ログイン後の表示: ${$('daily-auth-status').textContent} / ${$('daily-signin').textContent}`);
}

// ログアウト → 再ログインできること(トークンはメモリ上にしか無いので、
// ログアウト後は改めて token client を呼び直すはず)
$('daily-signout').click();
if ($('daily-auth-status').textContent.includes('未ログイン')
  && $('daily-signin').textContent === 'Googleにログイン'
  && $('daily-signout').disabled === true) {
  ok('ログアウトすると未ログイン表示に戻る');
} else {
  fail(`ログアウト後の表示: ${$('daily-auth-status').textContent} / ${$('daily-signin').textContent}`);
}
tokenRequests = 0;
$('daily-signin').click();
await sleep(100);
if (tokenRequests === 1 && $('daily-auth-status').textContent.includes('ログイン済み')) {
  ok('ログアウト後も再ログインできる');
} else {
  fail(`再ログインできていない(token要求: ${tokenRequests})`);
}

console.log('\n[17] DailyConversation: 英文入力 → AI添削 → シートへ追記');
geminiMode = 'correction';
geminiCalls = 0;
$('daily-input').value = 'I go to the park yesterday.';
$('daily-correct').click();
for (let i = 0; i < 200 && geminiCalls < 1; i += 1) await sleep(50);
await sleep(300);

if (geminiCalls === 1) ok('Gemini を1回だけ呼んだ(複数文はGemini側が分割するため)');
else fail(`Gemini 呼び出し回数: ${geminiCalls}(期待:1)`);

if (sheetRows.length === 4) {
  const added = sheetRows[3];
  if (added[SHEET_HEADERS.indexOf('添削後')] === 'I went to the park yesterday.'
    && added[SHEET_HEADERS.indexOf('カテゴリ')] === '文法'
    && added[EXPORTED_COL] === '') {
    ok('添削結果がシートへ1行追記された(Anki出力済みは空)');
  } else {
    fail(`追記された行が想定と違う: ${JSON.stringify(added)}`);
  }
} else {
  fail(`シートの行数: ${sheetRows.length}(期待:4)`);
}

if ($('daily-input').value === '') ok('追記成功後、入力欄がクリアされた');
else fail('入力欄がクリアされていない');

// 追記に成功したらそのまま③の読み込みまで連鎖する(デスクトップ版と同じ)
if ($('daily-pending-list').children.length === 3) {
  ok('追記後に未出力行の一覧が自動更新された(未出力3件 / 出力済み1件は除外)');
} else {
  fail(`一覧の行数: ${$('daily-pending-list').children.length}(期待:3)`);
}
const dailyMetaTexts = [...$('daily-pending-list').querySelectorAll('.meta')].map((el) => el.textContent);
if (dailyMetaTexts.length === 3 && dailyMetaTexts.every((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t))) {
  ok('一覧の各行にシートの「日時」列由来の生成日時が表示される');
} else {
  fail(`日時の表示が想定と違う: ${JSON.stringify(dailyMetaTexts)}`);
}

if ($('daily-pending-list').textContent.includes('誤りなし(出力対象外)')) {
  ok('カテゴリ「誤りなし」の行に出力対象外である旨のバッジが付く');
} else {
  fail('「誤りなし」の行にバッジが付いていない');
}

console.log('\n[18] DailyConversation: カードプレビュー');
$('daily-pending-list').querySelector('button').click();
await sleep(100);
if (dialogOpened) {
  const srcdoc = $('preview-frame').srcdoc || '';
  if (srcdoc.includes("She doesn't like coffee.") && srcdoc.includes('誤り訂正問題(語彙)')) {
    ok('シートの行が実テンプレート(Pattern/Question/Answer)でレンダリングされた');
  } else {
    fail('プレビュー内容が想定と異なる');
  }
} else {
  fail('プレビューダイアログが開かない');
}
dlg.close();

console.log('\n[19] DailyConversation: .apkg の書き出し → シートの「Anki出力済み」マーク');
downloaded = null;
$('daily-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) {
  fail('.apkg が生成されなかった');
} else {
  await dumpApkgAndCheck(downloaded, {
    expectedNoteCount: 2,   // 未出力3件のうち「誤りなし」の1件は除外される
    expectedCardCount: 2,   // 2ノート × テンプレート1種
    firstFieldEquals: '誤り訂正問題(語彙)', // Patternフィールド(カテゴリ「語彙」由来)
    tmpName: '.uitest_daily.anki2',
  });
}
await sleep(300);

const markedIds = sheetRows.filter((r) => r[EXPORTED_COL]).map((r) => r[0]);
if (markedIds.includes('id-a') && !markedIds.includes('id-b') && markedIds.length === 3) {
  ok('出力対象の行だけがシートの「Anki出力済み」列にマークされた(誤りなしはマークしない)');
} else {
  fail(`マークされた行: ${JSON.stringify(markedIds)}`);
}

if ($('daily-pending-list').children.length === 1) {
  ok('マーク後に一覧が再読み込みされ、残りは「誤りなし」の1件だけになった');
} else {
  fail(`マーク後の一覧の行数: ${$('daily-pending-list').children.length}(期待:1)`);
}

console.log('\n[20] DailyConversation: 一覧から除外(シートは変更しない)');
const sheetRowsBeforeExclude = JSON.stringify(sheetRows);
$('daily-pending-list').querySelector('input[type="checkbox"]').checked = true;
$('daily-exclude-selected').click();
await sleep(100);

if ($('daily-pending-list').children.length === 0 && $('daily-pending-empty').hidden === false) {
  ok('選択した行が一覧から消えた');
} else {
  fail(`除外後の一覧の行数: ${$('daily-pending-list').children.length}(期待:0)`);
}
if (JSON.stringify(sheetRows) === sheetRowsBeforeExclude) {
  ok('除外してもスプレッドシート自体は一切変更されない');
} else {
  fail('除外でシートの内容が変わってしまっている');
}
if (JSON.parse(localStorage.getItem('anki_tool_daily_excluded_ids') || '[]').includes('id-b')) {
  ok('除外した行IDが localStorage に記録された(再訪しても非表示のまま)');
} else {
  fail('除外リストが保存されていない');
}

// 再読み込みしても除外は効いたままのはず
await (async () => {
  $('daily-refresh').click();
  for (let i = 0; i < 100 && $('daily-pending-list').children.length !== 0; i += 1) await sleep(50);
})();
if ($('daily-pending-list').children.length === 0) {
  ok('シートから読み込み直しても、除外した行は表示されない');
} else {
  fail('読み込み直すと除外が効かなくなっている');
}

console.log(failures
  ? `\n❌ ${failures} 件の問題があります。`
  : '\n✅ Web版UIの通し動作(単語・AIに質問・習熟用(音読)・DailyConversationの'
    + '各タブ)はすべて正常です。');
process.exit(failures ? 1 : 0);
