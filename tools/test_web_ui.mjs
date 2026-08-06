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

// DailyConversationタブの「③ .apkgをダウンロード」で、カード化された行
// ごとに自動生成される習熟用(音読)候補としてGeminiが返す想定の応答。
const FAKE_SHUUJUKU_FROM_ROW = {
  pattern: 'She 動詞(三単現)',
  meaning: '三人称単数現在形の動詞にはsを付ける',
  examples: [['She works every day.', '彼女は毎日働く。']],
  expl: '主語が三人称単数のときは動詞にsを付ける。',
};

// 習熟用タブの入力欄(2026-08-06追加)で、正しい英文から生成される想定の応答。
// 入力文そのものは app.js 側が examples の先頭に置くので、Geminiからは
// その日本語訳(sentence_ja)と「別の例文2つ」だけを受け取る。
const FAKE_SHUUJUKU_FROM_SENTENCE = {
  pattern: 'have been 動詞ing since 時点',
  sentence_ja: '私は2020年からここで働いています。',
  meaning: '過去のある時点から現在まで続いている動作',
  examples: [
    ["She has been studying French since April.", '彼女は4月からフランス語を勉強しています。'],
    ['They have been waiting since noon.', '彼らは正午から待っています。'],
  ],
  expl: 'since の後には「時点」、for の後には「期間」が来る。',
};

// 習熟用タブの入力欄に「正しい文1つ + 誤りのある文1つ」を入れたときの
// 添削応答(正しい方だけがカードになることを確認するため)。
const FAKE_MIXED_CORRECTIONS = [
  {
    original: "I've been working here since 2020.",
    corrected: "I've been working here since 2020.",
    explanation: '誤りはありません。',
    category: '誤りなし',
    similar_expressions: [],
    grammar_score: 100,
    naturalness_score: 95,
    comprehensibility_score: 100,
    score_comment: '問題ありません。',
  },
  {
    original: 'She don\'t like coffee.',
    corrected: "She doesn't like coffee.",
    explanation: '三人称単数の否定は doesn\'t を使います。',
    category: '文法',
    similar_expressions: [],
    grammar_score: 50,
    naturalness_score: 60,
    comprehensibility_score: 90,
    score_comment: '時制と人称に注意。',
  },
];

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
// 添削(correctEnglishText)呼び出しだけを数える別カウンタ(2026-07-29追加)。
// onDailyCorrect()が添削の後に続けて習熟用(音読)候補生成も呼ぶようになり、
// geminiCallsの値だけでは「添削が正確に1回だけ呼ばれたか」を、両呼び出しが
// 同一tick内で連続して起こりうる(pollingでの中間状態観測がレースする)ため
// 判定できなくなった。添削のリクエストボディだけが`system_instruction`
// (構造化出力/JSON Mode)を含む(docs/lib/gemini.jsのcorrectEnglishText参照)
// ことを目印に区別する。
let correctionCalls = 0;
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
    const isCorrectionRequest = typeof init.body === 'string' && init.body.includes('system_instruction');
    if (isCorrectionRequest) correctionCalls += 1;
    // grammar_multi モードでは、onAiAskGenerate()が「3問生成」の後に続けて
    // 「習熟用4問目」も生成するため、1回目と2回目で別の応答を返す必要がある
    // (呼び出し順は実装上always 3問→4問目の順で固定)。
    let text;
    if (geminiMode === 'grammar_multi') {
      text = geminiCalls === 1 ? JSON.stringify(FAKE_GRAMMAR_MULTI_NOTES) : JSON.stringify(FAKE_SHUUJUKU_ITEM);
    } else if (geminiMode === 'correction') {
      // onDailyCorrect()は添削の後、続けて追記した行(「誤りなし」を除く)
      // ごとに習熟用(音読)候補も生成する。添削リクエストにだけ
      // system_instructionが付くので、それで判別する(呼び出し順のカウントに
      // 依存しない。連続する2呼び出しが同一tick内で起こりレースするため)。
      text = isCorrectionRequest ? JSON.stringify(FAKE_CORRECTIONS) : JSON.stringify(FAKE_SHUUJUKU_FROM_ROW);
    } else if (geminiMode === 'shuujuku_sentence') {
      // 習熟用タブの入力欄(2026-08-06)。まず添削(構造化出力)で正誤を判定し、
      // 「誤りなし」の文だけカード生成を呼ぶ、という2段構えを再現する。
      text = isCorrectionRequest
        ? JSON.stringify(FAKE_MIXED_CORRECTIONS)
        : JSON.stringify(FAKE_SHUUJUKU_FROM_SENTENCE);
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

// init() は bindEvents() を先頭で呼ぶ。以前は bindEvents() 内の
// `$('id').addEventListener(...)` が1つでも失敗すると init() の残り全部が
// 実行されず(2026-08-06、index.html と app.js の版が食い違って発生)、
// 「⋮メニューが開かない」「ログイン設定が空だと言われる」という
// 一見無関係な症状が同時に出た。init() が最後まで進んだことの目印として、
// bindEvents() より後で入るWorker URLの既定値を確認する。
if ($('oauth-worker-url').value.startsWith('https://')) {
  ok('init()がbindEvents()の先で止まらず、ログイン維持用WorkerのURLの既定値が入る');
} else {
  fail(`init()が途中で止まっている可能性がある(oauth-worker-url: ${JSON.stringify($('oauth-worker-url').value)})`);
}

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

console.log('\n[5] 単語タブ: .apkg の書き出し(出力済みタグ・フィルターの検証)');
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

const wordAfterExport1 = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfterExport1.length === 2 && wordAfterExport1.every((it) => it.exported_at)) {
  ok('出力に成功した2件とも exported_at が付与され、ストックには残る(削除されない)');
} else {
  fail(`出力後のストック: ${JSON.stringify(wordAfterExport1)}`);
}

if ($('word-filter-hide-exported').checked) {
  ok('「出力済みを隠す」フィルターは既定でON');
} else {
  fail('「出力済みを隠す」フィルターの既定値が想定と違う(ON のはず)');
}
if ($('word-stock-list').children.length === 0 && $('word-stock-empty').hidden === false
  && $('word-stock-empty').textContent.includes('すべて出力済み')) {
  ok('出力済みフィルターONのため、一覧が空表示になり理由も案内される');
} else {
  fail(`出力直後の一覧表示: 行数=${$('word-stock-list').children.length} / `
    + `空表示hidden=${$('word-stock-empty').hidden}`);
}

$('word-filter-hide-exported').checked = false;
$('word-filter-hide-exported').dispatchEvent(new window.Event('change'));
if ($('word-stock-list').children.length === 2
  && [...$('word-stock-list').querySelectorAll('.done-tag')].every((t) => t.textContent.includes('出力済み'))) {
  ok('フィルターを外すと出力済みの2件が「✓ 出力済み」タグ付きで表示される');
} else {
  fail(`フィルター解除後の表示: 行数=${$('word-stock-list').children.length}`);
}
if (localStorage.getItem('anki_tool_filter_word-filter-hide-exported') === '0') {
  ok('フィルターのON/OFFがlocalStorageに永続化される');
} else {
  fail('フィルター状態がlocalStorageに保存されていない');
}
$('word-filter-hide-exported').checked = true;
$('word-filter-hide-exported').dispatchEvent(new window.Event('change'));

console.log('\n[6] 単語タブ: 新規単語を追加して再出力(既出力分と混ざらないことを確認)');
geminiMode = 'word';
geminiCalls = 0;
$('word-input').value = 'resilient | She remained resilient.';
$('word-generate').click();
for (let i = 0; i < 100 && geminiCalls < 1; i += 1) await sleep(50);
await sleep(200);

if ($('word-stock-list').children.length === 1) {
  ok('フィルターON中、新規追加した未出力の1件だけが一覧に表示される(既出力の2件は隠れたまま)');
} else {
  fail(`新規追加後の表示行数: ${$('word-stock-list').children.length}(期待:1)`);
}

downloaded = null;
$('word-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) {
  fail('2回目の.apkgが生成されなかった');
} else {
  await dumpApkgAndCheck(downloaded, {
    expectedNoteCount: 1, // 既出力の2件を含まず、新規の1件だけが対象になるはず
    expectedCardCount: 2,
    firstFieldEquals: 'resilient',
    tmpName: '.uitest_word2.anki2',
  });
}
const wordAfterExport2 = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfterExport2.length === 3 && wordAfterExport2.every((it) => it.exported_at)) {
  ok('2回目の出力でも削除されず、3件とも出力済みになった');
} else {
  fail(`2回目出力後のストック: ${JSON.stringify(wordAfterExport2.map((i) => [i.word, !!i.exported_at]))}`);
}

console.log('\n[6.5] 単語タブ: 出力済み履歴のリセット');
$('word-reset-exported').click();
const wordAfterReset = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfterReset.every((it) => !it.exported_at)) {
  ok('「出力済み履歴をリセット」で exported_at がすべて消える(カードは削除されない)');
} else {
  fail(`リセット後のストック: ${JSON.stringify(wordAfterReset.map((i) => [i.word, !!i.exported_at]))}`);
}
if ($('word-stock-list').children.length === 3) {
  ok('リセット後、フィルターONのままでも3件とも(未出力扱いになり)表示される');
} else {
  fail(`リセット後の表示行数: ${$('word-stock-list').children.length}(期待:3)`);
}

console.log('\n[6.75] 単語タブ: 選択削除');
$('word-stock-list').querySelector('input[type="checkbox"]').checked = true;
$('word-delete-selected').click();
await sleep(100);
const wordAfter = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfter.length === 2 && wordAfter[0].word === 'give up') ok('選択した1件だけが削除された');
else fail(`削除後のストック: ${JSON.stringify(wordAfter.map((i) => i.word))}`);

console.log('\n[6.9] 単語タブ: 出力済みを削除(複数端末間の同期の容量節約、2026-07-30追加)');
// 残り2件を再出力して出力済みにしておく(前提づくり)。
downloaded = null;
$('word-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
const wordBeforeDeleteExported = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordBeforeDeleteExported.length === 2 && wordBeforeDeleteExported.every((it) => it.exported_at)) {
  ok('削除テストの前提として、残り2件を再出力し出力済みにした');
} else {
  fail(`前提が崩れている: ${JSON.stringify(wordBeforeDeleteExported)}`);
}
const wordDeletedIds = wordBeforeDeleteExported.map((it) => it.id);

$('word-delete-exported').click();
const wordAfterDeleteExported = JSON.parse(localStorage.getItem('anki_tool_word_stock') || '[]');
if (wordAfterDeleteExported.length === 0) {
  ok('「出力済みを削除」で出力済みカードがストックから完全に削除される(exported_atを消すだけの'
    + '「出力済み履歴をリセット」とは異なりカード自体が消える)');
} else {
  fail(`削除後のストック: ${JSON.stringify(wordAfterDeleteExported)}`);
}

const wordTombstonesAfterDelete = JSON.parse(localStorage.getItem('anki_tool_word_tombstones') || '[]');
if (wordDeletedIds.every((id) => wordTombstonesAfterDelete.includes(id))) {
  ok('削除した項目のidが打ち消し記録(tombstone)に残り、複数端末間の同期で他端末にも伝播できる');
} else {
  fail(`打ち消し記録: ${JSON.stringify(wordTombstonesAfterDelete)}(期待: ${JSON.stringify(wordDeletedIds)}を含む)`);
}

if ($('word-stock-list').children.length === 0 && $('word-stock-empty').hidden === false) {
  ok('削除後、一覧が「まだカードがありません」表示に戻る');
} else {
  fail('削除後の一覧表示がおかしい');
}

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

console.log('\n[10] AIに質問タブ: .apkg の書き出し(出力済みタグ・フィルターの検証)');
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

const aiAskAfterExport = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (aiAskAfterExport.length === 3 && aiAskAfterExport.every((it) => it.exported_at)) {
  ok('出力に成功した3件とも exported_at が付与され、ストックには残る(削除されない)');
} else {
  fail(`出力後のストック: ${JSON.stringify(aiAskAfterExport.map((i) => [i.pattern, !!i.exported_at]))}`);
}
if ($('ai-ask-filter-hide-exported').checked
  && $('ai-ask-stock-list').children.length === 0
  && $('ai-ask-stock-empty').textContent.includes('すべて出力済み')) {
  ok('「出力済みを隠す」が既定ONのため、出力直後は一覧が空表示になる');
} else {
  fail(`出力直後の表示: checked=${$('ai-ask-filter-hide-exported').checked} / `
    + `行数=${$('ai-ask-stock-list').children.length}`);
}

// 2回目に出力するとき、既出力の3件が対象に混ざらないことを単語タブと同じ
// ロジックで確認済みのため、ここでは出力済み履歴のリセットのみ検証する。
$('ai-ask-reset-exported').click();
const aiAskAfterReset = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (aiAskAfterReset.every((it) => !it.exported_at) && $('ai-ask-stock-list').children.length === 3) {
  ok('「出力済み履歴をリセット」で exported_at が消え、フィルターONのままでも3件とも再表示される');
} else {
  fail(`リセット後: ${JSON.stringify(aiAskAfterReset.map((i) => [i.pattern, !!i.exported_at]))}`);
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

console.log('\n[16] DailyConversation: スプレッドシート設定とGoogleログイン(ヘッダーのボタン)');
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

// ログイン維持用WorkerのURL(2026-08-05追加)。**最終的に空のまま**であることが、
// 以下のテストが従来の GIS token client 方式(フォールバック)を通る前提に
// なっている。設定した場合の挙動(認可コードフロー)はページ遷移を伴い jsdom で
// 再現できないため、tools/test_sheets.mjs の[6]で検証している。
$('oauth-worker-url').value = 'https://worker.example.test';
$('oauth-worker-url').dispatchEvent(new window.Event('change'));
if (localStorage.getItem('anki_tool_oauth_worker_url') === 'https://worker.example.test') {
  ok('ログイン維持用WorkerのURLが localStorage に保存される');
} else {
  fail('oauth-worker-url が localStorage に保存されない');
}
$('oauth-worker-url').value = '';
$('oauth-worker-url').dispatchEvent(new window.Event('change'));

// ログインの窓口はDailyConversationタブの中ではなくヘッダー(header-signin/
// header-signout)に一本化してある(2026-07-30、⚙設定の「複数端末間の同期」
// でもログインが必要になったため)。
tokenRequests = 0;
$('header-signin').click();
await sleep(100);
if (tokenRequests === 1 && lastTokenPrompt === '') {
  ok('ヘッダーのログインボタンで token client を prompt:"" (同意済みなら無操作)で呼ぶ');
} else {
  fail(`token 要求の回数/prompt: ${tokenRequests} / ${JSON.stringify(lastTokenPrompt)}`);
}
if ($('header-auth-status').textContent.includes('ログイン済み')
  && $('header-signin').hidden === true
  && $('header-signout').hidden === false
  && $('header-signout').disabled === false) {
  ok('ログイン後は状態表示が切り替わり、ログインボタンが隠れてログアウトボタンだけが表示される');
} else {
  fail(`ログイン後の表示: ${$('header-auth-status').textContent} / signin.hidden=${$('header-signin').hidden} / signout.hidden=${$('header-signout').hidden}`);
}

// ログアウト → 再ログインできること(トークンはメモリ上にしか無いので、
// ログアウト後は改めて token client を呼び直すはず)
$('header-signout').click();
if ($('header-auth-status').textContent.includes('未ログイン')
  && $('header-signin').hidden === false
  && $('header-signout').hidden === true
  && $('header-signout').disabled === true) {
  ok('ログアウトすると未ログイン表示に戻り、ログインボタンだけが再び表示される');
} else {
  fail(`ログアウト後の表示: ${$('header-auth-status').textContent} / signin.hidden=${$('header-signin').hidden} / signout.hidden=${$('header-signout').hidden}`);
}
tokenRequests = 0;
$('header-signin').click();
await sleep(100);
if (tokenRequests === 1 && $('header-auth-status').textContent.includes('ログイン済み')) {
  ok('ログアウト後も再ログインできる');
} else {
  fail(`再ログインできていない(token要求: ${tokenRequests})`);
}

console.log('\n[17] DailyConversation: 英文入力 → AI添削 → シートへ追記');
geminiMode = 'correction';
geminiCalls = 0;
correctionCalls = 0;
$('daily-input').value = 'I go to the park yesterday.';
$('daily-correct').click();
// onDailyCorrect()は添削の後、続けて追記した行(今回は1件)ごとに習熟用
// (音読)候補も生成する(2026-07-29追加)ため、合計2回のGemini呼び出しを待つ。
for (let i = 0; i < 200 && geminiCalls < 2; i += 1) await sleep(50);
await sleep(300);

if (correctionCalls === 1) ok('Gemini の添削呼び出しは1回だけ(複数文はGemini側が分割するため)');
else fail(`添削のGemini呼び出し回数: ${correctionCalls}(期待:1)`);

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

// 追記に成功したらそのまま②の読み込みまで連鎖する(デスクトップ版と同じ)
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

// デスクトップ版の_generate_shuujuku_candidates_from_rowsと同じく、①の
// 添削→シート追記の成功直後(③の.apkgダウンロードを待たず)に習熟用(音読)
// 候補が自動生成されることを確認する(2026-07-29追加)。「誤りなし」は
// 対象外なので、今回追記した1行(カテゴリ「文法」)についてのみ生成される。
const newRowId = sheetRows[3][0];
const shuujukuFromDaily = JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]');
if (shuujukuFromDaily.length === 1 && shuujukuFromDaily[0].pattern === FAKE_SHUUJUKU_FROM_ROW.pattern) {
  ok('添削→シート追記の成功直後に習熟用(音読)ストックへ1件追加された(「誤りなし」は対象外)');
} else {
  fail(`習熟用ストック: ${JSON.stringify(shuujukuFromDaily)}`);
}
if (shuujukuFromDaily[0]?.source_kind === 'dailyconv' && shuujukuFromDaily[0]?.source_topic === newRowId) {
  ok('習熟用アイテムのsource_kind/source_topicが今回追記した行のID由来で正しく付与されている');
} else {
  fail(`習熟用アイテムのsource_kind/source_topic: ${JSON.stringify([shuujukuFromDaily[0]?.source_kind, shuujukuFromDaily[0]?.source_topic])}(期待: ['dailyconv', ${JSON.stringify(newRowId)}])`);
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

// ===========================================================================
// DailyConversation: 重複行の警告表示とフィルター(2026-07-29追加)
// ===========================================================================
console.log('\n[21] DailyConversation: 重複行の警告表示とフィルター');

// 一覧をクリーンな状態に戻す(前段までの除外登録を解除)。
$('daily-clear-exclusions').click();

// 同じ原文の行を2件、シートに直接追加する(フォーム経由・直接入力経由での
// 二重投稿を模した状況)。既存の未出力行は id-b(誤りなし)のみのはず。
sheetRows.push(
  ['id-dup-1', '2026-07-29 08:00:00', 'Duplicate original text.', 'Duplicate original text (fixed).',
    '', '文法', '', '', '', '', '', '', ''],
  ['id-dup-2', '2026-07-29 08:05:00', 'Duplicate original text.', 'Duplicate original text, fixed differently.',
    '', '語彙', '', '', '', '', '', '', ''],
);
$('daily-refresh').click();
for (let i = 0; i < 100 && $('daily-pending-list').children.length < 3; i += 1) await sleep(50);

const tagsOf = (li) => [...li.querySelectorAll('.dup-tag')].map((t) => t.textContent.trim());
const lis = [...$('daily-pending-list').children];
if (lis.length === 3) ok('未出力3件(誤りなし1件+原文重複2件)が一覧に表示された');
else fail(`一覧の行数: ${lis.length}(期待:3)`);

if (tagsOf(lis[0]).some((t) => t.includes('誤りなし')) && !tagsOf(lis[0]).some((t) => t.includes('重複'))
  && tagsOf(lis[1]).some((t) => t.includes('重複')) && !tagsOf(lis[1]).some((t) => t.includes('誤りなし'))
  && tagsOf(lis[2]).some((t) => t.includes('重複')) && !tagsOf(lis[2]).some((t) => t.includes('誤りなし'))) {
  ok('原文が重複する行にだけ「⚠ 重複の可能性」バッジが付く(誤りなし行とは別バッジ)');
} else {
  fail(`バッジの付与が想定と違う: ${JSON.stringify(lis.map(tagsOf))}`);
}

console.log('\n[22] DailyConversation: フィルターチェックボックス');
$('daily-filter-hide-no-error').checked = true;
$('daily-filter-hide-no-error').dispatchEvent(new window.Event('change'));
if ($('daily-pending-list').children.length === 2
  && $('daily-pending-count').textContent === '(2 / 3 件表示)') {
  ok('「誤りなしを隠す」チェックで該当行が隠れ、件数が「表示/全体」形式になる');
} else {
  fail(`フィルター後の行数/件数表示: ${$('daily-pending-list').children.length} / `
    + `${$('daily-pending-count').textContent}`);
}

$('daily-filter-hide-no-error').checked = false;
$('daily-filter-hide-no-error').dispatchEvent(new window.Event('change'));
$('daily-filter-only-duplicates').checked = true;
$('daily-filter-only-duplicates').dispatchEvent(new window.Event('change'));
if ($('daily-pending-list').children.length === 2) {
  ok('「重複の可能性がある行のみ表示」チェックで重複2件だけになる');
} else {
  fail(`重複のみ表示時の行数: ${$('daily-pending-list').children.length}(期待:2)`);
}

$('daily-filter-only-duplicates').checked = false;
$('daily-filter-only-duplicates').dispatchEvent(new window.Event('change'));
if ($('daily-pending-list').children.length === 3
  && $('daily-pending-count').textContent === '(3 件)') {
  ok('両方のチェックを外すと全件表示に戻る');
} else {
  fail(`フィルター解除後の行数/件数表示: ${$('daily-pending-list').children.length} / `
    + `${$('daily-pending-count').textContent}`);
}

// 選択したうちの重複1件だけを除外しても、もう1件の重複判定には影響しない
// ことを確認する(重複判定はdailyPendingRows全体に対して行われるため、
// 除外操作の直後に再計算されるのが正しい)。
$('daily-filter-only-duplicates').checked = true;
$('daily-filter-only-duplicates').dispatchEvent(new window.Event('change'));
$('daily-pending-list').querySelector('input[type="checkbox"]').checked = true;
$('daily-exclude-selected').click();
await sleep(100);
$('daily-filter-only-duplicates').checked = false;
$('daily-filter-only-duplicates').dispatchEvent(new window.Event('change'));
const remainingTags = [...$('daily-pending-list').children].flatMap(tagsOf);
if ($('daily-pending-list').children.length === 2
  && !remainingTags.some((t) => t.includes('重複'))) {
  ok('重複ペアの片方を除外すると、残った方はもう重複扱いされなくなる');
} else {
  fail(`片方除外後のタグ: ${JSON.stringify(remainingTags)}`);
}

console.log('\n[23] DailyConversation: 出力済みのローカル記録・フィルター・リセット');

// 「Anki出力済みにする」チェックをOFFにして出力する(シート書き込みを
// 意図的に行わない、ローカル記録が独立して働くことを確認するケース)。
$('daily-mark-exported').checked = false;
downloaded = null;
$('daily-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (!downloaded) fail('.apkgが生成されなかった');
else ok('「Anki出力済みにする」OFFでも.apkgは生成される');
await sleep(200);

const dupRow2 = sheetRows.find((r) => r[0] === 'id-dup-2');
if (dupRow2 && !dupRow2[EXPORTED_COL]) {
  ok('チェックをOFFにしたため、シートの「Anki出力済み」列は書き換わらない');
} else {
  fail(`id-dup-2のシート上の状態: ${JSON.stringify(dupRow2)}`);
}
if (JSON.parse(localStorage.getItem('anki_tool_daily_exported_ids') || '[]').includes('id-dup-2')) {
  ok('シートへのマークとは独立に、ローカルへ出力済みとして記録される');
} else {
  fail('ローカルの出力済み記録が保存されていない');
}

if ($('daily-filter-hide-exported').checked
  && $('daily-pending-list').children.length === 1
  && $('daily-pending-count').textContent === '(1 / 2 件表示)') {
  ok('「出力済み(このブラウザで記録)を隠す」が既定ONのため、出力済みの行が一覧から隠れる');
} else {
  fail(`出力後の一覧: checked=${$('daily-filter-hide-exported').checked} / `
    + `行数=${$('daily-pending-list').children.length} / count=${$('daily-pending-count').textContent}`);
}

// 出力済みの行は次回の出力対象から外れる(2026-08-06に単語/AIに質問タブと
// 挙動を揃えた)。以前は表示フィルターに関わらず読み込んだ行を毎回すべて
// 出力しており、一覧から消えた行のTTSを毎回作り直していた。
// ここでは「読み込んだ2件のうち1件が出力済み」の状態なので、もう一度
// 押しても出力されるのは残り1件だけ……のはずだが、残る1件はID重複
// (id-dup-1/id-dup-2)側なのでprocessSheetRowsに弾かれ、結果として
// 「出力対象が無い」になる。どちらの経路でも「出力済みの行を作り直さない」
// ことは同じなので、.apkgが生成されないことで確認する。
downloaded = null;
$('daily-export').click();
await sleep(300);
if (!downloaded && $('daily-export-status').textContent.includes('出力対象の行がありません')) {
  ok('出力済みの行は次回の出力対象から外れる(同じ.apkgを作り直さない)');
} else {
  fail(`再出力の結果: downloaded=${Boolean(downloaded)} / `
    + `status=${$('daily-export-status').textContent}`);
}

$('daily-reset-exported').click();
if (JSON.parse(localStorage.getItem('anki_tool_daily_exported_ids') || '[]').length === 0
  && $('daily-pending-list').children.length === 2) {
  ok('「出力済みの印を外す」でローカル記録が消え、一覧に2件とも再表示される');
} else {
  fail(`リセット後: 記録=${localStorage.getItem('anki_tool_daily_exported_ids')} / `
    + `行数=${$('daily-pending-list').children.length}`);
}

// 印を外した後は、同じ行をもう一度出力できる(逃げ道が実際に機能すること)。
downloaded = null;
$('daily-mark-exported').checked = false;
$('daily-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (downloaded) ok('印を外せば、同じ行をもう一度出力できる');
else fail('印を外した後も再出力できない');
await sleep(200);
$('daily-reset-exported').click();
$('daily-mark-exported').checked = true;

// ---------------------------------------------------------------------------
// [24] バックアップの書き出し / 読み込み(2026-08-05追加)
//
// Web版はapkgの自動バックアップを持たないため、ストックの項目が「Ankiに
// 取り込む前の内容」を再現できる唯一のコピーになる。ここで固定したいのは、
// **削除済み(打ち消し記録にあるid)の項目も復元できること**。元のidのまま
// マージすると打ち消し記録に弾かれ、「バックアップから戻したのに復活しない」
// という一番困る挙動になるため、新しいidを振り直す実装にしてある。
// ---------------------------------------------------------------------------
console.log('\n[24] バックアップの書き出し / 読み込み');

// app.js は起動時にしか localStorage を読まないため、状態はUI経由で作る。
// 「AIに質問」タブで1件生成してから書き出す(このテスト内で確実に作れる経路)。
document.querySelector('[data-tab="ai_ask"]').click();
$('ai-ask-clear-stock').click();
await sleep(20);
geminiMode = 'grammar_multi';
// grammar_multi のモックは「1回目=3問、2回目以降=習熟用4問目」を
// geminiCalls で判別するため、必ず0に戻してから生成すること
// (通しで走ると前のセクションのぶんが累積していて、いきなり4問目の応答が
//  返り `parsed.map is not a function` になる)。
geminiCalls = 0;
$('ai-ask-input').value = 'バックアップ検証用の質問';
$('ai-ask-generate').click();
await sleep(400);
const beforeBackup = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (beforeBackup.length > 0) ok(`書き出し用に ${beforeBackup.length} 件のカードを用意`);
else fail(`バックアップ検証用のカードを用意できなかった: ${$('ai-ask-generate-status').textContent}`);

downloaded = null;
$('backup-export').click();
await sleep(50);
const backupJson = downloaded ? JSON.parse(await downloaded.text()) : null;
if (backupJson?.format === 'anki-tool-backup' && backupJson.version === 1
  && Array.isArray(backupJson.stocks.ai_ask_stock_items)
  && backupJson.stocks.ai_ask_stock_items.length === beforeBackup.length) {
  ok('バックアップJSONに3ストックの内容と形式・版番号が含まれる');
} else {
  fail(`書き出したJSONが想定と違う: ${JSON.stringify(backupJson)?.slice(0, 200)}`);
}
if (typeof backupJson?.shuujuku_next_num === 'number') {
  ok('習熟用の続き番号も一緒に書き出す(復元後のNum衝突を避けるため)');
} else {
  fail(`続き番号が書き出されていない: ${backupJson?.shuujuku_next_num}`);
}

// --- 全部削除してから復元する(打ち消し記録が残った状態での復元) ---
const restoredIds = backupJson.stocks.ai_ask_stock_items.map((it) => it.id);
$('ai-ask-clear-stock').click();
await sleep(20);
const tombstones = JSON.parse(localStorage.getItem('anki_tool_ai_ask_tombstones') || '[]');
if (JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]').length === 0
  && restoredIds.every((id) => tombstones.includes(id))) {
  ok('削除するとストックが空になり、打ち消し記録にidが残る');
} else {
  fail(`削除後の状態がおかしい: 記録=${JSON.stringify(tombstones)}`);
}

// ファイル選択をエミュレートする(jsdom の File は text() を持つ)
const backupFile = new window.File(
  [JSON.stringify(backupJson)], 'backup.json', { type: 'application/json' },
);
Object.defineProperty($('backup-file'), 'files', { value: [backupFile], configurable: true });
$('backup-file').dispatchEvent(new window.Event('change'));
await sleep(100);

const afterRestore = JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]');
if (afterRestore.length === beforeBackup.length) {
  ok('削除済みの内容もバックアップから復元できる');
} else {
  fail(`復元後の件数が想定と違う: ${afterRestore.length} / 期待 ${beforeBackup.length}`);
}
if (afterRestore.every((it) => !tombstones.includes(it.id))) {
  ok('復元した項目には新しいidが振られる(打ち消し記録に弾かれない)');
} else {
  fail('復元した項目が打ち消し記録のidのままになっている');
}
if (afterRestore.every((it, i) => it.question === beforeBackup[i].question)) {
  ok('カードの中身(質問文)はそのまま復元される');
} else {
  fail('復元後の内容が元と違う');
}

// --- 形式が違うファイルは弾く ---
const badFile = new window.File(['{"hello":1}'], 'other.json', { type: 'application/json' });
Object.defineProperty($('backup-file'), 'files', { value: [badFile], configurable: true });
$('backup-file').dispatchEvent(new window.Event('change'));
await sleep(50);
if (/バックアップファイルではないようです/.test($('backup-status').textContent)) {
  ok('このツールのバックアップでないファイルは読み込まずに知らせる');
} else {
  fail(`形式チェックが効いていない: ${$('backup-status').textContent}`);
}

// ---------------------------------------------------------------------------
// [25] 起動時の自動読み込み(2026-08-05追加)
//
// チェックボックスの状態が localStorage に永続化され、既定でONであることだけを
// ここで固定する(実際のpullは autoPullOnStartup がログイン済み・設定済みの
// ときにだけ走るもので、その中身は test_sync.mjs 側のマージ検証が担保する)。
// ---------------------------------------------------------------------------
console.log('\n[25] 起動時の自動読み込みの設定');

if ($('sync-auto-pull').checked === true) {
  ok('「起動時に自動で読み込む」は既定でONになっている');
} else {
  fail('既定値がONになっていない');
}
$('sync-auto-pull').checked = false;
$('sync-auto-pull').dispatchEvent(new window.Event('change'));
if (localStorage.getItem('anki_tool_filter_sync-auto-pull') === '0') {
  ok('OFFにした状態はlocalStorageへ永続化される(次回の起動でも維持される)');
} else {
  fail(`永続化されていない: ${localStorage.getItem('anki_tool_filter_sync-auto-pull')}`);
}

// ---------------------------------------------------------------------------
// [26] 通知バナーと⚙設定の「ログ」(2026-08-06追加)
//
// 状態表示は、ヘッダーのボタンに被らないようページ上端のバナー
// (#notice-banner)に出す。自動で消えた文言を見返すための仕組みは、
// 以前の「🗒 ログ」ボタン(直前の1件を再表示するだけ)をやめ、⚙設定の
// 「ログ」に履歴として積む方式にした。
// ---------------------------------------------------------------------------
console.log('\n[26] 通知バナーと⚙設定のログ');

if ($('header-auth-status').closest('#notice-banner')
  && $('header-sync-status').closest('#notice-banner')) {
  ok('ログイン・同期の状態表示はページ上端の通知バナーの中にある');
} else {
  fail('状態表示が #notice-banner の中に無い(ヘッダーのボタンに被る配置に戻っている)');
}

// ヘッダーに残るのは実際にタップするボタンだけ(枠が折り返さずに収まるよう
// ボタン数を減らしたのが、ログを設定内へ移した理由の一つ)。
if (!$('header-status-reveal') && !$('header-log')) {
  ok('ヘッダーから「🗒 ログ」ボタンが無くなっている');
} else {
  fail('ヘッダーに「🗒 ログ」ボタンが残っている');
}

// 直前のセクションまでで多数の状態表示(ログイン/ログアウト等)を出しているが、
// ログに積まれるのは data-log を持つ通知バナーの文言だけ。
const logItems = [...$('app-log').children].map((li) => li.textContent);
if (logItems.length > 0 && logItems.some((t) => t.includes('ログイン'))) {
  ok('通知バナーに出た文言が⚙設定のログに残る');
} else {
  fail(`ログが積まれていない: ${JSON.stringify(logItems)}`);
}
if (logItems.every((t) => !t.includes('中...'))) {
  ok('処理中の経過表示(「〜中...」)はログに残さない');
} else {
  fail(`経過表示までログに残っている: ${JSON.stringify(logItems)}`);
}
if ($('app-log-empty').hidden === true) {
  ok('ログが1件以上あるときは「まだログはありません」を隠す');
} else {
  fail('ログがあるのに空表示が出たままになっている');
}

// ⚙設定はヘッダーに直接置いてある(2026-08-06、⋮メニューを廃止)。
// ワンクッション無しに1タップで開けることを固定する。
if ($('settings-toggle').closest('.header-actions') && !$('header-menu-toggle')) {
  ok('⚙設定ボタンは⋮メニューに隠れずヘッダーに直接ある');
} else {
  fail('⚙設定ボタンがヘッダーに直接置かれていない');
}

$('app-log-clear').click();
if ($('app-log').children.length === 0 && $('app-log-empty').hidden === false) {
  ok('「ログを消去」で履歴が空になり、空表示が戻る');
} else {
  fail(`消去できていない: ${$('app-log').children.length} 件`);
}

// ---------------------------------------------------------------------------
// [27] .apkg出力の同時実行を防ぐ(2026-08-06追加)
//
// 片桐から「AIに質問でapkgを出力しながら習熟用タブでも同時に出力すると、
// AIに質問の方がちゃんと出力されないのに『出力済み』になる」と報告された。
// ブラウザは短時間に複数のダウンロードが起きると2つ目以降を破棄することが
// あり、`a.click()`は破棄されても例外を投げないため、アプリ側からは成功と
// 区別が付かない。**そもそも同時に走らせない**のが唯一の確実な対処。
// ---------------------------------------------------------------------------
console.log('\n[27] .apkg出力の同時実行を防ぐ');

document.querySelector('[data-tab="ai_ask"]').click();
$('ai-ask-clear-stock').click();
await sleep(20);
geminiMode = 'grammar_multi';
geminiCalls = 0; // モックの「1回目=3問、2回目以降=習熟用4問目」判別のため必須
$('ai-ask-input').value = '同時出力の検証用の質問';
$('ai-ask-generate').click();
await sleep(400);

const shuujukuBefore = JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]');
if (JSON.parse(localStorage.getItem('anki_tool_ai_ask_stock') || '[]').length > 0
  && shuujukuBefore.length > 0) {
  ok('検証用に「AIに質問」と「習熟用」の両方へカードを用意');
} else {
  fail('検証用のカードを用意できなかった');
}

// AIに質問の出力を始めた直後(await の途中)に、習熟用の出力も試みる。
downloaded = null;
$('ai-ask-export').click();

// 出力中は全タブの出力ボタンが「押せない見た目」になる。ただし disabled 属性は
// 使わない——ブラウザは無効なコントロールへのクリックをイベントとして配送
// しないため、押しても本当に何も起きず、理由を伝える機会が無くなるから
// (2026-08-06、片桐の指示で「その場合のみメッセージを出す」ようにした)。
const ariaDisabled = (id) => $(id).getAttribute('aria-disabled') === 'true';
if (ariaDisabled('shuujuku-export') && ariaDisabled('word-export') && ariaDisabled('daily-export')) {
  ok('出力中は他タブの出力ボタンも押せない見た目になる(aria-disabled)');
} else {
  fail('出力中に他タブの出力ボタンが押せない状態になっていない');
}
if (!$('shuujuku-export').disabled) {
  ok('disabled属性は使わない(押されたことを検知して理由を出すため)');
} else {
  fail('disabled属性が付いており、押しても理由を出せない');
}

$('shuujuku-export').click();
if ($('shuujuku-export-status').textContent.includes('出力が進行中です')) {
  ok('押した場合だけ、同時に出力できない理由をその場に表示する');
} else {
  fail(`理由が表示されなかった: ${$('shuujuku-export-status').textContent}`);
}
if (JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]').length
  === shuujukuBefore.length) {
  ok('拒否された側のストックは消えない(習熟用は出力成功時に空になる設計のため)');
} else {
  fail('拒否されたのに習熟用ストックが消えている');
}

for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (downloaded) ok('先に始めた「AIに質問」の出力は最後まで完了する');
else fail('先に始めた出力が完了しなかった');
await sleep(50);
if (!ariaDisabled('ai-ask-export') && !ariaDisabled('shuujuku-export')
  && !ariaDisabled('word-export') && !ariaDisabled('daily-export')) {
  ok('出力が終わると全タブの出力ボタンが再び押せるようになる');
} else {
  fail('出力後にボタンが押せないまま残っている');
}

// 直列にやり直せば、拒否された側もそのまま出力できる。
downloaded = null;
$('shuujuku-export').click();
for (let i = 0; i < 200 && !downloaded; i += 1) await sleep(50);
if (downloaded && JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]').length === 0) {
  ok('終わってから実行すれば、拒否された側も問題なく出力できる');
} else {
  fail(`やり直しの出力に失敗: downloaded=${Boolean(downloaded)}`);
}

// ---------------------------------------------------------------------------
// [28] 習熟用タブの入力欄(2026-08-06追加、Web版のみ)
//
// 入力した英文のうち**文法的に正しいものだけ**をカードにする。判定は
// DailyConversationと同じ correctEnglishText()(Googleフォーム経路の
// Apps Script と同じ system_instruction)を使い回しており、ここに独自の
// 判定を作らないこと自体が設計上の要点(採点基準を1箇所に保つため)。
// ---------------------------------------------------------------------------
console.log('\n[28] 習熟用タブ: 入力した英文からカードを作る');

document.querySelector('[data-tab="shuujuku"]').click();
$('shuujuku-clear-stock').click();
await sleep(20);
geminiMode = 'shuujuku_sentence';
correctionCalls = 0;

$('shuujuku-input').value = "I've been working here since 2020.\nShe don't like coffee.";
$('shuujuku-generate').click();
for (let i = 0; i < 200; i += 1) {
  await sleep(50);
  if ($('shuujuku-generate-status').textContent.includes('生成しました')) break;
}

const fromSentence = JSON.parse(localStorage.getItem('anki_tool_shuujuku_stock') || '[]');
if (fromSentence.length === 1) {
  ok('正しい文だけがカードになる(誤りのある文は作らない)');
} else {
  fail(`生成されたカード数: ${fromSentence.length}(期待:1) / ${$('shuujuku-generate-status').textContent}`);
}
if (correctionCalls === 1) {
  ok('正誤判定は複数文まとめて1回のAI呼び出しで済ませる');
} else {
  fail(`添削の呼び出し回数: ${correctionCalls}(期待:1)`);
}

const sentenceItem = fromSentence[0] || {};
if (sentenceItem.examples?.length === 3
  && sentenceItem.examples[0][0] === "I've been working here since 2020."
  && sentenceItem.examples[0][1] === FAKE_SHUUJUKU_FROM_SENTENCE.sentence_ja) {
  ok('入力した英文が1つ目の例文として、日本語訳付きでそのまま残る');
} else {
  fail(`examples: ${JSON.stringify(sentenceItem.examples)}`);
}
if (sentenceItem.examples?.[1][0] === FAKE_SHUUJUKU_FROM_SENTENCE.examples[0][0]
  && sentenceItem.examples?.[2][0] === FAKE_SHUUJUKU_FROM_SENTENCE.examples[1][0]) {
  ok('同じ文法パターンの別の例文が2つ続く(合計3例文)');
} else {
  fail(`生成された例文が期待と違う: ${JSON.stringify(sentenceItem.examples)}`);
}
if (sentenceItem.source_kind === 'sentence'
  && sentenceItem.source_topic === "i've been working here since 2020."
  && sentenceItem.source_label === '由来: 入力した英文') {
  ok('由来(source_kind/source_topic)が入力文として記録される(guid・重複検出に使う)');
} else {
  fail(`由来: ${JSON.stringify([sentenceItem.source_kind, sentenceItem.source_topic])}`);
}

const genStatus = $('shuujuku-generate-status').textContent;
if (genStatus.includes('誤り') && genStatus.includes("She don't like coffee.")
  && genStatus.includes('DailyConversation')) {
  ok('カードにしなかった文は、理由とDailyConversationタブへの案内を添えて伝える');
} else {
  fail(`誤りの通知が不十分: ${genStatus}`);
}

// 誤りのあった文はDailyConversationタブの入力欄へ転記される(2026-08-06追加)。
// 打ち直し・コピペの手間を省くため。タブの自動切り替えはしない。
if ($('daily-input').value.includes("She don't like coffee.")
  && !$('daily-input').value.includes("I've been working here since 2020.")) {
  ok('誤りのあった文だけがDailyConversationタブの入力欄へ転記される');
} else {
  fail(`転記の内容が期待と違う: ${JSON.stringify($('daily-input').value)}`);
}
if (document.querySelector('.tab-btn.active').dataset.tab === 'shuujuku') {
  ok('転記してもタブは切り替わらない(結果を読んでいる最中に画面が飛ばない)');
} else {
  fail('転記でタブが切り替わってしまった');
}

// 打ちかけの文を消さずに追記する。同じ文は重複させない。
$('daily-input').value = '打ちかけの文';
$('shuujuku-generate').click();
for (let i = 0; i < 200; i += 1) {
  await sleep(50);
  if ($('shuujuku-generate-status').textContent.includes('カードにしませんでした')) break;
}
if ($('daily-input').value === "打ちかけの文\nShe don't like coffee.") {
  ok('入力欄に先客があれば消さずに追記する');
} else {
  fail(`追記の結果が期待と違う: ${JSON.stringify($('daily-input').value)}`);
}
$('shuujuku-generate').click();
for (let i = 0; i < 200; i += 1) {
  await sleep(50);
  if ($('shuujuku-generate-status').textContent.includes('カードにしませんでした')) break;
}
if ($('daily-input').value === "打ちかけの文\nShe don't like coffee.") {
  ok('同じ文は二重に転記しない');
} else {
  fail(`重複して転記された: ${JSON.stringify($('daily-input').value)}`);
}
$('daily-input').value = '';
if ($('shuujuku-input').value !== '') {
  ok('誤りがあった場合は入力欄を消さない(どの文が弾かれたか見比べられるように)');
} else {
  fail('誤りがあったのに入力欄が消えている');
}

console.log(failures
  ? `\n❌ ${failures} 件の問題があります。`
  : '\n✅ Web版UIの通し動作(単語・AIに質問・習熟用(音読)・DailyConversationの'
    + '各タブ)はすべて正常です。');
process.exit(failures ? 1 : 0);
