// app.js
// ---------------------------------------------------------------------------
// ANKI出力ツール Web版のUI。デスクトップ版(tts_gui.py)の各入力元タブに
// 相当する画面をまとめて持つ(現状: 単語 / AIに質問 / 習熟用(音読) /
// DailyConversation)。
//
// 【設計方針】
// タブごとにitemの形・重複判定キー・カード定義が異なるため、デスクトップ版
// (tts_gui.pyがrefresh_word_stock_view/refresh_ai_ask_stock_view等を別々に
// 持つ)と同じく、汎用化しすぎずタブごとに並行した関数を持たせてある。
// 共通化しているのはAPI呼び出し(lib/gemini.js)・apkg組み立て(lib/apkg.js)・
// guid計算(lib/guid.js)・ローディング表示のヘルパー(showLoading/hideLoading)
// のみ。
//
// DailyConversationタブだけは候補の実体がlocalStorageのストックではなく
// スプレッドシートそのもの(lib/sheets.js)で、他タブと共通の
// TAB_CONFIG/onExport/onDeleteSelected の枠組みには載せていない。

import {
  generateVocabCards, generateGrammarMultiItems, generateShuujukuItem, generateShuujukuItemsFromRows,
  generateShuujukuItemsFromSentences, generateShuujukuItemFromPhrases,
  phraseExampleCount, phraseExamplesMayOmit, MAX_PHRASE_EXAMPLES,
  correctEnglishText, consolidateNoErrorCorrections, listModels,
// `?v=` を付ける理由と注意点は、下の './lib/sheets.js?v=...' のコメントを参照
// (2026-08-21に付けた。穴あき例文 example_blank の生成を足したため、古い
//  gemini.js を掴んだままだと ExampleBlank が空のカードが出力される。
//  gemini.js を import しているのはこの app.js だけ)
} from './lib/gemini.js?v=20260829a';
// `?v=` を付ける理由と注意点は、下の './lib/sheets.js?v=...' のコメントを参照
// (2026-08-21: 一括出力タブのために buildApkg を複数種別対応にしたため、
// 古い apkg.js が使われると groups 指定が無視されてしまう)。
// apkg.js は app.js からしか import されていない。
import { buildApkg, fieldsFromItem } from './lib/apkg.js?v=20260829a';
// `?v=` を付ける理由と注意点は、下の './lib/sheets.js?v=...' のコメントを参照
// (2026-08-20: 習熟用のフィールド構成をv2へ変えた際、ここが無かったために
// ブラウザが古い lib/shuujuku.js を読み続け、旧Num/Content形式のカードが
// 出力され続けた)。shuujuku.js は app.js からしか import されていない。
import {
  buildFieldsReadyItem, buildFieldsReadyItems, getNextNum, advanceNextNum,
} from './lib/shuujuku.js?v=20260829a';
import {
  getNextDue, setNextDue, advanceNextDue, DUE_COUNTER_KEYS,
} from './lib/dueCounter.js';
// `?v=` を付ける理由と注意点は、下の './lib/sheets.js?v=...' のコメントを参照
// (2026-08-21に付けた。読み上げテキストの組み立てを変えたため、古い tts.js を
//  掴んだままだと「Ex1.」等が読み上げに残り続ける。tts.js を import している
//  のはこの app.js だけなので、実体が二重になる心配はない)
import {
  synthesizeFieldWithTags, synthesizeExampleAudioTags, synthesizeTestSample,
  decodeAudioSamples, computeWaveformMinMax, computePeakAmplitude, isClipped, findSafeVolumeGainDb,
} from './lib/tts.js?v=20260829a';
import {
  getAccessToken, clearAccessToken, signOut, isSignedIn,
  beginAuthCodeFlow, completeAuthCodeFlowIfReturning,
  fetchPendingRows, appendCorrectionRows, markRowsAsExported, SheetsAuthError,
  readSyncState, writeSyncState, fetchAppConfig,
// `?v=` は lib 側にも要る(2026-08-13)。index.html の `?v=` は app.js しか
// 更新しないため、これが無いとブラウザが古い lib/sheets.js を使い続ける。
// **他から import されていないモジュールにだけ付けること**——同じモジュールを
// 別々のURLで読むと実体が2つでき、ここでは accessToken などの状態が二重になる。
} from './lib/sheets.js?v=20260813a';
import * as dailyconv from './lib/dailyconv.js';
import {
  getAllUsage, usageSummary, clearCounts, clearLearnedLimits,
} from './lib/quota.js';
import {
  newSyncId, ensureItemIds, mergeStock, capacityPercent, parseIdArray,
  exceedsSyncLimit, SYNC_VALUE_LIMIT, CAPACITY_WARN_PERCENT, pruneTombstoneIds,
} from './lib/sync.js';

// フィルターチェックボックスの状態をlocalStorageに永続化する際のキー接頭辞
// (bindPersistentCheckbox()参照)。init()がモジュール読み込み直後に即時
// 呼び出されるため、この定数は必ずその呼び出しより前(モジュール先頭側)に
// 置くこと(TDZで「初期化前にアクセスされた」エラーになる)。
const FILTER_STORAGE_PREFIX = 'anki_tool_filter_';

/**
 * いま動いている app.js の版(2026-08-06追加)。
 *
 * index.html の `<script src="./app.js?v=...">` の `v` を、app.js 自身が
 * `import.meta.url` から読み取る(必ず読み込まれた実物の値になるので、
 * 定数を二重管理する必要がない)。
 *
 * **なぜ必要か**: GitHub Pages は HTML を約10分キャッシュする。`?v=` を
 * 付けていても**index.html 自体が古ければ古い `?v=` を要求する**ので、
 * 直したはずの挙動が直っていない、という食い違いが起きる(2026-08-06に
 * 「すべて大文字の語句が誤り扱いされる」と報告され、調べたら配信物は
 * 新版で、ブラウザだけが旧版を読んでいた)。画面に出しておけば、
 * 同じ報告が来たときに真っ先に版を確認できる。
 */
const APP_VERSION = (() => {
  try {
    return new URL(import.meta.url).searchParams.get('v') || '(開発版)';
  } catch {
    return '(不明)';
  }
})();

// モデル選択の「直接入力…」を表す番兵(2026-08-06)。実在のモデル名と衝突しない
// 値にしてある。**FILTER_STORAGE_PREFIX と同じ理由でここ(モジュール先頭側)に
// 置くこと**——init()はモジュール読み込み直後に即時実行され、その中の
// renderModelOptions()がこの値を参照する。定義が後ろにあると const の TDZ で
// 「初期化前にアクセスされた」となり、init()がそこで止まって
// **アプリ全体が中途半端な状態になる**(実際にこの順序を誤って一度踏んだ)。
const MODEL_CUSTOM_VALUE = '__custom__';

// 状態表示の自動非表示(2026-07-30追加)用の定数。init()がモジュール読み込み
// 直後に即時呼び出され、その中の同期処理(updateGoogleAuthStatus→setStatus)
// がこれらを参照するため、FILTER_STORAGE_PREFIXと同じ理由でモジュール先頭側に
// 置く必要がある(TDZ、詳細は下の「状態表示の自動非表示」セクションを参照)。
/**
 * ログイン維持用 Worker の既定URL(2026-08-05追加)。
 *
 * 【なぜアプリに埋め込むのか】
 * 新しいPC・スマホで使い始めるたびに8項目もの設定を手入力するのが面倒、
 * という指摘への対応。APIキーやスプレッドシートIDは Worker の
 * `GET /appconfig` がログイン後に配ってくれるが、**その Worker の URL 自体は
 * 配ってもらえない**(鶏と卵)。そこでこれだけをアプリ側に持たせ、
 * 「開いてログインするだけ」で使える状態にしている。
 *
 * この値は公開しても害が無い: Worker が持つ秘密(client_secret・APIキー)は
 * URLを知っているだけでは取り出せず、`/appconfig` はGoogleのアクセストークンを
 * 検証して本人のときだけ応答する(worker/src/index.js の verifyAccessToken)。
 *
 * ⚙設定の入力欄で上書きできる(Workerを作り直した場合や、Cloudflare側の
 * 障害時に従来方式へ退避したい場合のため)。
 */
const DEFAULT_OAUTH_WORKER_URL = 'https://anki-tool-oauth.anki-tool-oauth-worker.workers.dev';

const STATUS_AUTO_HIDE_MS = 10000;
const autoHideTimers = new WeakMap();

// ⚙設定の「ログ」に残す最大件数(2026-08-06追加)。古いものから捨てる。
const APP_LOG_MAX = 50;

const STORAGE = {
  apiKey: 'anki_tool_gemini_api_key',
  model: 'anki_tool_gemini_model',
  // 「一覧を取得」で得たモデル名の一覧(2026-08-06追加)。以前はdatalistへ
  // 直接流し込むだけで保存しておらず、ページを開き直すたびに候補が空に
  // 戻っていた(毎回「一覧を取得」を押し直す必要があった)。
  modelList: 'anki_tool_gemini_model_list',
  wordStock: 'anki_tool_word_stock',
  aiAskStock: 'anki_tool_ai_ask_stock',
  shuujukuStock: 'anki_tool_shuujuku_stock',
  ttsApiKey: 'anki_tool_tts_api_key',
  ttsVoice: 'anki_tool_tts_voice',
  ttsLang: 'anki_tool_tts_lang',
  ttsVolumeGainDb: 'anki_tool_tts_volume_gain_db',
  ttsExcludeJapanese: 'anki_tool_tts_exclude_japanese',
  googleClientId: 'anki_tool_google_client_id',
  // ログイン維持用 Worker の URL(2026-08-05追加)。設定されていると
  // リフレッシュトークン方式になり、ログインが1時間で切れなくなる
  // (docs/lib/sheets.js 冒頭・worker/README.md 参照)。
  oauthWorkerUrl: 'anki_tool_oauth_worker_url',
  spreadsheetId: 'anki_tool_sheets_spreadsheet_id',
  sheetName: 'anki_tool_sheets_sheet_name',
  wordTombstones: 'anki_tool_word_tombstones',
  aiAskTombstones: 'anki_tool_ai_ask_tombstones',
  shuujukuTombstones: 'anki_tool_shuujuku_tombstones',
};

/**
 * 複数端末間の同期(2026-07-30追加)。タブキー→打ち消し記録(tombstone)の
 * localStorageキーの対応表。onDeleteSelected/onClearStock/onExportShuujuku
 * が「削除・出力済みクリアしたitemのid」をここへ記録し、次回の同期
 * (onSyncNow)がリモートとマージする際に「削除済みは復活させない」判定に使う。
 */
const TOMBSTONE_STORAGE = {
  word: STORAGE.wordTombstones,
  ai_ask: STORAGE.aiAskTombstones,
  shuujuku: STORAGE.shuujukuTombstones,
};

/**
 * TTS埋め込み対象フィールド(item_key)。tts_gui.on_notetype_selected()の
 * デフォルト候補選択("Answer"/"Example"がある場合はその2つ、単語のように
 * Answerが無ければExampleのみ)と揃えてある。
 */
const TTS_FIELD_KEYS = {
  word: ['example'],
  ai_ask: ['answer', 'example'],
  // DailyConversation は Answer(添削後の文)と Example(類似表現)の両方が
  // 英文なので、デスクトップ版の既定選択と同じくその2つを対象にする。
  daily: ['answer', 'example'],
};

// ---------------------------------------------------------------------------
// .apkg 出力の同時実行防止(2026-08-06追加)
//
// 【なぜ必要か】片桐から「AIに質問でapkgを出力しながら習熟用タブでも同時に
// 出力すると、AIに質問の方がちゃんと出力されないのに『出力済み』になる」と
// 報告された。原因は2つある:
//
// (1) ブラウザは、1つのページが短時間に複数のファイルをダウンロードしようと
//     すると、2つ目以降を確認プロンプトで止めたり黙って破棄したりする
//     (Chromeの「複数のファイルのダウンロード」許可、iOS Safariの不安定さ)。
//     `downloadBlob`の`a.click()`は**破棄されても例外を投げない**ため、
//     アプリ側からは成功と区別が付かず、そのまま`exported_at`を付けてしまう。
//     ダウンロードの成否を知るブラウザAPIは無いので、**そもそも同時に
//     走らせない**のが唯一の確実な対処になる。
// (2) TTS付きの出力は数分かかることがあり、その間に別タブの出力を始められると
//     待ち時間が重なって「固まった」ようにも見える。
//
// 出力中は全タブの出力ボタンを「押せない見た目」にしたうえで、実際に押された
// ときは**なぜ押せないのかをその場に表示する**(2026-08-06、片桐の指示)。
//
// このとき `disabled` 属性は使えない。ブラウザは無効な form コントロールへの
// クリックを**イベントとして配送しない**(祖先にも上がらない)ため、押しても
// 本当に何も起きず、理由を伝える機会が無いまま「反応しないボタン」に見える。
// 代わりに `aria-disabled="true"` を付け、見た目はCSS(button[aria-disabled])で
// 無効そのものに揃え、クリックは受け取ってハンドラ側で弾く。支援技術にも
// 「操作できない」と正しく伝わり、かつ理由を読み上げられる。
// ---------------------------------------------------------------------------
let apkgExportInProgress = false;
const EXPORT_BUTTON_IDS = ['word-export', 'ai-ask-export', 'shuujuku-export', 'daily-export', 'bulk-export'];
const EXPORT_BUSY_MESSAGE = '.apkg の出力が進行中です。完了してからもう一度実行してください。\n'
  + '(同時にダウンロードするとブラウザ側で片方が破棄され、出力できていないのに'
  + '「出力済み」になってしまうことがあるため、1つずつ実行します)';

const $ = (id) => document.getElementById(id);

/** スマホ・タブレットかどうか(おおまかな判定。表示の出し分けにだけ使う)。 */
function isMobileBrowser() {
  const data = navigator.userAgentData;
  if (data && typeof data.mobile === 'boolean') return data.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
}

/** 共有アセット(プロンプト・カード定義・スキーマ)。起動時に読み込む。 */
const shared = {
  wordPrompt: null,
  grammarMultiPrompt: null,
  shuujukuPrompt: null,
  shuujukuSentencePrompt: null,
  shuujukuPhrasePrompt: null,
  shuujukuDailyconvPrompt: null,
  correctionSystemInstruction: null,
  correctionResponseSchema: null,
  cardDefs: null,
  ankiSchema: null,
};

let wordStock = loadJson(STORAGE.wordStock);
let aiAskStock = loadJson(STORAGE.aiAskStock);
let shuujukuStock = loadJson(STORAGE.shuujukuStock);

// 複数端末間の同期機能の追加(2026-07-30)に伴い、既存ストック項目に
// id/updated_at が無ければ補う(1回だけ実行し、変更があればそのまま保存する)。
migrateStockIds();

function migrateStockIds() {
  const w = ensureItemIds(wordStock);
  if (w.changed) { wordStock = w.items; localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock)); }
  const a = ensureItemIds(aiAskStock);
  if (a.changed) { aiAskStock = a.items; localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock)); }
  const s = ensureItemIds(shuujukuStock);
  if (s.changed) { shuujukuStock = s.items; localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock)); }
}

/** 打ち消し記録(tombstone、削除・出力済みクリア済みのid一覧)を読む。 */
function loadTombstoneIds(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTombstoneIds(storageKey, ids) {
  // **ソートしないこと**(2026-08-05にソートを廃止)。配列の並びを挿入順と
  // みなして古い方から刈り込むため(sync.js の pruneTombstoneIds を参照)、
  // ソートすると並びがUUIDの辞書順になって意味を失う。
  // Set は挿入順を保つので、重複除去だけなら順序は壊れない。
  const unique = [...new Set(ids)].filter(Boolean);
  localStorage.setItem(storageKey, JSON.stringify(pruneTombstoneIds(unique)));
}

/** 削除・出力済みクリアしたidを打ち消し記録へ追記する(和集合)。 */
function addTombstoneIds(storageKey, ids) {
  saveTombstoneIds(storageKey, [...loadTombstoneIds(storageKey), ...ids]);
}

/**
 * DailyConversation の「シート上の未出力行」。他のタブと違い実体は
 * スプレッドシート側(Anki出力済み列が空の行)なので localStorage には
 * 保存せず、読み込むたびにシートから取り直す(デスクトップ版と同じ方針)。
 * ローカルに持つのは「一覧から除外した行ID」だけ(dailyconv.js)。
 */
let dailyPendingRows = [];

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

init().catch((e) => {
  setStatus($('word-generate-status'), `初期化に失敗しました: ${e.message}`, true);
});

async function init() {
  bindEvents();
  $('api-key').value = localStorage.getItem(STORAGE.apiKey) || '';
  // いま動いている版を画面と開発者コンソールの両方に出す(2026-08-06)。
  // ブラウザが古いapp.jsを掴んでいるかどうかを、まずここで切り分けられる。
  const versionEl = $('app-version');
  if (versionEl) versionEl.textContent = APP_VERSION;
  console.info(`[ANKI出力ツール] app.js 版: ${APP_VERSION}`);

  // ヘッダーの「🔊 TTS」(PC上のローカルTTSツールの起動)は、PCでしか動かない。
  // スマホで押しても何も起きないボタンを見せないため、モバイルでは隠したまま
  // にする(⚙設定の中の説明と起動ボタンは常にある)。判定は当てにならない
  // ことがあるので、外れても困らない「表示するかどうか」だけに使っている。
  const launchEl = $('header-launch-tts');
  if (launchEl && !isMobileBrowser()) launchEl.hidden = false;

  renderModelOptions(loadCachedModels(), localStorage.getItem(STORAGE.model) || 'gemini-2.0-flash');
  $('tts-api-key').value = localStorage.getItem(STORAGE.ttsApiKey) || '';
  $('tts-voice').value = localStorage.getItem(STORAGE.ttsVoice) || $('tts-voice').value;
  $('tts-lang').value = localStorage.getItem(STORAGE.ttsLang) || $('tts-lang').value;
  $('tts-volume-gain').value = localStorage.getItem(STORAGE.ttsVolumeGainDb) || $('tts-volume-gain').value;
  $('tts-exclude-japanese').checked = localStorage.getItem(STORAGE.ttsExcludeJapanese) === '1';
  $('google-client-id').value = localStorage.getItem(STORAGE.googleClientId) || '';
  // Worker URL は既定値を持たせてある(2026-08-05)。新しい端末で使い始めるとき、
  // これが空だとログインすらできず、他の設定を配ってもらうこともできないため
  // (鶏と卵)。手入力での上書きは従来どおり可能。
  $('oauth-worker-url').value = localStorage.getItem(STORAGE.oauthWorkerUrl)
    || DEFAULT_OAUTH_WORKER_URL;
  $('sheets-spreadsheet-id').value = localStorage.getItem(STORAGE.spreadsheetId) || '';
  $('sheets-sheet-name').value = localStorage.getItem(STORAGE.sheetName) || $('sheets-sheet-name').value;
  renderWordStock();
  renderAiAskStock();
  renderShuujukuStock();
  renderBulkSummary();
  renderDailyPending();

  // Googleの同意画面から `?code=...` を付けて戻ってきた直後なら、ここで
  // トークン交換まで済ませる(2026-08-05追加、Worker方式)。設定の読み込みが
  // 終わってから呼ぶ必要はないが、状態表示より前である必要はある。
  await handleAuthRedirectReturn();
  updateGoogleAuthStatus();

  const [
    wordPrompt, grammarMultiPrompt, shuujukuPrompt, shuujukuDailyconvPrompt, shuujukuSentencePrompt,
    shuujukuPhrasePrompt,
    correctionSystemInstruction, correctionResponseSchema, cardDefsJson, ankiSchema,
  ] = await Promise.all([
    fetchText('./shared/word_card_prompt.txt'),
    fetchText('./shared/grammar_multi_prompt.txt'),
    fetchText('./shared/shuujuku_prompt.txt'),
    fetchText('./shared/shuujuku_dailyconv_prompt.txt'),
    fetchText('./shared/shuujuku_sentence_prompt.txt'),
    fetchText('./shared/shuujuku_phrase_prompt.txt'),
    fetchText('./shared/correction_system_instruction.txt'),
    fetchJson('./shared/correction_response_schema.json'),
    fetchJson('./shared/card_defs.json'),
    fetchJson('./shared/anki_schema.json'),
  ]);
  shared.wordPrompt = wordPrompt;
  shared.grammarMultiPrompt = grammarMultiPrompt;
  shared.shuujukuPrompt = shuujukuPrompt;
  shared.shuujukuDailyconvPrompt = shuujukuDailyconvPrompt;
  shared.shuujukuSentencePrompt = shuujukuSentencePrompt;
  shared.shuujukuPhrasePrompt = shuujukuPhrasePrompt;
  shared.correctionSystemInstruction = correctionSystemInstruction;
  shared.correctionResponseSchema = correctionResponseSchema;
  shared.cardDefs = cardDefsJson.defs;
  shared.ankiSchema = ankiSchema;

  // 他の端末が保存した内容を起動時に取り込む(2026-08-05追加、読み込みのみ)。
  // **await しない**: 通信を待つ間アプリが使えないと不便なので、裏で進めて
  // 完了したらヘッダーに件数を出すだけにする。失敗しても起動は妨げない
  // (autoPullOnStartup 側で握り潰してステータス表示に留めている)。
  autoPullOnStartup();
}

/**
 * Googleの同意画面から戻ってきた直後の後始末(2026-08-05追加)。
 *
 * 戻りでない通常の起動なら何もしない。トークン交換に失敗した場合でも
 * アプリ自体は起動させ、ヘッダーの状態表示に理由を出すだけにとどめる
 * (ログインが要らないタブは使えるため)。
 */
async function handleAuthRedirectReturn() {
  let result;
  try {
    result = await completeAuthCodeFlowIfReturning();
  } catch (e) {
    setStatus($('header-auth-status'), `ログインの完了処理に失敗しました: ${e.message}`, true);
    return;
  }
  if (!result.handled) return;

  restoreStateAfterAuthRedirect();
  if (result.error) setStatus($('header-auth-status'), result.error, true);
}

async function fetchText(url) {
  // shared/ 配下(プロンプト・card_defs.json・anki_schema.json)にも版を付ける
  // (2026-08-20追加)。index.html の `?v=` は app.js と style.css しか
  // 更新しないため、これが無いとブラウザが古い card_defs.json を読み続け、
  // 新しい lib/*.js と組み合わさって「フィールドが空のカードが出力される」
  // といった食い違いが起きる。版は app.js 自身の `?v=` から取るので、
  // index.html の値を更新すればここも一緒に切り替わる。
  const versioned = APP_VERSION && !APP_VERSION.startsWith('(')
    ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(APP_VERSION)}`
    : url;
  const res = await fetch(versioned);
  if (!res.ok) throw new Error(`${url} を読み込めませんでした (HTTP ${res.status})`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * フィルターチェックボックスの状態をlocalStorageに永続化する
 * (2026-07-29追加。タブ切り替え・再読み込みをまたいで、片桐が選んだ
 * 表示/非表示の設定が保持されるようにするため)。`bindEvents()`内、
 * 各タブの初回描画(`render*Stock`/`renderDailyPending`)より前に
 * 呼び出す必要がある(復元した値を初回描画に反映させるため)。
 *
 * @param {string} id チェックボックスの要素ID
 * @param {boolean} defaultValue 保存された値が無い場合の初期状態
 * @param {() => void} onChange 変更のたびに呼ぶ再描画関数
 */
function bindPersistentCheckbox(id, defaultValue, onChange) {
  const el = $(id);
  // on() と同じ理由で、要素が無くてもここで例外にしない(2026-08-06)。
  if (!el) {
    console.warn(`[bindEvents] チェックボックスが見つかりません: #${id}`);
    return;
  }
  const key = FILTER_STORAGE_PREFIX + id;
  const stored = localStorage.getItem(key);
  el.checked = stored === null ? defaultValue : stored === '1';
  el.addEventListener('change', () => {
    localStorage.setItem(key, el.checked ? '1' : '0');
    onChange();
  });
}

/**
 * イベント登録のヘルパー(2026-08-06追加)。要素が見つからなければ登録を
 * 飛ばし、コンソールに警告を出すだけにする。
 *
 * 【なぜ必要か】以前は `$('id').addEventListener(...)` を素で並べていたため、
 * **1つでもIDが見つからないとそこで例外になり、bindEvents()の残り全部と、
 * bindEvents()を先頭で呼ぶinit()の残り全部(Worker URLの既定値の設定など)が
 * 丸ごと実行されなくなる**という壊れ方をしていた。実際に2026-08-06、
 * ブラウザに古い app.js だけがキャッシュされて新しい index.html と組み合わさり
 * (通知バナー対応で `header-status-reveal` を削除し `app-log-clear` を
 * 追加したため、どちらが古くてもIDが食い違う)、
 * 「⋮メニューが開かない」「ログイン設定が空だと言われる」という
 * 一見無関係な2つの症状が同時に出た。
 * 個々の登録が独立して失敗するようにしておけば、多少の食い違いがあっても
 * アプリ全体が使えなくなることはない。
 */
function on(id, type, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`[bindEvents] 要素が見つかりません: #${id}`
      + '(index.html と app.js の版が食い違っている可能性があります。'
      + 'ブラウザのキャッシュを消して読み込み直してください)');
    return;
  }
  el.addEventListener(type, handler);
}

function bindEvents() {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ヘッダーのログインボタン(全タブ共通、2026-07-30追加)
  on('header-signin', 'click', onHeaderSignIn);
  on('header-sync-now', 'click', onHeaderSyncNow);

  on('header-signout', 'click', onHeaderSignOut);

  // 設定(全タブ共通)。2026-08-06に⋮メニューを廃止し、ヘッダーへ直接
  // 置き直した(メニューの開閉・外側クリックで閉じる処理はまるごと不要に
  // なったため撤去)。
  on('settings-toggle', 'click', toggleSettings);
  // 設定パネル自身の閉じるボタン(2026-07-30追加)。設定は縦に長いため、
  // 下までスクロールした位置からでも閉じられるようにするためのもの。
  on('settings-close', 'click', toggleSettings);
  on('due-next-save', 'click', onDueCounterSave);
  on('quota-clear-counts', 'click', onQuotaClearCounts);
  on('quota-clear-limits', 'click', onQuotaClearLimits);
  on('toggle-key', 'click', () => {
    const el = $('api-key');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  on('api-key', 'change', (e) => {
    localStorage.setItem(STORAGE.apiKey, e.target.value.trim());
  });
  on('model', 'change', onModelChanged);
  on('clear-key', 'click', onClearKey);
  on('fetch-models', 'click', onFetchModels);

  // TTS設定(全タブ共通)
  on('toggle-tts-key', 'click', () => {
    const el = $('tts-api-key');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  on('tts-api-key', 'change', (e) => {
    localStorage.setItem(STORAGE.ttsApiKey, e.target.value.trim());
  });
  on('tts-voice', 'change', (e) => {
    localStorage.setItem(STORAGE.ttsVoice, e.target.value.trim());
    markSettingsChanged();
  });
  on('tts-lang', 'change', (e) => {
    localStorage.setItem(STORAGE.ttsLang, e.target.value.trim());
    markSettingsChanged();
  });
  on('tts-volume-gain', 'change', (e) => {
    localStorage.setItem(STORAGE.ttsVolumeGainDb, e.target.value.trim());
    markSettingsChanged();
  });
  on('tts-exclude-japanese', 'change', (e) => {
    localStorage.setItem(STORAGE.ttsExcludeJapanese, e.target.checked ? '1' : '0');
    markSettingsChanged();
  });
  on('tts-test-play', 'click', onTestPlay);
  on('tts-auto-gain', 'click', onAutoGain);
  on('clear-tts-key', 'click', onClearTtsKey);

  // スプレッドシート設定(DailyConversationタブ用)
  on('google-client-id', 'change', (e) => {
    localStorage.setItem(STORAGE.googleClientId, e.target.value.trim());
    // クライアントIDが変わったら、古いトークンは使い回さない
    clearAccessToken();
    updateGoogleAuthStatus();
  });
  on('oauth-worker-url', 'change', (e) => {
    localStorage.setItem(STORAGE.oauthWorkerUrl, e.target.value.trim());
    // 認証方式そのものが切り替わるため、手元のアクセストークンは捨てる
    // (保存済みのリフレッシュトークンは残す。Worker URLの打ち間違いを
    //  直しただけで再ログインを強いられないようにするため)。
    clearAccessToken();
    updateGoogleAuthStatus();
  });
  on('sheets-spreadsheet-id', 'change', (e) => {
    localStorage.setItem(STORAGE.spreadsheetId, e.target.value.trim());
  });
  on('sheets-sheet-name', 'change', (e) => {
    localStorage.setItem(STORAGE.sheetName, e.target.value.trim());
  });
  on('sync-now', 'click', onSyncNow);
  // 起動時の自動読み込み(2026-08-05追加、既定ON)。init()末尾の
  // autoPullOnStartup() がこのチェックボックスを見るため、そこより前に
  // 状態を復元しておく必要がある(bindEvents() は init() の先頭で呼ばれる)。
  bindPersistentCheckbox('sync-auto-pull', true, () => {});

  // バックアップ(書き出し/読み込み、2026-08-05追加)
  on('backup-export', 'click', onBackupExport);
  on('backup-import', 'click', () => $('backup-file').click());
  on('backup-file', 'change', onBackupFileSelected);

  // ⚙設定の「ログ」(2026-08-06追加)
  on('app-log-clear', 'click', onClearAppLog);

  // 単語タブ
  on('word-generate', 'click', onWordGenerate);
  on('word-delete-selected', 'click', () => onDeleteSelected('word'));
  on('word-clear-stock', 'click', () => onClearStock('word'));
  bindPersistentCheckbox('word-filter-hide-exported', true, renderWordStock);
  on('word-reset-exported', 'click', () => onResetExported('word'));
  on('word-delete-exported', 'click', () => onDeleteExported('word'));
  on('word-export', 'click', () => onExport('word'));

  // AIに質問タブ
  on('ai-ask-generate', 'click', onAiAskGenerate);
  on('ai-ask-delete-selected', 'click', () => onDeleteSelected('ai_ask'));
  on('ai-ask-clear-stock', 'click', () => onClearStock('ai_ask'));
  bindPersistentCheckbox('ai-ask-filter-hide-exported', true, renderAiAskStock);
  on('ai-ask-reset-exported', 'click', () => onResetExported('ai_ask'));
  on('ai-ask-delete-exported', 'click', () => onDeleteExported('ai_ask'));
  on('ai-ask-export', 'click', () => onExport('ai_ask'));

  // 習熟用(音読)タブ(入力欄は無く、AIに質問からの4問目でのみ増える)
  on('shuujuku-generate', 'click', onShuujukuGenerate);
  on('shuujuku-delete-selected', 'click', () => onDeleteSelected('shuujuku'));
  on('shuujuku-clear-stock', 'click', () => onClearStock('shuujuku'));
  on('shuujuku-export', 'click', onExportShuujuku);

  // DailyConversationタブ(ログイン/ログアウトはヘッダーに一本化してあるため
  // ここには無い。下記「ヘッダーのログインボタン」を参照)
  on('daily-correct', 'click', onDailyCorrect);
  on('daily-refresh', 'click', () => refreshDailyPending($('daily-export-status')));
  bindPersistentCheckbox('daily-filter-hide-no-error', false, renderDailyPending);
  bindPersistentCheckbox('daily-filter-only-duplicates', false, renderDailyPending);
  bindPersistentCheckbox('daily-filter-hide-exported', true, renderDailyPending);
  on('daily-exclude-selected', 'click', onDailyExcludeSelected);
  on('daily-clear-exclusions', 'click', onDailyClearExclusions);
  on('daily-reset-exported', 'click', onDailyResetExported);
  on('daily-export', 'click', onDailyExport);

  on('bulk-refresh', 'click', renderBulkSummary);
  on('bulk-include-daily', 'change', renderBulkSummary);
  on('bulk-export', 'click', onExportBulk);

  // プレビュー(共通)
  on('preview-close', 'click', () => $('preview-dialog').close());
}

function switchTab(key) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === key;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${key}`;
  });
  // 他のタブでカードを増減した後に開かれることが多いので、表示のたびに
  // 数え直す(2026-08-20追加)。
  if (key === 'bulk') renderBulkSummary();
}

/**
 * ⚙設定の開閉(2026-07-28追加)。設定を開いている間はタブバー+各タブの
 * 中身(#main-content)をまとめて隠す。以前は設定を開いても下に通常画面が
 * そのまま残っていたため、「今どちらの状態が正しい見た目なのか」分かり
 * にくいという指摘への対応。#main-content側は個々のタブのhidden状態
 * (switchTabが管理する)をそのまま保持するので、設定を閉じれば
 * 開く前と同じタブ・同じ表示にそのまま戻る。
 */
function toggleSettings() {
  const willOpen = $('settings').hidden;
  $('settings').hidden = !willOpen;
  $('main-content').hidden = willOpen;
  $('settings-toggle').textContent = willOpen ? '✕ 設定を閉じる' : '⚙ 設定';
  // 開くたびに描き直す。これらの値は設定を開いていない間にも増えるため、
  // 一度描いたきりにすると必ず古い数字が出る。
  if (willOpen) {
    renderQuotaUsage();
    renderDueCounters();
  }
}

// ---------------------------------------------------------------------------
// 新規カードの位置(cards.due)の開始番号(2026-08-20追加)
//
// lib/dueCounter.js が持つ「次の開始番号」を設定画面に出し、手で直せる
// ようにする。Ankiコレクション側の実際の位置とは同期しないため、初回や
// Anki側で位置を振り直した後は、ここで入れ直す必要がある。
// ---------------------------------------------------------------------------

function renderDueCounters() {
  for (const key of DUE_COUNTER_KEYS) {
    const el = $(`due-next-${key}`);
    if (el) el.value = String(getNextDue(key));
  }
}

function onDueCounterSave() {
  const status = $('due-next-status');
  const invalid = [];
  const saved = [];
  for (const key of DUE_COUNTER_KEYS) {
    const el = $(`due-next-${key}`);
    if (!el) continue;
    const raw = el.value.trim();
    if (setNextDue(key, raw)) saved.push(`${key}=${getNextDue(key)}`);
    else invalid.push(`${key}: 「${raw}」`);
  }
  renderDueCounters();
  if (invalid.length) {
    setStatus(
      status,
      `1以上の整数を入力してください(この項目は保存していません): ${invalid.join(' / ')}`,
      true,
    );
    return;
  }
  setStatus(status, `位置の開始番号を保存しました: ${saved.join(' / ')}`);
}

// ---------------------------------------------------------------------------
// Gemini APIの使用状況(2026-08-06追加)
//
// 片桐から「AIの上限はすぐに変更になることが多いので、カウンターだと無意味に
// なる可能性が高い」との指摘を受けての設計。**上限値はソースに一切書かず**、
// Googleが429の応答で返してくる quotaValue を lib/quota.js が学習する。
// ここは学習済みの値があれば分母として表示し、無ければ回数だけを出す
// (推測の分母を出すと、まさに懸念された「古い数字を信じてしまう」状態になる)。
// ---------------------------------------------------------------------------

/** 使用率が何%を超えたら警告色にするか。 */
const QUOTA_WARN_PERCENT = 80;

function renderQuotaUsage() {
  const box = $('quota-usage');
  if (!box) return;

  const rows = getAllUsage();
  if (!rows.length) {
    box.innerHTML = '<p class="empty">今日はまだ呼び出していません。</p>';
    return;
  }

  box.innerHTML = '';
  for (const u of rows) {
    const percent = u.limit ? Math.min(100, Math.round((u.count / u.limit) * 100)) : null;

    const row = document.createElement('div');
    row.className = 'quota-row';
    if (percent !== null && percent >= QUOTA_WARN_PERCENT) row.classList.add('near-limit');

    const head = document.createElement('div');
    head.className = 'quota-head';

    const name = document.createElement('span');
    name.className = 'quota-model';
    name.textContent = u.model;
    head.appendChild(name);

    const count = document.createElement('span');
    count.className = 'quota-count';
    count.textContent = u.limit ? `${u.count} / ${u.limit} 回 (${percent}%)` : `${u.count} 回`;
    head.appendChild(count);

    row.appendChild(head);

    if (percent !== null) {
      const bar = document.createElement('div');
      bar.className = 'quota-bar';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }

    const meta = document.createElement('div');
    meta.className = 'quota-meta';
    meta.textContent = u.limit
      ? `上限はGoogleの応答から取得(${formatObservedAt(u.observedAt)}時点 / ${u.quotaId})`
      : 'まだ上限にぶつかっていないため、上限は不明です。';
    row.appendChild(meta);

    box.appendChild(row);
  }
}

function formatObservedAt(iso) {
  if (!iso) return '不明';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '不明' : d.toLocaleDateString();
}

/**
 * 生成完了時のメッセージに添える「今日 N/M回」。
 * 上限に近づいていることに、上限へぶつかる前に気づけるようにするためのもの。
 */
function quotaSuffix() {
  const summary = usageSummary($('model').value.trim());
  return summary ? `\n(Gemini呼び出し: ${summary})` : '';
}

function onQuotaClearCounts() {
  if (!confirm('今日の呼び出し回数の記録を0に戻しますか？\n\n'
    + 'Google側のカウンタは変わりません。他の端末と併用していて実際より'
    + '少なく出ている、といった場合に数え直すためのものです。')) return;
  clearCounts();
  renderQuotaUsage();
}

function onQuotaClearLimits() {
  if (!confirm('覚えている上限を忘れますか？\n\n'
    + '別のプロジェクト・別のティアのAPIキーに変えたときに使います。'
    + '次に上限へぶつかった時点で、新しい値を覚え直します。')) return;
  clearLearnedLimits();
  renderQuotaUsage();
}

// ---------------------------------------------------------------------------
// ローディング表示(2026-07-28追加)
// AI生成中であることが分かりにくいという指摘を受け、ボタンを無効化して
// 文言を変えるだけでなく、はっきり分かるスピナー付きの状態表示にした。
// ---------------------------------------------------------------------------

function showLoading(statusEl, message) {
  statusEl.classList.remove('error');
  statusEl.classList.add('loading');
  statusEl.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = message;
  statusEl.append(spinner, text);
  // 処理中は必ず見えている状態にする(自動非表示中でも復帰させる)。
  if (statusEl.hasAttribute('data-autohide')) {
    cancelAutoHideStatus(statusEl);
    statusEl.hidden = false;
  }
}

function hideLoading(statusEl) {
  statusEl.classList.remove('loading');
}

// ---------------------------------------------------------------------------
// 状態表示の自動非表示(2026-07-30追加、2026-08-06に表示場所を変更)
//
// 「ログイン済みです」(header-auth-status)・同期結果のセル容量使用率
// (header-sync-status/sync-status)は、常時出しっぱなしだと画面が煩雑に
// なるという指摘を受け、`data-autohide`属性を持つ要素に限り一定時間後に
// 自動で隠す(el.hidden = true)。エラー表示中は片桐が気づけるよう自動で
// 隠さない。
// 2026-08-06: 表示場所をページ上端の通知バナー(#notice-banner、
// index.html参照)に変更した。自動で消えた文言を見返すための仕組みは、
// 以前の「🗒 ログ」ボタン(直前の1件を再表示するだけ)をやめ、
// ⚙設定の「ログ」に履歴として積む方式(`data-log`属性、appendAppLog)に
// 置き換えた。定数(STATUS_AUTO_HIDE_MS等)はTDZの都合でモジュール先頭側
// (FILTER_STORAGE_PREFIXの近く)に置いてある。
// ---------------------------------------------------------------------------

function scheduleAutoHideStatus(el) {
  cancelAutoHideStatus(el);
  const timer = setTimeout(() => {
    el.hidden = true;
  }, STATUS_AUTO_HIDE_MS);
  autoHideTimers.set(el, timer);
}

function cancelAutoHideStatus(el) {
  const timer = autoHideTimers.get(el);
  if (timer) {
    clearTimeout(timer);
    autoHideTimers.delete(el);
  }
}

// ---------------------------------------------------------------------------
// ⚙設定の「ログ」(2026-08-06追加)
//
// 通知バナーは数秒で自動的に消えるため、見逃した内容を後から確認できる
// 場所として設定内にログを置く。以前はヘッダーの「🗒 ログ」ボタンが
// 「自動で隠れた直前の状態表示をもう一度出す」役割を担っていたが、
// (1) ヘッダーのボタンが増えて枠に収まらない (2) 直前の1件しか見返せない、
// という2点から履歴方式にして設定内へ移した。
// 保存はしない(ページを再読み込みすると消える)。診断のための一時的な
// 記録であり、localStorageの容量を使ってまで残す価値は無いと判断した。
// ---------------------------------------------------------------------------

/** 通知バナーに出した文言を設定内のログへ1件追加する(新しいものが上)。
 *  `data-log`属性を持つ状態表示要素についてのみ、setStatus から呼ばれる。 */
function appendAppLog(message, isError) {
  const list = $('app-log');
  if (!list || !message) return;

  const li = document.createElement('li');
  if (isError) li.className = 'error';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const text = document.createElement('span');
  text.textContent = message;
  li.append(time, text);
  list.prepend(li);

  while (list.children.length > APP_LOG_MAX) list.lastElementChild.remove();
  $('app-log-empty').hidden = true;
}

function onClearAppLog() {
  $('app-log').replaceChildren();
  $('app-log-empty').hidden = false;
}

// ---------------------------------------------------------------------------
// 設定(APIキー・モデル)
// ---------------------------------------------------------------------------

function onClearKey() {
  if (!confirm('保存したAPIキーをこのブラウザから消去します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE.apiKey);
  $('api-key').value = '';
}

// ---------------------------------------------------------------------------
// モデル選択(2026-08-06に <input list> + <datalist> から <select> へ変更)
//
// datalist はブラウザの仕様として**入力欄の文字に一致する候補しか出さない**
// ため、「gemini-3.6-flash」と入っている状態では候補がその1件だけになり、
// 別のモデルへ切り替えるにはまず文字を消す必要があった(片桐から
// 「何を入力していても一覧を全部出したい」との指摘)。select なら常に全件出る。
//
// select にしたことで、**options に無い値を .value に代入しても入らない**
// (空文字になる)という制約が生まれた。設定の同期・起動時の復元は保存済みの
// モデル名をそのまま代入するので、必ず ensureModelOption() を通すこと。
// ---------------------------------------------------------------------------

/** 「一覧を取得」で得た候補(localStorageに保存してあるもの)を読む。 */
function loadCachedModels() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.modelList) || '[]');
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    return [];
  }
}

/**
 * モデル選択の <option> を作り直す。
 * @param {string[]} names 候補(「一覧を取得」の結果)
 * @param {string} current 選択しておく値。**names に無くても必ず候補に含める**
 *   (一覧を取得していない状態でも、保存済みのモデルが消えないようにするため)
 */
function renderModelOptions(names, current) {
  const sel = $('model');
  const list = [...new Set(names.filter(Boolean))];
  const value = (current || '').trim();
  if (value && !list.includes(value)) list.unshift(value);

  sel.textContent = '';
  for (const name of list) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = MODEL_CUSTOM_VALUE;
  custom.textContent = '直接入力…';
  sel.appendChild(custom);

  sel.value = value || list[0] || '';
}

/** 指定の値が候補に無ければ足す(select は options に無い値を代入できないため)。 */
function ensureModelOption(value) {
  const v = (value || '').trim();
  if (!v) return;
  const sel = $('model');
  if (!sel || sel.tagName !== 'SELECT') return;
  if ([...sel.options].some((o) => o.value === v)) return;
  renderModelOptions(loadCachedModels(), v);
}

function onModelChanged() {
  const sel = $('model');
  const saved = localStorage.getItem(STORAGE.model) || '';

  if (sel.value === MODEL_CUSTOM_VALUE) {
    const entered = (prompt(
      '使用するモデル名を入力してください(例: gemini-2.0-flash)。',
      saved,
    ) || '').trim();
    if (!entered) {
      // 取り消したときは元の選択に戻す。「直接入力…」が選ばれたままだと、
      // その番兵の値がそのままAPIへ送られてしまう。
      renderModelOptions(loadCachedModels(), saved);
      return;
    }
    renderModelOptions(loadCachedModels(), entered);
  }

  localStorage.setItem(STORAGE.model, sel.value.trim());
  markSettingsChanged();
}

async function onFetchModels() {
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    alert('先にGemini APIキーを入力してください。');
    return;
  }
  const btn = $('fetch-models');
  btn.disabled = true;
  try {
    const names = await listModels(apiKey);
    localStorage.setItem(STORAGE.modelList, JSON.stringify(names));
    renderModelOptions(names, $('model').value.trim());
    alert(`${names.length} 件のモデルを取得しました。モデル欄から選べます。`);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

function onClearTtsKey() {
  if (!confirm('保存したTTS APIキーをこのブラウザから消去します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE.ttsApiKey);
  $('tts-api-key').value = '';
}

// ---------------------------------------------------------------------------
// TTS音声の埋め込み(2026-07-28追加)
// 現在の設定欄からCloud Text-to-SpeechのAPIキー等を読み、apkg出力の直前に
// 音声を合成して[sound:...]タグを埋め込む。TTS APIキーが空なら何もしない
// (従来どおり音声無しのapkgを出力する。他のAI呼び出しと同じ「未設定なら
// 黙ってスキップ」方針)。
// ---------------------------------------------------------------------------

function getTtsOptions() {
  const apiKey = $('tts-api-key').value.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    voiceName: $('tts-voice').value.trim() || 'en-US-Chirp3-HD-Iapetus',
    languageCode: $('tts-lang').value.trim() || 'en-US',
    volumeGainDb: Number($('tts-volume-gain').value) || 0,
    excludeJapanese: $('tts-exclude-japanese').checked,
  };
}

/**
 * ⚙設定「テスト再生」ボタン(2026-07-29追加)。tts_core.py の
 * synthesize_test_sample_wav + winsound再生のWeb版だが、Web版は波形表示・
 * gap_seconds(文と文の間隔)には対応せず、固定サンプル文を1回のTTS呼び出しで
 * MP3化して<audio>で再生するだけの簡易版(音声名・言語・音量ゲインの確認が
 * 主目的)。連打時は前の再生を止めてからやり直す(desktop版のPlaySound
 * SND_PURGEと同じ考え方)。
 */
// テスト再生用の状態(2026-07-29、実機で「音が鳴らない」と報告されたため
// AudioBufferSourceNode方式から<audio>要素方式に変更)。
//
// 当初はWeb Audio API(AudioContext.createBufferSource)で再生していたが、
// AudioContextは生成直後「suspended」状態になることがあり、ユーザー操作
// (クリック)と再生の間にawait(TTS合成・デコード)を挟むと、ブラウザによっては
// 「ユーザー操作起因」と見なされず自動でrunning状態に遷移しない
// (=source.start()を呼んでも無音のまま)。<audio>要素のplay()は同様の
// オートプレイ制限があっても失敗時に明確に例外を投げるため検知でき、
// かつAudioContextの状態管理を自前で扱う必要が無く実績も豊富なため、
// 再生自体は<audio>要素に戻した。波形解析(decodeAudioSamples等)は
// 再生の成否と無関係にWeb Audio APIのデコード機能だけを使うので変更なし。
//
// 追記(2026-07-29、スマホ実機で「NotAllowedError」により再生されないと
// 再報告): <audio>要素に戻しただけでは、TTS合成のネットワーク待ち(数秒)の
// 間に「ユーザー操作起因」の有効期限が切れるモバイル環境で依然play()が
// 拒否されることが判明。`onTestPlay`のコメントを参照(無音WAVを即座に再生して
// 要素を解禁し、後からsrcだけ差し替える方式に変更)。
let testPlayAudio = null;
let testAnimationFrameId = null;

/** 再生中のテスト音声・波形アニメーションを止める(連打時の多重再生防止)。 */
function stopTestPlayback() {
  if (testPlayAudio) {
    testPlayAudio.pause();
    testPlayAudio.loop = false;
    // onTestPlayでDOMに常駐させた要素を後片付けする(下記「モバイルでの
    // 再生ブロック対策」参照)。
    if (testPlayAudio.parentNode) testPlayAudio.parentNode.removeChild(testPlayAudio);
    testPlayAudio = null;
  }
  if (testAnimationFrameId !== null) {
    cancelAnimationFrame(testAnimationFrameId);
    testAnimationFrameId = null;
  }
}

/**
 * テスト再生の波形をcanvasに描画する(tts_core.pyの`_draw_test_waveform`に
 * 対応)。中心(0点)を挟んで上下に振れるbipolar表示。再生位置(progress、
 * 0.0〜1.0)より前のバーをアクセントカラー(音割れ時は警告色)、後ろを
 * 未再生色で塗り分ける。
 */
function drawTestWaveform(buckets, progress, clipped) {
  const canvas = $('tts-test-waveform');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  const styles = getComputedStyle(document.documentElement);
  const playedColor = (clipped ? styles.getPropertyValue('--danger') : styles.getPropertyValue('--accent')).trim() || '#4f6bed';
  const upcomingColor = styles.getPropertyValue('--border').trim() || '#d8dade';

  const mid = height / 2;
  const barWidth = width / buckets.length;
  buckets.forEach(([min, max], i) => {
    const played = i / buckets.length < progress;
    ctx.fillStyle = played ? playedColor : upcomingColor;
    const y1 = mid - max * mid;
    const y2 = mid - min * mid;
    ctx.fillRect(i * barWidth, y1, Math.max(1, barWidth - 1), Math.max(1, y2 - y1));
  });
}

/**
 * 完全な無音のWAVをBlob URLとして返す(モバイルでの再生ブロック対策、
 * `onTestPlay`から参照)。
 *
 * **2026-07-30修正**: 以前はサンプル1個(8000Hzで約0.125ミリ秒)だけの
 * 極端に短いWAVだった。TTS合成完了後にsrcを実音声へ差し替えても引き続き
 * 再生されない不具合が実機で報告され、原因はこの短さにあると考えられる
 * ——ほぼ一瞬で最後まで再生し終わってしまうため、`onTestPlay`が
 * `audio.loop = true`でループさせない限り「ユーザー操作起因で再生開始した」
 * という状態がTTS合成待ちの間(数秒)持続しない(ブラウザによっては
 * 再生が一瞬で終わった時点でこの状態を失効させることがある)。
 * ループ再生前提でも極端に短い音を高頻度でループさせるのはブラウザに
 * よって不安定になりうるため、それなりの長さ(0.25秒)の無音にした。
 * `ArrayBuffer`はゼロ初期化されるため、ヘッダー以降のサンプル領域は
 * 明示的に書き込まなくても全て無音(0)のままでよい。
 */
function createSilentWavBlobUrl() {
  const sampleRate = 8000;
  const numSamples = Math.round(sampleRate * 0.25); // 0.25秒分の無音
  const dataSize = numSamples * 2; // 16bit(2バイト)モノラル
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

/**
 * 事前計算した波形(buckets)を見ながらMP3を<audio>要素で再生し、経過時間に
 * 応じて波形アニメーションを進める(tts_core.pyの「再生前に全サンプルから
 * 概形を事前計算しておき、再生開始からの経過時間でその配列を参照しながら
 * 描画する」方式と同じ考え方。デスクトップ版はwinsound+time.monotonic()、
 * Web版は<audio>要素のcurrentTime基準)。
 * `audio`は`onTestPlay`が無音再生でユーザー操作起因の許可を得た同一要素
 * (下記のNotAllowedError対策コメント参照)。
 * @returns {Promise<void>} play()が実際に始まる(または失敗する)まで待つ
 */
async function playTestWaveform(audio, mp3Bytes, duration, buckets, clipped) {
  const blob = new Blob([mp3Bytes], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  // ループ再生していた無音WAVを止めて本番の音声に差し替える。srcの再設定は
  // 仕様上それ自体が現在の再生を停止させる(resource selection algorithm)ため、
  // 明示的なpause()は不要(2026-07-30、以前はここでpause()していたが削除)。
  audio.loop = false;
  audio.src = url;
  // `audio.currentTime = 0` はここでは呼ばない(2026-08-05削除)。src を代入した
  // 直後は readyState が HAVE_NOTHING で、この時点のシークは iOS Safari で
  // 不安定な挙動(InvalidStateError や以後の再生停止)の原因として知られている。
  // 新しいリソースの再生位置はどのみち先頭から始まるため、不要な操作だった。
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));

  const tick = () => {
    const progress = Math.min(1, audio.currentTime / duration);
    drawTestWaveform(buckets, progress, clipped);
    if (progress < 1 && testPlayAudio === audio) {
      testAnimationFrameId = requestAnimationFrame(tick);
    } else {
      testAnimationFrameId = null;
    }
  };
  tick();
  await audio.play();
}

/**
 * モバイル(特にiOS Safari)では、クリックからTTS合成完了(ネットワーク
 * 待ちで数秒かかることがある)までの間に「ユーザー操作起因」の有効期限が
 * 切れてしまい、その後の`audio.play()`が
 * NotAllowedError(「The request is not allowed by the user agent or the
 * platform...」)で拒否されることがある(2026-07-29、実機で報告)。対策として、
 * クリックハンドラの同期部分(await前)でまず無音WAVを即座に再生開始し、
 * その<audio>要素をユーザー操作起因の再生として"解禁"しておく。TTS合成後は
 * 同じ要素のsrcを実際の音声に差し替えて再度play()するだけにする(同一要素
 * であれば、srcの差し替え後のplay()も解禁状態が引き継がれる)。
 *
 * **2026-07-30修正(波形は表示されるが音が鳴らない不具合)**: 上記の対策を
 * 入れてもなお音が鳴らない場合があると再報告された。原因は2つ考えられる:
 * (1) 無音WAVがサンプル1個(約0.125ミリ秒)しかなく、再生開始した端から
 * 「再生終了」してしまうため、TTS合成待ちの数秒間"再生中"の状態を維持
 * できていなかった → `audio.loop = true`でTTS合成が終わるまでループさせ、
 * 常に"再生中"の状態を保つようにした(`createSilentWavBlobUrl`も参照)。
 * (2) `new Audio()`で作った要素がDOMツリーに属していないままだと、
 * 一部のモバイルブラウザで再生が不安定になることがある → `document.body`に
 * 明示的に追加する(`controls`属性が無いため画面上には何も表示されない)。
 */
async function onTestPlay() {
  const opts = getTtsOptions();
  if (!opts) {
    alert('先にCloud Text-to-Speech APIキーを入力してください。');
    return;
  }
  const statusEl = $('tts-test-status');
  const btn = $('tts-test-play');
  stopTestPlayback();
  btn.disabled = true;

  const audio = new Audio();
  document.body.appendChild(audio);
  const silentUrl = createSilentWavBlobUrl();
  audio.src = silentUrl;
  audio.loop = true;
  testPlayAudio = audio;
  const unlockPromise = audio.play().catch(() => {});

  showLoading(statusEl, 'テスト音声を生成中...');
  try {
    const bytes = await synthesizeTestSample(opts);
    const audioBuffer = await decodeAudioSamples(bytes);
    const buckets = computeWaveformMinMax(audioBuffer);
    const clipped = isClipped(computePeakAmplitude(audioBuffer));

    hideLoading(statusEl);
    setStatus(statusEl, clipped
      ? '再生中...(⚠ 音割れの可能性があります。音量ゲインを下げることを推奨します)'
      : '再生中...');

    await unlockPromise;
    if (testPlayAudio !== audio) { URL.revokeObjectURL(silentUrl); return; } // 連打等で別の再生に切り替わっている
    await playTestWaveform(audio, bytes, audioBuffer.duration, buckets, clipped);
    // 無音WAVのBlob URLの解放は、**本番の音声にsrcを差し替えた後**に行う
    // (2026-08-05修正)。以前はここより前で解放しており、要素がまだその無音WAVを
    // ループ再生している最中にURLを無効化していた。再生中のリソースをrevokeすると
    // audio.error を立てるブラウザがあり、以後の再生が無反応になり得る
    // (実機で報告されている「波形は出るが音が鳴らない」の候補の一つ。
    //  ただし本命は依然としてiPhone本体のサイレントスイッチで、これは
    //  アプリ側のコードでは制御できない)。
    URL.revokeObjectURL(silentUrl);
  } catch (e) {
    URL.revokeObjectURL(silentUrl);
    hideLoading(statusEl);
    setStatus(statusEl, e.message, true);
    // 失敗時、無音WAVがループ再生されたままDOMに残り続けないよう片付ける
    // (次にボタンを押すまで放置されても実害は無いが、念のため即座に止める)。
    if (testPlayAudio === audio) stopTestPlayback();
  } finally {
    btn.disabled = false;
  }
}

/**
 * ⚙設定「自動調整」ボタン(2026-07-29追加)。tts_core.find_safe_volume_gain_db()
 * のWeb版を呼び、0dBを超えない範囲までできるだけ音量ゲインを引き上げる。
 * 結果はスライダー(input)とlocalStorageの両方へ即座に反映する。
 */
async function onAutoGain() {
  const opts = getTtsOptions();
  if (!opts) {
    alert('先にCloud Text-to-Speech APIキーを入力してください。');
    return;
  }
  const statusEl = $('tts-test-status');
  const btn = $('tts-auto-gain');
  btn.disabled = true;
  showLoading(statusEl, '音割れしない音量ゲインを計算中...');
  try {
    const gainDb = Math.round(await findSafeVolumeGainDb(opts) * 10) / 10;
    $('tts-volume-gain').value = gainDb;
    localStorage.setItem(STORAGE.ttsVolumeGainDb, String(gainDb));
    hideLoading(statusEl);
    setStatus(statusEl, `音量ゲインを ${gainDb}dB に自動調整しました。`);
  } catch (e) {
    hideLoading(statusEl);
    setStatus(statusEl, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 単語/AIに質問タブ用: itemsのコピーを作り、fieldKeysで指定したフィールド
 * (item_key)に音声タグを追記する。元のストック(items引数)は変更しない
 * (再エクスポート時に二重にタグが付くのを防ぐため、buildApkg直前の
 * 一時的なコピーに対してのみ行う)。
 *
 * @returns {Promise<{items: object[], media: Map<string, Uint8Array>}>}
 */
async function embedTtsAudioIntoItems(items, fieldKeys, tabKey, status) {
  const media = new Map();
  const opts = getTtsOptions();
  if (!opts || fieldKeys.length === 0) return { items, media };

  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = { ...items[i] };
    for (const key of fieldKeys) {
      if (!item[key]) continue;
      showLoading(status, `音声を生成中... (${i + 1}/${items.length})`);
      item[key] = await synthesizeFieldWithTags(
        item[key],
        { ...opts, filenamePrefix: `tts_${tabKey}_${i}_${key}` },
        media,
      );
    }
    out.push(item);
  }
  return { items: out, media };
}

/**
 * 習熟用(音読)タブ用: 各itemのexamplesごとに音声タグを合成する。
 * buildFieldsReadyItems()のaudioTagsByItem引数にそのまま渡せる形で返す
 * (タグは対応する英文フィールド I1ExnEN の末尾に追記される)。
 *
 * @returns {Promise<{audioTagsByItem: string[][]|null, media: Map<string, Uint8Array>}>}
 */
async function embedShuujukuTtsAudio(items, status) {
  const media = new Map();
  const opts = getTtsOptions();
  if (!opts) return { audioTagsByItem: null, media };

  const audioTagsByItem = [];
  for (let i = 0; i < items.length; i += 1) {
    showLoading(status, `音声を生成中... (${i + 1}/${items.length})`);
    const tags = await synthesizeExampleAudioTags(
      items[i].examples || [],
      opts,
      media,
      `tts_shuujuku_${i}`,
    );
    audioTagsByItem.push(tags);
  }
  return { audioTagsByItem, media };
}

// ---------------------------------------------------------------------------
// 単語タブ
// ---------------------------------------------------------------------------

/** 正規化した単語をキーに、重複している要素の index を返す(表示用)。 */
function wordDuplicateIndices() {
  const counts = new Map();
  wordStock.forEach((item) => {
    const key = (item.word || '').trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  wordStock.forEach((item, i) => {
    if (counts.get((item.word || '').trim().toLowerCase()) > 1) dup.add(i);
  });
  return dup;
}

/**
 * 単語タブの一覧を描画する。2026-07-29に「出力済みを隠す」フィルターを
 * 追加した(既定ON、⚙設定と違いページ内のチェックボックス自体に状態を
 * 持たせ、bindPersistentCheckbox()でlocalStorageと同期する)。
 * `.apkg`出力に成功した項目は削除せず`exported_at`を付けてストックに
 * 残すため(onExport参照)、放置すると一覧が際限なく伸びる。既定で隠す
 * ことで「次に新しい単語を生成したとき、古い出力済みカードと混ざって
 * 見える」という問題を解消する。
 */
function renderWordStock() {
  const list = $('word-stock-list');
  const dup = wordDuplicateIndices();
  const hideExported = $('word-filter-hide-exported').checked;
  list.textContent = '';

  let visibleCount = 0;
  wordStock.forEach((item, i) => {
    if (hideExported && item.exported_at) return;
    visibleCount += 1;
    const tags = [];
    if (dup.has(i)) tags.push(' ⚠ 重複');
    if (item.exported_at) tags.push({ text: ' ✓ 出力済み', kind: 'done' });
    const li = buildStockRow({
      isDuplicate: dup.has(i),
      tags,
      rowId: item.id,
      title: item.word,
      subtitle: item.meaning || '(意味なし)',
      meta: formatDateTime(item.generated_at),
      onPreview: () => showPreview('word', item),
    });
    list.appendChild(li);
  });

  const empty = $('word-stock-empty');
  if (wordStock.length === 0) {
    empty.hidden = false;
    empty.textContent = 'まだカードがありません。';
  } else if (visibleCount === 0) {
    // 全件「出力済み」でフィルターに隠れている状態。空のリストだけが
    // 表示されて理由が分からなくなるのを防ぐ(2026-07-29追加)。
    empty.hidden = false;
    empty.textContent = 'すべて出力済みです。「出力済みを隠す」を外すと表示されます。';
  } else {
    empty.hidden = true;
  }
  $('word-stock-count').textContent = wordStock.length
    ? (visibleCount === wordStock.length
      ? `(${wordStock.length} 件)`
      : `(${visibleCount} / ${wordStock.length} 件表示)`)
    : '';
}

/** 「単語 | 文脈」形式の複数行入力をパースする(_parse_word_pairs と同じ)。 */
function parseWordPairs(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('|');
      return idx === -1
        ? { word: line, context: '' }
        : { word: line.slice(0, idx).trim(), context: line.slice(idx + 1).trim() };
    })
    .filter((p) => p.word);
}

async function onWordGenerate() {
  const status = $('word-generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.wordPrompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const pairs = parseWordPairs($('word-input').value);
  if (pairs.length === 0) {
    setStatus(status, '単語を入力してください。', true);
    return;
  }

  const btn = $('word-generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';
  const generated = [];
  const failed = [];

  try {
    // 2026-08-06、1件ずつN回呼ぶ方式からまとめて呼ぶ方式に変更した
    // (無料枠の上限はリクエスト数で数えられるため。lib/gemini.js の
    //  「まとめて生成(バッチ)」の項を参照)。
    showLoading(status, `生成中... (${pairs.length} 件)`);
    let cards;
    try {
      cards = await generateVocabCards({
        pairs,
        apiKey,
        model,
        promptTemplate: shared.wordPrompt,
        onProgress: (done, total) => {
          if (total > done) showLoading(status, `生成中... (${done}/${total} 件)`);
        },
      });
    } catch (e) {
      // バッチ全体が失敗した場合(APIキー不正・上限到達・応答が壊れている等)。
      // 個別の件に切り分けられないので、まとめて1件の失敗として扱う。
      hideLoading(status);
      setStatus(status, `生成に失敗しました: ${e.message}${quotaSuffix()}`, true);
      return;
    }

    cards.forEach((card, i) => {
      if (!card) {
        // AIの応答にこの件だけ含まれていなかった場合。他の件は活かす。
        failed.push(`${pairs[i].word}: AIの応答にこの単語が含まれていませんでした`);
        return;
      }
      const generatedAt = new Date().toISOString();
      generated.push({
        ...card, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt,
      });
    });

    if (generated.length > 0) {
      wordStock = wordStock.concat(generated);
      localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock));
      renderWordStock();
    }

    hideLoading(status);
    // 全件成功したときだけ入力欄を空にする(失敗した行を片桐が確認できるように)。
    if (failed.length === 0) {
      $('word-input').value = '';
      setStatus(status, `${generated.length} 件のカードを生成しました。${quotaSuffix()}`);
    } else {
      setStatus(
        status,
        `${generated.length} 件成功 / ${failed.length} 件失敗\n${failed.join('\n')}${quotaSuffix()}`,
        generated.length === 0,
      );
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// AIに質問タブ(Grammar Multi)
// ---------------------------------------------------------------------------

/** topic_key::note_index をキーに、重複している要素の index を返す(表示用)。
 * デスクトップ版のgrammar_multi_stock._item_key()と同じ考え方。 */
function aiAskDuplicateIndices() {
  const keyOf = (item) => `${item.topic_key || ''}::${item.note_index ?? ''}`;
  const counts = new Map();
  aiAskStock.forEach((item) => {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  aiAskStock.forEach((item, i) => {
    if (counts.get(keyOf(item)) > 1) dup.add(i);
  });
  return dup;
}

/** 単語タブと同じ理由(2026-07-29追加)で「出力済みを隠す」フィルターを持つ。 */
function renderAiAskStock() {
  const list = $('ai-ask-stock-list');
  const dup = aiAskDuplicateIndices();
  const hideExported = $('ai-ask-filter-hide-exported').checked;
  list.textContent = '';

  let visibleCount = 0;
  aiAskStock.forEach((item, i) => {
    if (hideExported && item.exported_at) return;
    visibleCount += 1;
    const questionPreview = htmlToPlainText(item.question).slice(0, 40);
    const tags = [];
    if (dup.has(i)) tags.push(' ⚠ 重複');
    if (item.exported_at) tags.push({ text: ' ✓ 出力済み', kind: 'done' });
    const li = buildStockRow({
      isDuplicate: dup.has(i),
      tags,
      rowId: item.id,
      title: item.pattern || '(形式未設定)',
      subtitle: questionPreview,
      meta: formatDateTime(item.generated_at),
      onPreview: () => showPreview('ai_ask', item),
    });
    list.appendChild(li);
  });

  const empty = $('ai-ask-stock-empty');
  if (aiAskStock.length === 0) {
    empty.hidden = false;
    empty.textContent = 'まだカードがありません。';
  } else if (visibleCount === 0) {
    empty.hidden = false;
    empty.textContent = 'すべて出力済みです。「出力済みを隠す」を外すと表示されます。';
  } else {
    empty.hidden = true;
  }
  $('ai-ask-stock-count').textContent = aiAskStock.length
    ? (visibleCount === aiAskStock.length
      ? `(${aiAskStock.length} 件)`
      : `(${visibleCount} / ${aiAskStock.length} 件表示)`)
    : '';
}

/**
 * ISO 8601 の日時文字列を「YYYY-MM-DD HH:MM」(ブラウザのローカル時刻)に
 * 整形する。一覧の各項目に「いつ生成したか」を表示するために使う
 * (2026-07-29追加)。パース不能な値・空文字は空文字を返す。
 */
function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function htmlToPlainText(html) {
  return (html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim();
}

async function onAiAskGenerate() {
  const status = $('ai-ask-generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.grammarMultiPrompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const question = $('ai-ask-input').value.trim();
  if (!question) {
    setStatus(status, '質問・お題を入力してください。', true);
    return;
  }

  const btn = $('ai-ask-generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';

  try {
    showLoading(status, 'AIに質問中...(3問生成には数十秒かかることがあります)');
    const items = await generateGrammarMultiItems({
      question,
      apiKey,
      model,
      promptTemplate: shared.grammarMultiPrompt,
    });
    const generatedAt = new Date().toISOString();
    aiAskStock = aiAskStock.concat(items.map((it) => ({
      ...it, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt,
    })));
    localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock));
    renderAiAskStock();

    // 4問目: 同じ質問の背景にある文法パターンを習熟用(音読)ストックへ追加する
    // (2026-07-28、デスクトップ版と同じ挙動)。この呼び出しの失敗は3問の生成
    // 成功を無効にしない(非ブロッキング)。
    let shuujukuNote = '';
    if (shared.shuujukuPrompt) {
      try {
        showLoading(status, '習熟用(音読)カードも生成中...');
        const shuujukuItem = await generateShuujukuItem({
          question,
          apiKey,
          model,
          promptTemplate: shared.shuujukuPrompt,
        });
        const shuujukuGeneratedAt = new Date().toISOString();
        shuujukuStock = shuujukuStock.concat([{
          ...shuujukuItem, id: newSyncId(), generated_at: shuujukuGeneratedAt, updated_at: shuujukuGeneratedAt,
        }]);
        localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
        renderShuujukuStock();
        shuujukuNote = ' + 習熟用(音読) 1件';
      } catch (e) {
        shuujukuNote = `(習熟用の4問目生成には失敗しました: ${e.message})`;
      }
    }

    hideLoading(status);
    $('ai-ask-input').value = '';
    setStatus(status, `${items.length} 件のカードを生成しました${shuujukuNote}${quotaSuffix()}`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 習熟用(音読)タブ
//
// カードの供給元は3つ:
//   1. このタブの入力欄(onShuujukuGenerate、2026-08-06追加)
//   2. 「AIに質問」タブの4問目(onAiAskGenerate)
//   3. DailyConversationタブの添削(generateShuujukuCandidatesFromRows)
// ---------------------------------------------------------------------------

/**
 * 入力された1行が「単語・句動詞などの表現」か「文」かを判定する
 * (2026-08-06追加)。
 *
 * **なぜローカルで判定するのか**: 単語・句動詞をそのまま`correctEnglishText()`
 * にかけると、文ではないので必ず「誤り」と判定され、カードにならずに
 * DailyConversationタブへ転記されてしまう(この機能を入れる前の挙動)。
 * 添削へ送る前に振り分ける必要があり、そのためにはAI呼び出しの前に
 * 決める必要がある。AIに分類させると1回呼び出しが増えるうえ、
 * 呼び出し回数を減らしてきた方針(「まとめて生成(バッチ)」参照)と逆行する。
 *
 * **判定規則(利用者に説明できる単純さを優先している)**:
 *   文末に `.` `!` `?` が付いていれば「文」。
 *   付いていなければ、5語以下なら「表現」、6語以上なら「文」。
 *   ただし区切り記号(`,` `、` `/` `・`)を含む場合は語数に関わらず「表現」。
 * 語数の条件を入れているのは、句読点を打たずに文を書く癖があっても
 * 長ければ文として扱われるようにするため。取り違えた場合は結果メッセージに
 * どちらとして扱ったかが出るので、**文末に「.」を付ければ確実に文として
 * 扱わせられる**(この逃げ道を画面の説明文にも書いてある)。
 *
 * **区切り記号の例外について(2026-08-06追加)**: 区切りは改行のみという方針
 * (片桐の選択)だが、`give up, look forward to, put off` のようにカンマで
 * 1行に並べてしまうことは起こりうる。この例外が無いと語数が6を超えて「文」と
 * 判定され、添削で「誤り」になってDailyConversationタブへ転記され、
 * **カードが1枚もできない**という一番分かりにくい失敗になる。表現として
 * 扱っておけば、少なくとも1枚は作られたうえで「1行1件にしてください」と
 * 案内できる(`looksLikeMultipleEntries`)。`ready, willing, and able` のように
 * カンマを含んで正しく1つの成句である場合も、この扱いなら壊れない。
 */
const PHRASE_MAX_WORDS = 5;

/** 1行に複数件を並べてしまったときによく使われる区切り記号。 */
const ENTRY_SEPARATOR_RE = /[,、/・]/;

function looksLikePhrase(line) {
  const s = (line || '').trim();
  if (!s) return false;
  if (/[.!?]$/.test(s)) return false;
  if (ENTRY_SEPARATOR_RE.test(s)) return true;
  return s.split(/\s+/).filter(Boolean).length <= PHRASE_MAX_WORDS;
}

/**
 * 1行に複数の語句を並べてしまっている可能性が高い行かを判定する
 * (結果メッセージでの案内にのみ使う。処理の振り分けは変えない)。
 */
function looksLikeMultipleEntries(line) {
  const s = (line || '').trim();
  if (!s || /[.!?]$/.test(s)) return false;
  return ENTRY_SEPARATOR_RE.test(s);
}

// ---------------------------------------------------------------------------
// 全部大文字の入力の自動修正(2026-08-06追加、習熟用タブのみ)
//
// 片桐から「習熟用タブですべて大文字だと誤り扱いになる。スペルが合っている
// なら小文字に自動修正してカード生成を進めたい」との要望。
//
// **なぜ添削の前にこちら側で直すのか**: 添削(correctEnglishText)のカテゴリは
// 「文法 / 語彙 / 自然さ / 誤りなし」の4つだけで(docs/shared/
// correction_response_schema.json)、大文字small文字の表記だけを表す
// カテゴリが無い。そのため「大文字が理由の誤りだけを見逃す」という
// 選び方ができない。また**system_instructionはApps Script(Googleフォーム
// 経路)と意味的に同一に保つルール**があるので、添削側に手を入れる選択肢も
// 無い。送る前に表記を直せば、スペルが正しければ素直に「誤りなし」になる。
//
// 直した結果はカードの内容にも使われる(片桐の補足「小文字に自動修正と
// いうのはカード生成時の話」)。**入力欄そのものは書き換えない**
// ——打った内容が勝手に変わるのは驚きが大きいため、結果メッセージで
// 「こう直して作りました」と伝えるに留める。
// ---------------------------------------------------------------------------

/** 英字がすべて大文字か(英字が1文字以下の行は対象外)。 */
function isAllUpperCase(text) {
  const s = text || '';
  const letters = s.match(/[A-Za-z]/g);
  if (!letters || letters.length < 2) return false;
  return !/[a-z]/.test(s);
}

/**
 * 全部大文字の入力を、カードに載せられる通常の表記へ直す。
 *
 * @param {boolean} asSentence 文として扱う行なら true(文頭を大文字に戻す)。
 *   単語・句動詞は小文字のままでよいので false。
 *
 * **固有名詞は元に戻せない**(`TOKYO` → `tokyo`)。ローカルの規則だけでは
 * 判別できないため、直した内容は必ず結果メッセージに出して片桐が確認できる
 * ようにしてある(添削側が拾えば「誤り」として理由付きで表示もされる)。
 */
function normalizeAllCaps(text, { asSentence }) {
  let s = (text || '').toLowerCase();
  if (asSentence) {
    // 文頭、および . ! ? の後の最初の英字を大文字に戻す。
    s = s.replace(/(^|[.!?]\s+)([a-z])/g, (m, head, ch) => head + ch.toUpperCase());
  }
  // 一人称の I は常に大文字。`\b` は `'` を語境界とみなすので、
  // i'm / i've / i'll / i'd もこの1行で直る。
  return s.replace(/\bi\b/g, 'I');
}

/**
 * 習熟用タブの「カードを生成する」(2026-08-06追加、Web版のみ)。
 *
 * 入力を行ごとに「文」と「単語・句動詞などの表現」に振り分ける
 * (`looksLikePhrase`)。
 *
 * - 文 … **文法的に正しいものだけ**をカードにする。判定は
 *   DailyConversationと同じ`correctEnglishText()`(=Googleフォーム経路の
 *   Apps Scriptと同じsystem_instruction)を使い回す——ここに独自の正誤判定を
 *   作ると3つ目の採点基準が生まれ、同じ文でも入口によって評価が食い違うため。
 * - 表現 … 正誤判定にかけず、その表現が使われる文法構成と、内容がそれぞれ
 *   別の例文3つを生成する(2026-08-06、片桐の要望で追加)。
 *
 * AI呼び出しは入力が何行あっても**最大3回**(正誤判定1回 + 文のカード生成1回
 * + 表現のカード生成1回。10件を超える場合はBATCH_SIZEごとに分かれる)。
 */
async function onShuujukuGenerate() {
  const status = $('shuujuku-generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.correctionSystemInstruction || !shared.correctionResponseSchema
    || !shared.shuujukuSentencePrompt || !shared.shuujukuPhrasePrompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }
  const text = $('shuujuku-input').value.trim();
  if (!text) {
    setStatus(status, '英文または単語・表現を入力してください。', true);
    return;
  }

  // 入力を行ごとに「表現(単語・句動詞など)」と「文」へ振り分ける。
  // 表現は正誤判定にかけない(文ではないので必ず「誤り」になってしまうため)。
  //
  // 振り分けの前に、全部大文字の行は通常の表記へ直しておく(2026-08-06)。
  // 添削へ送る前に直すことで、スペルが正しければ素直に「誤りなし」になる。
  // 振り分けの規則(looksLikePhrase)は大文字小文字に依存しないので、
  // 直す前後どちらで判定しても結果は同じ。
  const recased = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    if (!isAllUpperCase(line)) return line;
    const fixed = normalizeAllCaps(line, { asSentence: !looksLikePhrase(line) });
    recased.push({ from: line, to: fixed });
    return fixed;
  });
  const phrases = lines.filter(looksLikePhrase);
  const sentenceText = lines.filter((l) => !looksLikePhrase(l)).join('\n');

  const btn = $('shuujuku-generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';
  const items = [];
  let failed = 0;
  let ngRows = [];

  /** バッチの戻り値(生成できなかった件はnull)をストック用の形にして積む。 */
  const pushItems = (generated) => {
    for (const item of generated) {
      if (!item) {
        failed += 1;
        continue;
      }
      const generatedAt = new Date().toISOString();
      items.push({
        ...item, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt,
      });
    }
  };

  try {
    if (sentenceText) {
      showLoading(status, '英文が正しいか確認中...(数十秒かかることがあります)');
      // **consolidateNoErrorCorrections() は通さないこと。** あれは「誤りなし」の
      // 複数文を1行にまとめる(originalを改行で連結する)関数で、シートに
      // 1送信=1行として書き込むためのもの。ここで通すと、正しい文を3つ
      // 入力しても「3文が連結された1枚」のカードになってしまう。
      const corrections = await correctEnglishText({
        text: sentenceText,
        apiKey,
        model,
        systemInstruction: shared.correctionSystemInstruction,
        responseSchema: shared.correctionResponseSchema,
      });

      const okRows = corrections.filter((c) => c.category === '誤りなし');
      ngRows = corrections.filter((c) => c.category !== '誤りなし');

      if (okRows.length > 0) {
        showLoading(status, `カードを生成中... (英文 ${okRows.length} 件)`);
        // 添削が「誤りなし」と判断した文をそのまま使う(correctedは
        // 誤りなしの場合、原文と同じか整形しただけのもの)。
        const sentences = okRows.map((c) => (c.original || '').trim());
        pushItems(await generateShuujukuItemsFromSentences({
          sentences,
          apiKey,
          model,
          promptTemplate: shared.shuujukuSentencePrompt,
          onProgress: (done, total) => {
            if (total > done) showLoading(status, `カードを生成中... (英文 ${done}/${total} 件)`);
          },
        }));
      }
    }

    if (phrases.length > 0) {
      // 単語・句動詞は**まとめて1枚**にする(2026-08-06、片桐の想定に合わせて
      // 「1件=1枚」から変更)。例文の数が語句の数で変わる。
      showLoading(status, `カードを生成中... (単語・表現 ${phrases.length} 件をまとめて1枚)`);
      pushItems([await generateShuujukuItemFromPhrases({
        phrases,
        apiKey,
        model,
        promptTemplate: shared.shuujukuPhrasePrompt,
      })]);
    }

    if (items.length > 0) {
      shuujukuStock = shuujukuStock.concat(items);
      localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
      renderShuujukuStock();
    }

    hideLoading(status);
    // 全文が正しくカード化できたときだけ入力欄を消す。誤りがあった場合は、
    // どの文が弾かれたのか片桐が見比べられるよう残す(単語タブと同じ方針)。
    if (items.length > 0 && ngRows.length === 0 && failed === 0) $('shuujuku-input').value = '';

    const notes = [];
    if (items.length > 0) {
      // 「文」と「表現」のどちらとして扱ったかを必ず出す(2026-08-06)。
      // 振り分けはローカルの単純な規則(looksLikePhrase)なので取り違えは
      // 起こりうる。結果に出しておけば、意図と違えば片桐が気づいて
      // 文末に「.」を付けて出し直せる。
      const breakdown = [];
      if (phrases.length > 0) breakdown.push(`単語・表現 ${phrases.length} 件`);
      const sentenceCount = lines.length - phrases.length;
      if (sentenceCount > 0) breakdown.push(`英文 ${sentenceCount} 件`);
      notes.push(
        `${items.length} 件のカードを生成しました。`
        + (breakdown.length > 1 ? `(入力の内訳: ${breakdown.join(' / ')})` : ''),
      );
    }
    if (phrases.length > 0) {
      notes.push(
        `次の ${phrases.length} 件は「単語・表現」として扱い、正誤の添削はせずに`
        + `まとめて1枚のカードにしました(例文${phraseExampleCount(phrases.length)}つ):\n`
        + phrases.map((p) => `・${p}`).join('\n')
        + (phraseExamplesMayOmit(phrases.length)
          ? `\n⚠ 例文は最大${MAX_PHRASE_EXAMPLES}つまでのため、この件数だと`
            + '一部の表現が例文に出てこない可能性があります。'
            + '分けて実行すると確実です。'
          : '')
        + '\n(文として添削してほしいものが混ざっていた場合は、文末に「.」を付けて'
        + 'もう一度実行してください)',
      );
    }
    // 全部大文字だった行を、何をどう直したか分かる形で知らせる(2026-08-06)。
    // 固有名詞(TOKYO → tokyo)まではローカルの規則で戻せないので、
    // 直した結果を必ず見せて片桐が気づけるようにしておく。
    if (recased.length > 0) {
      notes.push(
        `次の ${recased.length} 件はすべて大文字だったため、表記を直してから`
        + 'カードを作りました:\n'
        + recased.map((r) => `・${r.from} → ${r.to}`).join('\n')
        + '\n(固有名詞の大文字までは復元できません。上の表記で正しいか確認してください)',
      );
    }
    // 1行に複数件を並べてしまった可能性がある行を知らせる(2026-08-06)。
    // 区切りは改行のみという方針なので、カンマ等で並べると本人の意図と違って
    // 1枚のカードにまとまってしまう。黙って作ると気づけないため必ず出す。
    const crowded = lines.filter(looksLikeMultipleEntries);
    if (crowded.length > 0) {
      notes.push(
        `⚠ 次の ${crowded.length} 行は、1行に複数の語句が並んでいるように見えます:\n`
        + crowded.map((l) => `・${l}`).join('\n')
        + '\n区切りは改行のみです。1行に1件ずつ改行して入力し直すと、'
        + 'それぞれ別のカードになります(いまは1件分としてまとめて作られています)。',
      );
    }
    if (ngRows.length > 0) {
      // 誤りのあった文はDailyConversationタブの入力欄へ転記しておく
      // (2026-08-06、片桐の指示)。あちらは元々「自分の誤りを記録する場所」
      // であり、打ち直し・コピペの手間を省くため。タブの自動切り替えまでは
      // しない(結果を読んでいる最中に画面が飛ぶのを避ける)。
      const transferred = transferToDailyInput(ngRows.map((c) => c.original || ''));
      notes.push(
        `文法的な誤りがあった ${ngRows.length} 件はカードにしませんでした:\n`
        + ngRows.map((c) => `・「${c.original}」 [${c.category}] ${c.explanation || ''}`).join('\n')
        + (transferred > 0
          ? `\nこの ${transferred} 件をDailyConversationタブの入力欄に転記しました。`
            + 'そちらで添削・記録すると、習熟用カードもあらためて作られます。'
          : '\n誤りのある文は、DailyConversationタブで添削するとそちらからも'
            + '習熟用カードが作られます。'),
      );
    }
    if (failed > 0) notes.push(`${failed} 件はカードの生成に失敗しました。`);
    setStatus(
      status,
      (notes.join('\n') || 'カードを生成できませんでした。') + quotaSuffix(),
      items.length === 0,
    );
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 誤りのあった英文を DailyConversation タブの入力欄へ転記する
 * (2026-08-06追加。習熟用タブが弾いた文をそのまま添削へ回せるようにするため)。
 *
 * 既に入力されている内容は**消さずに追記**する(片桐が打ちかけの文を
 * 失わないため)。ログインは不要(テキストを入れるだけで、実際の添削・
 * シート追記は従来どおりDailyConversationタブ側の操作で行う)。
 *
 * 【二重転記を防ぐ2つの判定】(2026-08-06のレビュー指摘への対応)
 * 当初は「入力欄の現在の中身に同じ行があるか」だけで判定していたが、
 * それだけでは足りない:
 *  (1) 添削に成功すると`onDailyCorrect`が入力欄を空にするため、習熟用タブの
 *      入力欄に残った誤り文でもう一度生成すると、**同じ文が再び転記されて
 *      シートに重複行ができる**。→ `transferredToDaily`(このセッション中に
 *      転記した文の記録)で防ぐ。ページを再読み込みすれば消えるが、その時は
 *      両方の入力欄も空になっているので取りこぼしにはならない。
 *  (2) 行単位の比較では、「複数文を1行にまとめて入力」(このタブが明示的に
 *      認めている使い方)した中に同じ文が含まれていても検出できない。
 *      → 正規化した本文に対する部分一致で判定する。
 *
 * @returns {number} 実際に追記した件数(すべて転記済みなら0)
 */
const transferredToDaily = new Set();

/** 比較用の正規化(前後空白除去 + 空白の圧縮 + 小文字化)。
 *  dailyDuplicateOriginalIds() の原文の正規化と同じ考え方。 */
function normalizeForTransfer(text) {
  return (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function transferToDailyInput(sentences) {
  const el = $('daily-input');
  if (!el) return 0;
  const current = el.value.trim();
  const currentNormalized = normalizeForTransfer(current);
  const added = [];
  for (const raw of sentences) {
    const sentence = (raw || '').trim();
    if (!sentence) continue;
    const key = normalizeForTransfer(sentence);
    if (transferredToDaily.has(key)) continue;
    // 入力欄に(1行にまとめられた形も含めて)既にあるなら追記しない。
    // ただし「転記済み」としては記録し、以後も重ねて入れない。
    if (!currentNormalized.includes(key)) added.push(sentence);
    transferredToDaily.add(key);
  }
  if (added.length === 0) return 0;
  el.value = current ? `${current}\n${added.join('\n')}` : added.join('\n');
  return added.length;
}

/** source_topic をキーに、重複している要素の index を返す(表示用)。 */
function shuujukuDuplicateIndices() {
  const counts = new Map();
  shuujukuStock.forEach((item) => {
    const key = item.source_topic || '';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  shuujukuStock.forEach((item, i) => {
    if (counts.get(item.source_topic || '') > 1) dup.add(i);
  });
  return dup;
}

function renderShuujukuStock() {
  const list = $('shuujuku-stock-list');
  const dup = shuujukuDuplicateIndices();
  list.textContent = '';

  shuujukuStock.forEach((item, i) => {
    const li = buildStockRow({
      isDuplicate: dup.has(i),
      // rowId: フィルターは持たないが、onDeleteSelected()が全タブ共通で
      // ID方式の選択(checkedRowIdsOf)を使うため必要(2026-07-29)。
      // 2026-07-30: 複数端末間の同期(打ち消し記録)にも同じidを使うため、
      // 配列インデックスではなくitem.id(newSyncId()で採番)を使う。
      rowId: item.id,
      title: item.pattern || '(パターン未設定)',
      subtitle: item.meaning || '(意味なし)',
      meta: formatDateTime(item.generated_at),
      onPreview: () => showShuujukuPreview(item),
    });
    list.appendChild(li);
  });

  $('shuujuku-stock-empty').hidden = shuujukuStock.length > 0;
  $('shuujuku-stock-count').textContent = shuujukuStock.length ? `(${shuujukuStock.length} 件)` : '';
}

async function onExportShuujuku() {
  const status = $('shuujuku-export-status');
  if (rejectWhileExporting(status)) return;
  if (shuujukuStock.length === 0) {
    setStatus(status, '出力するカードがありません。', true);
    return;
  }
  const cardDef = shared.cardDefs?.shuujuku;
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  if (!beginApkgExport(status)) return;
  // **出力対象を開始時点で固定する(2026-08-06修正)。** 以前は生成後の
  // 後始末でも`shuujukuStock`(現在値)をそのまま使っていたが、習熟用ストックは
  // 「AIに質問」の4問目生成・DailyConversationの添削から**非同期に増える**。
  // TTS付きの生成は数分かかることがあるため、その間に増えた項目まで
  // 「出力済み」として消し、打ち消し記録にまで載せてしまう(=他の端末からも
  // 消える)データ消失の恐れがあった。出力したのはこのスナップショットだけ。
  const targets = shuujukuStock.slice();
  try {
    setStatus(status, '.apkg を生成中...');
    // Numフィールド・cards.dueは出力するたびに続き番号を採番する(desktop版の
    // shuujuku_stock.get_next_num()と同じ理由: Anki側のソートフィールド衝突を
    // 避けるため)。そのためbuildFieldsReadyItems()でフィールドを確定させて
    // から渡す(ストックの生itemはDeckTitle/Num/I1Badge等を持たない)。
    const startNum = getNextNum();
    // TTS APIキーが設定されていれば、例文ごとに音声を合成してContentに
    // 埋め込む(未設定なら従来どおり音声無し)。
    const { audioTagsByItem, media } = await embedShuujukuTtsAudio(targets, status);
    const readyItems = buildFieldsReadyItems(targets, startNum, audioTagsByItem);
    const blob = await buildApkg({ cardDef, ankiSchema: shared.ankiSchema, items: readyItems, media });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `shuujuku_${stamp}.apkg`);

    // apkgの生成に成功した時点で初めて続き番号を進め、出力済みの項目を
    // ストックから取り除く(desktop版のmark_exportedと同じ2段階設計。
    // 生成に失敗した場合はストックも番号も変化させない)。
    // 出力済みで消える項目のidは打ち消し記録に残す(2026-07-30、複数端末間の
    // 同期が「削除済み(出力済み)は復活させない」と判定できるようにするため)。
    addTombstoneIds(STORAGE.shuujukuTombstones, targets.map((item) => item.id));
    advanceNextNum(targets.length);
    // 出力中に増えた項目は残す(参照比較。ストックは常に同じオブジェクトを
    // 保持しているため、idを使わずSetでそのまま判定できる)。
    const exportedSet = new Set(targets);
    shuujukuStock = shuujukuStock.filter((item) => !exportedSet.has(item));
    localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
    renderShuujukuStock();

    setStatus(
      status,
      `${targets.length} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。`,
    );
  } catch (e) {
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
  } finally {
    endApkgExport();
  }
}

/**
 * 習熟用アイテムのプレビュー(実際に出力される次の番号を仮に使ってレンダリング
 * する。出力前のitemはDeckTitle/Num/I1Badge等を持たないため、他タブのshowPreview()を
 * そのまま使えない)。
 */
function showShuujukuPreview(item) {
  const def = shared.cardDefs?.shuujuku;
  if (!def) {
    alert('カード定義の読み込みが完了していません。');
    return;
  }
  const previewNum = getNextNum();
  // フィールド確定済みitem(item_keyがキー)を、テンプレート差し込み用に
  // Ankiフィールド名がキーの形へ詰め替える(fieldsFromItem()と同じ対応表)。
  const ready = buildFieldsReadyItem(previewNum, item);
  const values = {};
  def.fields.forEach((f) => { values[f.anki_name] = ready[f.item_key] ?? ''; });
  const tmpl = def.anki_model.tmpls[0];
  const front = renderTemplate(tmpl.qfmt, values);
  const back = renderTemplate(tmpl.afmt, values, front);

  $('preview-title').textContent = `プレビュー: ${item.pattern || '(パターン未設定)'}`;
  $('preview-frame').srcdoc = buildPreviewDoc(def.anki_model.css, front, back);
  $('preview-dialog').showModal();
}

// ---------------------------------------------------------------------------
// DailyConversationタブ(「添削結果」スプレッドシート連携)
//
// 【他のタブと根本的に違う点】
// 候補の実体がローカルのストック(localStorage)ではなく**スプレッドシート
// そのもの**(「Anki出力済み」列が空の行)。そのため一覧はローカルに複製せず、
// 押されるたびにシートから取り直す。ローカルに持つのは「一覧から除外した
// 行ID」だけ(dailyconv.js)。デスクトップ版のDailyConversationタブと同じ方針。
// ---------------------------------------------------------------------------

function sheetsConfig() {
  return {
    clientId: $('google-client-id').value.trim(),
    workerUrl: $('oauth-worker-url').value.trim(),
    spreadsheetId: $('sheets-spreadsheet-id').value.trim(),
    sheetName: $('sheets-sheet-name').value.trim(),
  };
}

// ---------------------------------------------------------------------------
// Worker からの設定の受け取り(2026-08-05追加)
//
// APIキー・スプレッドシートIDを端末ごとに手入力する手間をなくすため、
// これらは Worker のシークレットに集約し、ログイン後に受け取る。
// 詳細は worker/src/index.js の GET /appconfig と DEFAULT_OAUTH_WORKER_URL の
// 説明を参照。
// ---------------------------------------------------------------------------

/**
 * このページを開いてから /appconfig を取りに行って**成功**したか。
 * 毎回の操作のたびに問い合わせると無駄なので、成功したら以後は問い合わせない。
 */
let appConfigLoaded = false;

/**
 * 直近の /appconfig が失敗したか(2026-08-19追加)。
 *
 * **失敗しても`appConfigLoaded`は立てないこと。** 以前は失敗時にも立てて
 * いたため、起動直後の1回が失敗すると、そのページを開いている間は
 * 「🔄 同期」を押しても DailyConversation を使っても**二度と取りに
 * 行かなくなっていた**(=再ログインしても設定が入ってこない)。
 * 自動実行(起動時の読み込み)だけがこのフラグを見て遠慮し、片桐が自分で
 * 押した操作からは何度でも試せるようにする。
 */
let appConfigFailed = false;

/** Workerから受け取った設定を入力欄とlocalStorageへ反映する。 */
function applyRemoteAppConfig(config) {
  const applied = [];
  const assign = (value, elId, storageKey, label) => {
    // **null / 空文字の項目は反映しない。** Worker 側で未登録の項目まで
    // 上書きすると、端末で手入力した値を消してしまう。
    const v = String(value ?? '').trim();
    if (!v) return;
    if ($(elId).value.trim() === v) return; // 既に同じ値なら触らない
    $(elId).value = v;
    localStorage.setItem(storageKey, v);
    applied.push(label);
  };

  assign(config.spreadsheet_id, 'sheets-spreadsheet-id', STORAGE.spreadsheetId, 'スプレッドシートID');
  assign(config.sheet_name, 'sheets-sheet-name', STORAGE.sheetName, 'シート名');
  assign(config.gemini_api_key, 'api-key', STORAGE.apiKey, 'Gemini APIキー');
  assign(config.tts_api_key, 'tts-api-key', STORAGE.ttsApiKey, 'Cloud TTS APIキー');
  return applied;
}

/**
 * Workerから設定を受け取って反映する(成功したらそのページでは1回だけ)。
 *
 * **失敗してもアプリは止めない**。Workerが落ちている・まだシークレットを
 * 登録していないといった場合でも、端末に手入力済みの値があればそのまま
 * 使えるべきなので、例外にはせず戻り値を空にするだけにする。
 *
 * **ただし黙って諦めないこと(2026-08-19修正)。** 以前は console.warn だけで
 * 画面には何も出さなかったため、新しい端末では「ログインしたのに設定が
 * 入ってこない、理由も分からない」という手詰まりになっていた
 * (実際にスマホのChromeで報告された)。原因はどれも端末側で対処できるもの
 * ——別のGoogleアカウントでログインした / 同意画面でチェックを入れ損ねた /
 * Workerに繋がらない——なので、必ず通知バナー(と⚙設定のログ)に出す。
 *
 * @param {string} accessTokenValue ログイン済みのアクセストークン
 * @param {{auto?: boolean}} [options] auto=true は起動時の自動読み込みからの
 *   呼び出し。失敗済みなら再試行しない(片桐が押した操作からは毎回試す)。
 * @returns {Promise<string[]>} 実際に反映した項目名(何も無ければ空配列)
 */
async function ensureAppConfigLoaded(accessTokenValue, { auto = false } = {}) {
  if (appConfigLoaded) return [];
  if (auto && appConfigFailed) return [];
  const { workerUrl } = sheetsConfig();
  if (!workerUrl || !accessTokenValue) return [];
  try {
    const config = await fetchAppConfig(workerUrl, accessTokenValue);
    appConfigLoaded = true;
    appConfigFailed = false;
    return applyRemoteAppConfig(config || {});
  } catch (e) {
    appConfigFailed = true;
    console.warn('[appconfig] 設定を取得できませんでした:', e.message);
    setStatus($('header-auth-status'), appConfigErrorMessage(e), true);
    return [];
  }
}

/**
 * /appconfig の失敗を、片桐がその場で対処できる文言にする。
 *
 * Worker が返す文言だけだと「で、何をすればいいのか」が分からないため、
 * この端末で確かめられることを添える。403 を特に手厚くしているのは、
 * スマホでは**Chromeの既定アカウントがPCと違う**ことが多く、同意画面が
 * 別アカウントのまま進んでしまうのが一番ありがちなため
 * (Worker側は ALLOWED_EMAIL と一致しないトークンを拒否する)。
 */
function appConfigErrorMessage(e) {
  const base = `設定の自動読み込みに失敗しました: ${e.message}`;
  if (e?.status === 403) {
    return `${base}

次を確認してください:
・同意画面で選んだGoogleアカウントが、いつも使っているものと同じか(スマホのChromeは既定のアカウントがPCと違うことがあります)。
・同意画面のチェックボックスをすべてオンにしてから「続行」を押したか。
ヘッダーの「ログアウト」→「Googleにログイン」でやり直せます。`;
  }
  return `${base}

この端末に手入力済みの設定があればそのまま使えます。空のままの場合は、⚙ 設定 で直接入力するか、しばらく後に「🔄 同期」でやり直してください。`;
}

/**
 * ログイン維持用 Worker を使う設定になっているか(2026-08-05追加)。
 *
 * true … 認可コードフロー + リフレッシュトークン。ログインが長持ちする。
 *        クライアントIDは Worker から受け取るのでアプリ側の設定は不要。
 * false … 従来の GIS token client。約1時間で切れるかわりに Worker が要らない。
 *        こちらはアプリ側にクライアントIDの設定が必要。
 */
function usesOauthWorker() {
  return Boolean(sheetsConfig().workerUrl);
}

/** ログインに必要な設定が揃っているか。足りなければ理由を返す(揃っていれば null)。 */
function missingAuthConfigMessage() {
  const { clientId, workerUrl } = sheetsConfig();
  if (workerUrl) return null;
  if (!clientId) {
    return 'OAuthクライアントID、またはログイン維持用WorkerのURLを設定してください'
      + '(⚙ 設定 → スプレッドシート)。';
  }
  return null;
}

/**
 * 設定漏れでエラーになったとき、実際に空になっている入力欄を返す
 * (2026-08-05、フォーカス先の取り違えを直すために切り出した)。
 *
 * この仕組み自体は「設定したはずなのにエラーになる」という報告
 * (プレースホルダーの薄い灰色の例文を、保存済みの値と見間違えていた可能性)を
 * 受けて、**本当に空かどうかを一目で確認してもらう**ために入れたもの。
 * それが空でない欄を指してしまっては目的と逆になるため、`missingAuthConfigMessage`
 * の分岐と対応する欄をここで正しく選ぶ。
 */
function firstEmptySheetsSettingField() {
  const { clientId, workerUrl, spreadsheetId } = sheetsConfig();
  // Worker URL とクライアントID はどちらか一方あればよい。両方空のときだけ
  // 「まず Worker URL(推奨方式)を」と案内する。
  if (!workerUrl && !clientId) return $('oauth-worker-url');
  if (!spreadsheetId) return $('sheets-spreadsheet-id');
  return null;
}

// 2026-08-06: ここにあったヘッダーの⋮メニュー(openHeaderMenu/
// closeHeaderMenu/onHeaderMenuToggle)は廃止した。2026-07-30に
// 「ログイン周りがごちゃごちゃしている」との指摘を受けて「設定」を
// 格納するために作ったものだが、状態表示とログをこの枠から追い出して
// ボタンが減り、幅に余裕ができたため「設定」をヘッダーへ直接戻した。
// 中身が1つだけのメニューはワンクッション増やすだけなので、まるごと撤去。

/**
 * ログイン状態の表示と、ヘッダーのログイン/ログアウトボタンの表示切り替えを
 * 現在の状態に合わせる。Googleログインの窓口はヘッダーの`header-signin`/
 * `header-signout`に一本化してある(2026-07-30。以前はDailyConversationタブの
 * 中だけにログインUIがあったが、⚙設定の「複数端末間の同期」でもログインが
 * 必要になったため、タブを開かなくてもログインできるようヘッダーへ移動し、
 * DailyConversationタブ側のログインUIは削除した)。状態管理はこの関数に
 * 一本化してあり、ログイン状態が変わりうる箇所(onHeaderSignIn/
 * onHeaderSignOut/requireSheetsAccess/onSyncNow等)は全てここを呼ぶだけでよい。
 *
 * ログイン/ログアウトは同時に片方しか意味を持たないため、常にどちらか
 * 一方だけを表示する(2026-07-30、ログイン後もログインボタンが残って
 * 冗長という指摘への対応。以前は両方常設し、ログイン済み時は
 * header-signinの文言を「別のアカウントでログイン」に変えるだけだった)。
 */
function updateGoogleAuthStatus() {
  // Worker方式ではリフレッシュトークンを持っていればログイン済み扱い
  // (アクセストークンが手元に無くても無操作で取り直せるため)。
  // **現在のWorker URLを渡すこと**(2026-08-05): 渡さないと、Worker URLを
  // 消した/変えた後に残っているリフレッシュトークンだけで「ログイン済み」と
  // 表示してしまい、実際は従来方式(B)へ落ちるため表示と挙動が食い違う。
  const signedIn = isSignedIn({ workerUrl: sheetsConfig().workerUrl });
  setStatus(
    $('header-auth-status'),
    signedIn
      ? (usesOauthWorker()
        ? 'Googleにログイン済みです(ページを閉じてもログインは保たれます)。'
        : 'Googleにログイン済みです(このページを閉じるか約1時間で失効します)。')
      : '未ログインです。DailyConversationタブ・複数端末間の同期を使うには、'
        + '上の「Googleにログイン」からログインしてください。',
  );
  $('header-signin').hidden = signedIn;
  $('header-signout').hidden = !signedIn;
  $('header-signout').disabled = !signedIn;
}

async function onHeaderSignIn() {
  const status = $('header-auth-status');
  const missing = missingAuthConfigMessage();
  if (missing) {
    setStatus(status, missing, true);
    return;
  }
  const btn = $('header-signin');
  btn.disabled = true;
  try {
    const { clientId, workerUrl } = sheetsConfig();
    if (workerUrl) {
      // (A) Googleの同意画面へページ遷移する。ここから先は戻ってこない
      //     (戻りは init() の completeAuthCodeFlowIfReturning() が受ける)。
      //     遷移でページが作り直されるため、入力途中の内容を待避しておく。
      showLoading(status, 'Googleの同意画面へ移動しています...');
      saveStateBeforeAuthRedirect();
      await beginAuthCodeFlow(workerUrl);
      return;
    }
    // (B) 従来方式。ログイン済みの状態で押した場合は「アカウントを選び直したい」
    //     とみなして同意画面を明示的に出す(ここは workerUrl が空の分岐なので
    //     リフレッシュトークンは判定に使わない = 同じ引数を渡しておく)。
    const forceConsent = isSignedIn({ workerUrl });
    showLoading(status, 'Googleログインを待っています...');
    await getAccessToken({ clientId, forceConsent });
    updateGoogleAuthStatus();
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function onHeaderSignOut() {
  // 保存済みのリフレッシュトークンごと破棄する(Google側の同意は取り消さない
  // ため、次回のログインは同意画面を通るだけで済む)。
  signOut();
  // 設定の読み込み状態も忘れる(2026-08-19追加)。別アカウントで入り直した
  // ときに、前のアカウントでの成功/失敗を引きずって取りに行かないのを防ぐ。
  appConfigLoaded = false;
  appConfigFailed = false;
  updateGoogleAuthStatus();
}

// ---------------------------------------------------------------------------
// 認可コードフローのページ遷移をまたぐ状態の待避(2026-08-05追加)
//
// Worker方式のログインはGoogleの同意画面へ**ページごと遷移**するため、
// 戻ってきたときにはページが作り直されている。ストック類はlocalStorageに
// あるので失われないが、「今開いているタブ」と「DailyConversationタブに
// 入力途中だった英文」は揮発してしまうため、sessionStorageへ待避しておく。
// ---------------------------------------------------------------------------

const AUTH_REDIRECT_STATE_KEY = 'anki_tool_auth_redirect_state';

function saveStateBeforeAuthRedirect() {
  try {
    sessionStorage.setItem(AUTH_REDIRECT_STATE_KEY, JSON.stringify({
      tab: document.querySelector('.tab-btn.active')?.dataset.tab || null,
      dailyInput: $('daily-input').value || '',
    }));
  } catch {
    /* sessionStorage が使えない環境では待避を諦める(ログイン自体は続行) */
  }
}

function restoreStateAfterAuthRedirect() {
  let saved = null;
  try {
    const raw = sessionStorage.getItem(AUTH_REDIRECT_STATE_KEY);
    sessionStorage.removeItem(AUTH_REDIRECT_STATE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!saved) return;
  if (saved.tab) switchTab(saved.tab);
  if (saved.dailyInput) $('daily-input').value = saved.dailyInput;
}

// ---------------------------------------------------------------------------
// 複数端末間の同期(2026-07-30追加)
//
// 単語/AIに質問/習熟用の3ストックを、「添削結果」スプレッドシート内の隠しタブ
// (_AppSync、docs/lib/sheets.js参照)経由でPC・スマホ間で同期する。
// DailyConversationタブと同じGoogleログイン(spreadsheetsスコープ)をそのまま
// 流用しており、追加のOAuth同意は不要。
//
// 「後勝ちの丸ごと上書き」ではなく、id単位の和集合マージ(docs/lib/sync.js の
// mergeStock)にしてある: 追加は基本的にデータを失わず、削除は打ち消し記録
// (tombstone)で伝播させる。詳細・トレードオフはsync.jsの説明を参照。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 好みの設定の同期(2026-08-05追加)
//
// APIキー・スプレッドシートIDは Worker が配るが(ensureAppConfigLoaded)、
// 「Geminiのモデル名」「TTSの音声・言語・音量ゲイン」のような**利用者が画面上で
// 調整する設定**は、Workerのシークレットに入れると変更のたびに再デプロイが
// 必要になってしまう。これらはストックと同じ `_AppSync` タブで同期する
// (秘密ではないので、あのシートに置いても問題ない)。
// ---------------------------------------------------------------------------

/** 同期する設定項目(入力欄のID → localStorageキー)。 */
const SYNCED_SETTING_FIELDS = [
  { el: 'model', key: STORAGE.model, type: 'text' },
  { el: 'tts-voice', key: STORAGE.ttsVoice, type: 'text' },
  { el: 'tts-lang', key: STORAGE.ttsLang, type: 'text' },
  { el: 'tts-volume-gain', key: STORAGE.ttsVolumeGainDb, type: 'text' },
  { el: 'tts-exclude-japanese', key: STORAGE.ttsExcludeJapanese, type: 'checkbox' },
];

/** 設定を最後に変更した時刻(ISO文字列)。どちらが新しいかの判定に使う。 */
const SETTINGS_UPDATED_AT_KEY = 'anki_tool_settings_updated_at';

/** 現在の設定値を集めて、同期用のJSON文字列にする。 */
function collectLocalSettings() {
  const values = {};
  for (const f of SYNCED_SETTING_FIELDS) {
    values[f.el] = f.type === 'checkbox' ? $(f.el).checked : $(f.el).value.trim();
  }
  return JSON.stringify({
    updated_at: localStorage.getItem(SETTINGS_UPDATED_AT_KEY) || '',
    values,
  });
}

/** 設定を変更したことを記録する(同期時にどちらが新しいかの判定に使う)。 */
function markSettingsChanged() {
  localStorage.setItem(SETTINGS_UPDATED_AT_KEY, new Date().toISOString());
}

/**
 * リモートの設定がこの端末より新しければ取り込む。
 *
 * ストックと違い**項目ごとのマージはしない**(まとめて新しい方を採用する)。
 * 設定は数個の独立した値で、片桐が1人で順番に端末を使う前提なら、
 * 複雑なマージに見合う利点が無いため。
 *
 * @returns {boolean} リモートの内容を取り込んだか
 */
function mergeRemoteSettings(remoteJson) {
  if (!remoteJson) return false;
  let remote;
  try {
    remote = JSON.parse(remoteJson);
  } catch {
    return false;
  }
  if (!remote?.values) return false;

  const localAt = localStorage.getItem(SETTINGS_UPDATED_AT_KEY) || '';
  const remoteAt = remote.updated_at || '';
  // 同着(どちらも未設定)ならローカルを優先する = 何もしない。
  if (!remoteAt || remoteAt <= localAt) return false;

  for (const f of SYNCED_SETTING_FIELDS) {
    if (!(f.el in remote.values)) continue;
    const v = remote.values[f.el];
    if (f.type === 'checkbox') {
      $(f.el).checked = Boolean(v);
      localStorage.setItem(f.key, v ? '1' : '0');
    } else {
      const s = String(v ?? '').trim();
      if (!s) continue; // 空で上書きしない
      // モデル欄は <select> なので、候補に無い値はそのまま代入しても入らない
      // (空文字になる)。先に候補へ足しておくこと(2026-08-06)。
      ensureModelOption(f.el === 'model' ? s : '');
      $(f.el).value = s;
      localStorage.setItem(f.key, s);
    }
  }
  localStorage.setItem(SETTINGS_UPDATED_AT_KEY, remoteAt);
  return true;
}

/** 同期対象の3ストックの設定(タブキー→ローカル変数・保存先・描画関数)。 */
function syncSpecs() {
  return [
    {
      label: '単語', itemsKey: 'word_stock_items', tombKey: 'word_stock_tombstones',
      tombStorage: STORAGE.wordTombstones,
      get: () => wordStock,
      set: (v) => { wordStock = v; localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock)); },
      render: renderWordStock,
    },
    {
      label: 'AIに質問', itemsKey: 'ai_ask_stock_items', tombKey: 'ai_ask_stock_tombstones',
      tombStorage: STORAGE.aiAskTombstones,
      get: () => aiAskStock,
      set: (v) => { aiAskStock = v; localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock)); },
      render: renderAiAskStock,
    },
    {
      label: '習熟用', itemsKey: 'shuujuku_stock_items', tombKey: 'shuujuku_stock_tombstones',
      tombStorage: STORAGE.shuujukuTombstones,
      get: () => shuujukuStock,
      set: (v) => { shuujukuStock = v; localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock)); },
      render: renderShuujukuStock,
    },
  ];
}

/**
 * 「🔄 同期」の実処理。読み込み→マージ→ローカル反映→書き戻しを1回の操作で
 * 行う(pull-merge-pushを毎回まとめて行うことで、書き込みレースの窓を
 * 小さくする。真の同時書き込みは片桐一人が順番に端末を使う想定では
 * ほぼ起きない前提)。⚙設定内のボタン(`sync-now`)とヘッダーのボタン
 * (`header-sync-now`、2026-07-30追加。設定を開かなくても同期できるように
 * するため)の両方から呼ばれるため、状態表示先・disabledにするボタン要素を
 * 引数で受け取れるようにしてある。
 */
/**
 * シートから読んだ内容(`readSyncState`の戻り値)を3ストックへマージし、
 * ローカルへ反映・再描画する。**書き戻しは行わない**。
 *
 * `runSync`(pull-merge-push)と`autoPullOnStartup`(pullのみ)の共通部分として
 * 2026-08-05に切り出した。戻り値の`newState`は`writeSyncState`にそのまま
 * 渡せる形で、pullのみの経路では単に使わない。
 *
 * @returns {{newState: Record<string,string>, capacityLines: string[],
 *            overLimit: string[], nearLimit: string[], added: number}}
 *   `added` はマージによって増えた項目数(pullのみの経路で「何件取り込んだか」を
 *   知らせるために使う)。
 */
function mergeRemoteIntoLocal(remote) {
  const newState = {};
  const capacityLines = [];
  const overLimit = [];
  const nearLimit = [];
  let added = 0;

  // 好みの設定(Geminiモデル・TTS音声等)。ストックより先に処理して、
  // 取り込んだ場合はその値を書き戻し用のstateにも反映させる。
  const settingsChanged = mergeRemoteSettings(remote.app_settings);
  newState.app_settings = collectLocalSettings();

  for (const spec of syncSpecs()) {
    const remoteItems = parseIdArray(remote[spec.itemsKey]);
    const remoteTombstoneIds = parseIdArray(remote[spec.tombKey]);
    const localTombstoneIds = loadTombstoneIds(spec.tombStorage);

    const before = spec.get().length;
    const merged = mergeStock(spec.get(), remoteItems, localTombstoneIds, remoteTombstoneIds);
    added += Math.max(0, merged.items.length - before);
    spec.set(merged.items);
    saveTombstoneIds(spec.tombStorage, merged.tombstoneIds);
    spec.render();

    const itemsJson = JSON.stringify(merged.items);
    const tombJson = JSON.stringify(merged.tombstoneIds);
    newState[spec.itemsKey] = itemsJson;
    newState[spec.tombKey] = tombJson;
    const percent = Math.max(capacityPercent(itemsJson), capacityPercent(tombJson));
    capacityLines.push(`${spec.label} ${percent}%`);
    if (exceedsSyncLimit(itemsJson) || exceedsSyncLimit(tombJson)) overLimit.push(spec.label);
    else if (percent >= CAPACITY_WARN_PERCENT) nearLimit.push(`${spec.label} ${percent}%`);
  }

  return { newState, capacityLines, overLimit, nearLimit, added, settingsChanged };
}

/**
 * 起動時に、シートの内容を**読み込むだけ**の同期を行う(2026-08-05追加)。
 *
 * 【なぜ pull だけなのか】
 * 同期は手動ボタンのみだったため、押し忘れると「古い状態の端末で作業を
 * 始めてしまう」という、衝突のいちばんの原因が残っていた。起動時に自動で
 * 取り込むだけでこの事故はほぼ消える。
 * 一方で**書き戻し(push)は自動化しない**: 利用者が何も操作していないのに
 * この端末の内容でシートを上書きすることになり、意図しない伝播
 * (例: 別端末で追加された直後に、古い端末を開いただけで巻き戻る)が
 * 起きうるため。マージ自体は和集合なので pull だけでもデータは失われない。
 *
 * 【非ブロッキング】
 * 未ログイン・設定未入力・通信失敗のいずれでも、静かに諦めてアプリの起動を
 * 続ける(ログインが要らないタブは使えるため)。実際に取り込めたときだけ
 * ヘッダーに件数を出す。
 */
async function autoPullOnStartup() {
  if (!$('sync-auto-pull').checked) return;

  const cfg = sheetsConfig();
  // 設定が揃っていない・未ログインなら何もしない(起動時に勝手にログインの
  // ポップアップやページ遷移を起こさないため)。スプレッドシートIDの有無は
  // ここでは見ない——Workerの/appconfigから配られるので、ログイン後に判定する。
  if (missingAuthConfigMessage()) return;
  if (!isSignedIn({ workerUrl: cfg.workerUrl })) return;

  const statusEl = $('header-sync-status');
  try {
    showLoading(statusEl, '他の端末の変更を確認中...');
    const accessToken = await getAccessToken(cfg);
    // 新しい端末では、ここで初めてスプレッドシートIDやAPIキーが手に入る。
    // auto=true: ここで失敗しても、あとは片桐が押す「🔄 同期」に任せる
    // (起動のたびに同じ失敗で待たされないため)。
    const appliedSettings = await ensureAppConfigLoaded(accessToken, { auto: true });
    const spreadsheetId = sheetsConfig().spreadsheetId;
    if (!spreadsheetId) {
      hideLoading(statusEl);
      setStatus(statusEl, '');
      return;
    }

    const remote = await readSyncState({ spreadsheetId, accessToken });
    const { added } = mergeRemoteIntoLocal(remote);
    hideLoading(statusEl);
    if (appliedSettings.length > 0) {
      // 新しい端末での初回。何が自動設定されたのかを伝える(APIキーの値
      // そのものは出さず、項目名だけ)。
      setStatus(
        statusEl,
        `設定を自動で読み込みました(${appliedSettings.join('・')})。`
        + (added > 0 ? `カードも ${added} 件取り込みました。` : ''),
      );
    } else if (added > 0) {
      setStatus(statusEl, `他の端末の変更を ${added} 件取り込みました。`);
    } else {
      // 変更が無かった場合は黙っておく(毎回の起動でメッセージが出ると
      // ノイズになるため)。
      setStatus(statusEl, '');
    }
  } catch (e) {
    hideLoading(statusEl);
    // 起動を妨げない。理由だけ出して、あとは手動の「🔄 同期」に任せる。
    setStatus(statusEl, `起動時の自動読み込みに失敗しました: ${e.message}`, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
  }
}

async function runSync(statusEl, btnEl) {
  const missingAuth = missingAuthConfigMessage();
  if (missingAuth) {
    setStatus(statusEl, missingAuth, true);
    $('settings').hidden = false;
    const emptyField = firstEmptySheetsSettingField();
    if (emptyField) {
      emptyField.scrollIntoView({ block: 'center' });
      emptyField.focus();
    }
    return;
  }

  btnEl.disabled = true;
  try {
    showLoading(statusEl, 'Googleにログイン中...');
    const accessToken = await getAccessToken(sheetsConfig());
    // スプレッドシートIDはWorkerの/appconfigから配られるため、ログイン後に
    // 受け取ってから有無を判定する(2026-08-05に順序を変更)。
    await ensureAppConfigLoaded(accessToken);
    updateGoogleAuthStatus();

    const { spreadsheetId } = sheetsConfig();
    if (!spreadsheetId) {
      hideLoading(statusEl);
      setStatus(
        statusEl,
        'スプレッドシートIDが設定されていません。\n'
        + '通常はログイン後にWorkerから自動で配られます。空のままの場合は、'
        + 'Workerに SPREADSHEET_ID が登録されているか確認するか、'
        + '下の欄に直接入力してください(⚙ 設定 → スプレッドシート)。',
        true,
      );
      // 実際に空かどうかを目で確かめてもらう(2026-07-30追加。「設定したはず
      // なのにこのエラーになる」という報告を受けての対応。プレースホルダーの
      // 例文(灰色の薄い文字)を保存済みの値と見間違えているケースもあるため)。
      $('settings').hidden = false;
      $('sheets-spreadsheet-id').scrollIntoView({ block: 'center' });
      $('sheets-spreadsheet-id').focus();
      return;
    }

    showLoading(statusEl, '同期データを読み込み中...');
    const remote = await readSyncState({ spreadsheetId, accessToken });

    const { newState, capacityLines, overLimit, nearLimit } = mergeRemoteIntoLocal(remote);

    // 保存できる上限(SYNC_VALUE_LIMIT。1キーを複数セルに分割して保存する)を
    // 超えていたら、書き込む前に中断する
    // (2026-08-05追加)。そのまま送るとSheets APIが素の400を返し、どの
    // ストックが原因かも分からないまま同期が丸ごと止まってしまう。
    // ここまでのマージ結果はローカルには反映済みなので、リモートの内容が
    // 取り込めていないわけではない(書き戻しだけができていない)。
    if (overLimit.length > 0) {
      hideLoading(statusEl);
      setStatus(
        statusEl,
        `${overLimit.join('・')}のデータが保存できる上限(${SYNC_VALUE_LIMIT.toLocaleString()}文字)を`
        + '超えたため、シートへの書き戻しを中止しました。\n'
        + '(リモートの内容の取り込みは完了しています。この端末のデータは失われていません)\n\n'
        + '各タブの「出力済みのカードを削除」で、Ankiへ取り込み済みのカードを整理してから'
        + 'もう一度同期してください。',
        true,
      );
      return;
    }

    showLoading(statusEl, 'シートへ書き込み中...');
    await writeSyncState({ spreadsheetId, accessToken, state: newState });

    hideLoading(statusEl);
    setStatus(
      statusEl,
      `同期しました。(セル容量使用率: ${capacityLines.join(' / ')})`
      + (nearLimit.length > 0
        ? `\n⚠ ${nearLimit.join('・')} が上限に近づいています。`
          + '「出力済みのカードを削除」でAnkiへ取り込み済みのカードを整理することを推奨します。'
        : ''),
      nearLimit.length > 0,
    );
  } catch (e) {
    hideLoading(statusEl);
    setStatus(statusEl, e.message, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
  } finally {
    btnEl.disabled = false;
  }
}

async function onSyncNow() {
  await runSync($('sync-status'), $('sync-now'));
}

/** ヘッダーの「🔄 同期」ボタン(2026-07-30追加)。 */
async function onHeaderSyncNow() {
  await runSync($('header-sync-status'), $('header-sync-now'));
}

// ---------------------------------------------------------------------------
// バックアップ(書き出し / 読み込み、2026-08-05追加)
//
// 【なぜ必要か】
// デスクトップ版はapkg生成のたびに`backup/`へ自動保存するが、Web版は
// `downloadBlob()`がブラウザのダウンロード機構を呼ぶだけで、アプリ側は
// 生成物を一切保持していない(File System Access APIによる保存先固定は
// モバイルでの対応状況が不安定なため見送られている)。つまり**ストックの
// 項目こそが「Ankiに取り込む前の内容」を再現できる唯一のコピー**であり、
// 「出力済みのカードを削除」やブラウザのデータ削除で失うと復元できない。
// この非対称性を埋めるための、依存を増やさない最小の手当て。
//
// 【複数端末間の同期との違い】
// 同期はシート上の1セット(=最新の状態)しか持たないため、誤って削除した
// 内容は同期しても戻ってこない(むしろ削除が他端末へ伝播する)。
// バックアップは「その時点のスナップショットをファイルとして手元に残す」
// もので、役割が違う。
// ---------------------------------------------------------------------------

/** バックアップファイルの形式。将来の変更に備えて版番号を持たせる。 */
const BACKUP_FORMAT_VERSION = 1;

function onBackupExport() {
  const status = $('backup-status');
  const specs = syncSpecs();
  const stocks = {};
  for (const spec of specs) stocks[spec.itemsKey] = spec.get();

  const total = specs.reduce((n, spec) => n + spec.get().length, 0);
  if (total === 0) {
    setStatus(status, '書き出すカードがありません。', true);
    return;
  }

  const backup = {
    format: 'anki-tool-backup',
    version: BACKUP_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    stocks,
    // 習熟用の続き番号(Num)は、復元後に既存カードと番号が衝突しないよう
    // 一緒に残しておく(復元時は大きい方を採用する)。
    shuujuku_next_num: getNextNum(),
    // 新規カードの位置(cards.due)の続き番号も同じ理由で残す
    // (2026-08-20追加。dueCounter.js の項を参照)。
    next_due: Object.fromEntries(DUE_COUNTER_KEYS.map((k) => [k, getNextDue(k)])),
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(blob, `anki_tool_backup_${stamp}.json`);
  setStatus(
    status,
    `${total} 件を書き出しました(${specs.map((s) => `${s.label} ${s.get().length}`).join(' / ')})。`,
  );
}

async function onBackupFileSelected(event) {
  const status = $('backup-status');
  const input = event.target;
  const file = input.files?.[0];
  // 同じファイルを続けて選び直せるよう、必ず値をクリアしておく
  // (input[type=file] は同じ値の再選択では change が起きない)。
  input.value = '';
  if (!file) return;

  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (e) {
    setStatus(status, `ファイルを読み込めませんでした(JSONとして解釈できません): ${e.message}`, true);
    return;
  }
  if (backup?.format !== 'anki-tool-backup' || !backup.stocks) {
    setStatus(
      status,
      'このツールのバックアップファイルではないようです'
      + '(「バックアップを書き出す」で作った .json を選んでください)。',
      true,
    );
    return;
  }

  const specs = syncSpecs();
  const counts = specs.map((spec) => (backup.stocks[spec.itemsKey] || []).length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    setStatus(status, 'このファイルにはカードが入っていません。', true);
    return;
  }
  if (!confirm(
    `${total} 件を現在の内容に追加します`
    + `(${specs.map((s, i) => `${s.label} ${counts[i]}`).join(' / ')})。\n\n`
    + '既存のカードは削除されません。よろしいですか？',
  )) return;

  let restored = 0;
  let resurrected = 0;
  for (const spec of specs) {
    const incoming = backup.stocks[spec.itemsKey];
    if (!Array.isArray(incoming) || incoming.length === 0) continue;

    // 削除済み(打ち消し記録にあるid)の項目は、**新しいidを振り直して**復元する。
    // 元のidのままだと mergeStock が打ち消し記録を見て除外してしまい、
    // 「バックアップから戻したのに復活しない」という一番困る挙動になる
    // (打ち消し記録から取り除く方式は、リモート側の記録が残っている限り
    //  次の同期でまた消えるため解決にならない)。新しいidにすれば他端末へも
    //  普通の新規追加として伝わる。同じ内容が二重に見えることはあるが、
    //  このアプリは元々「重複は常に追加して⚠表示し、手動で間引く」方針で
    //  統一されており、既存の重複検出UIでそのまま解消できる。
    const tombstoned = new Set(loadTombstoneIds(spec.tombStorage));
    const now = new Date().toISOString();
    const prepared = incoming.map((item) => {
      if (!item?.id || tombstoned.has(item.id)) {
        resurrected += 1;
        return { ...item, id: newSyncId(), updated_at: now };
      }
      return item;
    });

    // 既存の内容との突き合わせは通常のマージに任せる(同じidが両方にあれば
    // updated_at が新しい方を採用)。打ち消し記録は上で回避済みなので空で渡す。
    const before = spec.get().length;
    const merged = mergeStock(spec.get(), prepared, [], []);
    restored += Math.max(0, merged.items.length - before);
    spec.set(merged.items);
    spec.render();
  }

  // 習熟用の続き番号は、既存の値とバックアップの値の大きい方を採用する
  // (小さい方に戻すと、既にAnkiにあるカードとNumが衝突しうるため)。
  const backupNum = Number(backup.shuujuku_next_num) || 0;
  const gap = backupNum - getNextNum();
  if (gap > 0) advanceNextNum(gap);

  // 新規カードの位置の続き番号も同じ考え方で、大きい方を採用する
  // (小さい方に戻すと、既にAnkiへ取り込んだカードと位置が衝突するため)。
  // next_due は 2026-08-20 より前のバックアップには入っていない。
  for (const key of DUE_COUNTER_KEYS) {
    const fromBackup = Number(backup.next_due?.[key]) || 0;
    if (fromBackup > getNextDue(key)) setNextDue(key, fromBackup);
  }

  setStatus(
    status,
    `${restored} 件を復元しました。`
    + (resurrected > 0
      ? `(うち ${resurrected} 件は削除済みだったため、新しいカードとして復元しました)`
      : '')
    + '\n複数端末間の同期を使っている場合は、「🔄 今すぐ同期」で他の端末にも反映してください。',
  );
}

/**
 * シート操作に必要なアクセストークンを取得する。設定漏れは分かりやすい
 * メッセージにして投げ直す(呼び出し側は catch して status に出すだけでよい)。
 */
async function requireSheetsAccess() {
  const missingAuth = missingAuthConfigMessage();
  if (missingAuth) throw new SheetsAuthError(missingAuth);

  // **トークンの取得を先に行う**(2026-08-05に順序を変更)。スプレッドシートIDは
  // Workerの/appconfigから配られるようになったため、ログインより前に有無を
  // 判定すると、まだ受け取っていない初回だけ必ず失敗してしまう。
  const accessToken = await getAccessToken(sheetsConfig());
  await ensureAppConfigLoaded(accessToken);
  updateGoogleAuthStatus();

  const cfg = sheetsConfig(); // 設定の反映後に読み直す
  if (!cfg.spreadsheetId || !cfg.sheetName) {
    throw new SheetsAuthError(
      '⚙ 設定 → スプレッドシート で、スプレッドシートID・シート名を設定してください。\n'
      + '(通常はログイン後にWorkerから自動で配られます。空のままの場合は、'
      + 'Workerに SPREADSHEET_ID / SHEET_NAME が登録されているか確認してください)',
    );
  }
  return { ...cfg, accessToken };
}

/**
 * 「原文」が正規化(trim+空白圧縮+小文字化)して一致する行が複数ある場合、
 * それらの行IDの集合を返す(2026-07-29追加)。IDはuuid4で新規採番される
 * ため通常重複しない一方、Googleフォーム経由・直接入力経由で同じ英文が
 * 二重に投稿されてしまうケースがあり得る(CLAUDE.md参照)。判定は
 * フィルター適用前の全件に対して行う(表示を絞っても判定結果は変わらない
 * ようにするため)。
 */
function dailyDuplicateOriginalIds(rows) {
  const normalize = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const counts = new Map();
  rows.forEach((row) => {
    const key = normalize(row.original);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  rows.forEach((row) => {
    const key = normalize(row.original);
    if (key && counts.get(key) > 1) dup.add(row.id);
  });
  return dup;
}

/**
 * 「誤りなし」の行は③で除外されるため、一覧でもその旨を明示する。
 * 2026-07-29に、原文が重複している行の警告表示と、両方をチェックボックスで
 * 絞り込めるフィルター機能を追加した(フィルターは表示のみに影響し、
 * dailyPendingRows自体やシート側のデータは変更しない)。
 * 同日、3つ目のフィルターとして「出力済み(このブラウザで記録)を隠す」を
 * 追加した。シート側の「Anki出力済み」列マーク(③のチェックボックス)とは
 * 独立して、`.apkg`生成に成功した行を`dailyconv.addExportedIds()`で
 * ローカルに記録しており(`onDailyExport()`参照)、③のチェックボックスを
 * OFFにして出力した場合やシート書き込みが失敗した場合でも、この一覧上で
 * 「実は既に一度カード化した」行を見分けられるようにするための保険。
 */
function renderDailyPending() {
  const list = $('daily-pending-list');
  list.textContent = '';

  const duplicateIds = dailyDuplicateOriginalIds(dailyPendingRows);
  const exportedIds = dailyconv.loadExportedIds();
  const hideNoError = $('daily-filter-hide-no-error').checked;
  const onlyDuplicates = $('daily-filter-only-duplicates').checked;
  const hideExported = $('daily-filter-hide-exported').checked;

  const visibleRows = dailyPendingRows.filter((row) => {
    if (hideNoError && row.category === '誤りなし') return false;
    if (onlyDuplicates && !duplicateIds.has(row.id)) return false;
    if (hideExported && exportedIds.has(row.id)) return false;
    return true;
  });

  visibleRows.forEach((row) => {
    const noError = row.category === '誤りなし';
    const isDup = duplicateIds.has(row.id);
    const isExported = exportedIds.has(row.id);
    const tags = [];
    if (isDup) tags.push(' ⚠ 重複の可能性');
    if (noError) tags.push(' ⚠ 誤りなし(出力対象外)');
    if (isExported) tags.push({ text: ' ✓ 出力済み', kind: 'done' });
    const li = buildStockRow({
      isDuplicate: isDup || noError,
      tags,
      rowId: row.id,
      title: `[${row.category || 'カテゴリ未設定'}] ${(row.original || '').slice(0, 40)}`,
      subtitle: row.corrected || '(添削後なし)',
      // シートの「日時」列は "YYYY-MM-DD HH:MM:SS" 形式の文字列(sheets_writer /
      // sheets.js の nowString() と同じ形式)なので Date を経由せず秒を切り
      // 落とすだけでよい。
      meta: (row.created_at || '').slice(0, 16),
      onPreview: () => showDailyPreview(row),
    });
    list.appendChild(li);
  });

  const empty = $('daily-pending-empty');
  if (dailyPendingRows.length === 0) {
    // 「未出力の行がまだ無い/読み込んでいない」場合のメッセージは
    // 呼び出し元(refreshDailyPendingなど)が事前にtextContentへ設定した
    // ものをそのまま使う(ここでは上書きしない)。
    empty.hidden = false;
  } else if (visibleRows.length === 0) {
    empty.hidden = false;
    empty.textContent = 'フィルター条件に一致する行がありません。';
  } else {
    empty.hidden = true;
  }

  $('daily-pending-count').textContent = dailyPendingRows.length
    ? (visibleRows.length === dailyPendingRows.length
      ? `(${dailyPendingRows.length} 件)`
      : `(${visibleRows.length} / ${dailyPendingRows.length} 件表示)`)
    : '';
}

/**
 * シートから未出力行を取り直して一覧を更新する。
 * @param {HTMLElement|null} status 進捗を出す要素(null なら黙って更新する)
 * @returns {Promise<boolean>} 取得できたか
 */
async function refreshDailyPending(status) {
  const btn = $('daily-refresh');
  btn.disabled = true;
  try {
    if (status) showLoading(status, 'シートを読み込み中...');
    const cfg = await requireSheetsAccess();
    const rows = await fetchPendingRows(cfg);
    dailyPendingRows = dailyconv.filterOutExcluded(rows);
    // renderDailyPending()より先に設定すること。dailyPendingRowsが空の場合の
    // 既定メッセージであり、renderDailyPending()内でフィルター一致0件用の
    // メッセージに上書きされることがあるため、その判定より前に置く必要がある。
    $('daily-pending-empty').textContent = '未出力の行はありません。';
    renderDailyPending();

    if (status) {
      hideLoading(status);
      const excluded = rows.length - dailyPendingRows.length;
      setStatus(
        status,
        `未出力の行を ${dailyPendingRows.length} 件読み込みました。`
        + (excluded > 0 ? `(除外登録済みの ${excluded} 件は非表示)` : ''),
      );
    }
    return true;
  } catch (e) {
    if (status) {
      hideLoading(status);
      setStatus(status, e.message, true);
    }
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
    return false;
  } finally {
    btn.disabled = false;
  }
}

async function onDailyCorrect() {
  const status = $('daily-correct-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.correctionSystemInstruction || !shared.correctionResponseSchema) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }
  const text = $('daily-input').value.trim();
  if (!text) {
    setStatus(status, '添削する英文を入力してください。', true);
    return;
  }

  const btn = $('daily-correct');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';
  try {
    // 先にシートへの書き込み権限を確保しておく(添削だけ済んで書き込めない、
    // という無駄なAPI消費を避けるため)。
    const cfg = await requireSheetsAccess();

    showLoading(status, 'AIが添削中...(数十秒かかることがあります)');
    const corrections = consolidateNoErrorCorrections(await correctEnglishText({
      text,
      apiKey,
      model,
      systemInstruction: shared.correctionSystemInstruction,
      responseSchema: shared.correctionResponseSchema,
    }));

    showLoading(status, 'シートに追記中...');
    const newIds = await appendCorrectionRows({ ...cfg, corrections });

    hideLoading(status);
    // **入力欄は「今回シートへ送った分」だけを取り除く**(2026-08-06修正)。
    // 以前は無条件に空にしていたため、添削の待ち時間(数十秒)の間に習熟用タブが
    // 誤り文を転記していると、それごと消えてしまっていた(習熟用タブ側は
    // 「転記しました」と表示したまま)。転記は末尾への追記なので、送った分は
    // 先頭に残っている。判別できない形(片桐が待ち時間中に自分で編集した等)
    // なら、消さずにそのまま残す——勝手に消して入力を失わせるより安全。
    const inputEl = $('daily-input');
    const remaining = inputEl.value.trimStart();
    if (remaining.startsWith(text)) {
      inputEl.value = remaining.slice(text.length).replace(/^\s+/, '');
    }
    setStatus(status, `${newIds.length} 件をシートに追加しました。②の一覧を更新します...`);

    // デスクトップ版と同じく、追記に成功したらそのまま②の読み込みまで連鎖させる
    // (確認導線が上下バラバラになるのを避けるため)。
    await refreshDailyPending(null);

    // デスクトップ版の_generate_shuujuku_candidates_from_rowsと同じく、今回
    // シートに追記した行(「誤りなし」を除く)ごとに習熟用(音読)候補を自動生成
    // する(2026-07-29、片桐の指示で③(当時は④)の.apkgダウンロード時からこの
    // タイミングへ変更。デスクトップ版は直接入力→①への自動連鎖でこのタイミングに
    // 相当する挙動になっており、それに揃えた。「誤りなし」の行には
    // 抽出すべき「誤りの背景にある文法パターン」が無いため対象外)。
    const rowsForShuujuku = corrections
      .map((c, i) => ({
        id: newIds[i], original: c.original, corrected: c.corrected, explanation: c.explanation,
      }))
      .filter((_, i) => corrections[i].category !== '誤りなし');
    const shuujukuNote = await generateShuujukuCandidatesFromRows(rowsForShuujuku, status);

    setStatus(status, `${newIds.length} 件をシートに追加し、②の一覧を更新しました。${shuujukuNote}`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
  } finally {
    btn.disabled = false;
  }
}

function onDailyExcludeSelected() {
  // フィルターで表示行が絞られていると、位置ベースのcheckedIndicesOfでは
  // dailyPendingRowsのインデックスと一致しなくなるため、IDベースで選択項目を
  // 特定する(2026-07-29、フィルター機能の追加に伴う変更)。
  const rowIds = checkedRowIdsOf('daily-pending-list');
  if (rowIds.length === 0) {
    alert('除外する項目を選択してください。');
    return;
  }
  if (!confirm(
    `選択した ${rowIds.length} 件を一覧から除外します。\n`
    + '(スプレッドシート自体は変更されません。この端末でのみ非表示になります)',
  )) return;

  dailyconv.addExcludedIds(rowIds);
  const remove = new Set(rowIds);
  dailyPendingRows = dailyPendingRows.filter((r) => !remove.has(r.id));
  renderDailyPending();
}

function onDailyClearExclusions() {
  if (!confirm('一覧から除外した行の登録をすべて解除します。よろしいですか？')) return;
  dailyconv.clearExcludedIds();
  refreshDailyPending($('daily-export-status'));
}

/**
 * 「出力済み履歴をリセット」(2026-07-29追加)。ローカルの出力済み記録
 * (`dailyconv.loadExportedIds()`)だけを消す。シートの「Anki出力済み」列
 * には一切触れないため、シート側で既に出力済みマークされている行は
 * 引き続き②の一覧には出てこない(fetchPendingRowsが除外するため)。
 */
function onDailyResetExported() {
  if (dailyconv.loadExportedIds().size === 0) {
    alert('出力済みの記録がありません。');
    return;
  }
  if (!confirm(
    'このブラウザに記録した「出力済み」をすべてリセットします。\n'
    + '(スプレッドシートの「Anki出力済み」列には影響しません)',
  )) return;
  dailyconv.clearExportedIds();
  renderDailyPending();
}

/**
 * DailyConversationで新たにシートへ追記した行(「誤りなし」を除く)それぞれ
 * について、Gemini APIで習熟用(音読)候補を自動生成し習熟用ストックへ追加
 * する(デスクトップ版の`_generate_shuujuku_candidates_from_rows`に対応)。
 * `onDailyCorrect()`(①添削→シート追記の成功直後)から呼ぶ(2026-07-29、
 * 片桐の指示で③(当時は④)の.apkgダウンロード時からこのタイミングへ変更。
 * デスクトップ版は直接入力→①シートから読み込むへの自動連鎖でこのタイミングに相当する挙動に
 * なっており、それに揃えた。「AIに質問」タブの4問目生成(`onAiAskGenerate()`)が
 * 生成直後に習熟用ストックへ追加するのと同じ即時性)。
 * Gemini APIキー未設定なら黙ってスキップする。この処理の失敗はdaily側の
 * シート追記自体を無効にしない(非ブロッキング。onAiAskGenerateの4問目生成と
 * 同じ考え方)。重複していても常に追加する(shuujukuDuplicateIndices()が
 * source_topic基準で一覧に⚠表示する)。
 * @param {object[]} rows 今回シートへ追記した行({id, original, corrected,
 *   explanation}、「誤りなし」除外済み)
 * @param {HTMLElement} status 進捗表示先
 * @returns {Promise<string>} 呼び出し元のstatusメッセージに追記する短いメモ
 */
async function generateShuujukuCandidatesFromRows(rows, status) {
  const apiKey = $('api-key').value.trim();
  if (!apiKey || !shared.shuujukuDailyconvPrompt) return '';

  const model = $('model').value.trim() || 'gemini-2.0-flash';
  const items = [];
  let failed = 0;

  // 2026-08-06、1行ずつN回呼ぶ方式からまとめて呼ぶ方式に変更した
  // (無料枠の上限はリクエスト数で数えられるため)。
  showLoading(status, `習熟用(音読)候補を生成中... (${rows.length} 件)`);
  let generated;
  try {
    generated = await generateShuujukuItemsFromRows({
      rows,
      apiKey,
      model,
      promptTemplate: shared.shuujukuDailyconvPrompt,
      onProgress: (done, total) => {
        if (total > done) showLoading(status, `習熟用(音読)候補を生成中... (${done}/${total} 件)`);
      },
    });
  } catch (e) {
    // 非ブロッキング: ここでの失敗はシート追記自体を無効にしない。
    return `\n習熟用(音読)候補の生成に失敗しました: ${e.message}`;
  }

  generated.forEach((item) => {
    if (!item) {
      failed += 1;
      return;
    }
    const generatedAt = new Date().toISOString();
    items.push({ ...item, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt });
  });

  if (items.length > 0) {
    shuujukuStock = shuujukuStock.concat(items);
    localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
    renderShuujukuStock();
    return `\n習熟用(音読)ストックに ${items.length} 件追加しました(「習熟用(音読)」タブで確認できます)。`
      + (failed > 0 ? `(${failed} 件は生成に失敗しました)` : '');
  }
  if (failed === rows.length) {
    return `\n習熟用(音読)候補の生成はすべて失敗しました(${failed} 件)。`;
  }
  return '';
}

async function onDailyExport() {
  const status = $('daily-export-status');
  if (rejectWhileExporting(status)) return;
  if (dailyPendingRows.length === 0) {
    setStatus(status, '出力する行がありません。先に②でシートから読み込んでください。', true);
    return;
  }
  const cardDef = shared.cardDefs?.daily;
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  // 既にこのブラウザで出力した行を除く(2026-08-06追加)。
  //
  // 【なぜ必要か】以前はフィルターの状態に関わらず、読み込んだ行を毎回すべて
  // 出力していた。ところが「出力済み(このブラウザで記録)を隠す」は既定ONなので、
  // **一度出力して一覧から消えた行が、次の出力にも毎回入り、TTSも作り直される**
  // (Anki側はguidが同じなので上書き更新されるが、時間とAPI料金は毎回かかる)。
  // 画面の説明とも食い違っていたため、単語/AIに質問タブの`onExport`と同じ
  // 「まだ出力していないものだけ」に揃えた。もう一度出したい場合は
  // ②の「出力済みの印を外す」で戻せる。
  const exportedIds = dailyconv.loadExportedIds();
  const notExportedRows = dailyPendingRows.filter((row) => !exportedIds.has(row.id));
  if (notExportedRows.length === 0) {
    setStatus(
      status,
      '出力していない行がありません(読み込んだ行はすべて出力済みです)。\n'
      + 'もう一度出力したい場合は、②の「出力済みの印を外す」を押してください。',
      true,
    );
    return;
  }

  // build_grammar_dailyconv_v1_final.process_sheet_rows() と同じ除外
  // (「誤りなし」の行・ID重複行はカード化しない)。
  const { rows, duplicateIds } = dailyconv.processSheetRows(notExportedRows);
  if (rows.length === 0) {
    setStatus(
      status,
      '出力対象の行がありません。まだ出力していない行はすべて「誤りなし」またはID重複のため'
      + '除外されました(誤りのある行だけがカード化の対象です)。',
      true,
    );
    return;
  }
  const skippedExported = dailyPendingRows.length - notExportedRows.length;

  if (!beginApkgExport(status)) return;
  try {
    setStatus(status, '.apkg を生成中...');
    const readyItems = dailyconv.buildFieldsReadyItems(rows);
    // TTS APIキーが設定されていれば、Answer(添削後)とExample(類似表現)に
    // 音声を合成して埋め込む(未設定なら従来どおり音声無し)。
    const { items, media } = await embedTtsAudioIntoItems(
      readyItems, TTS_FIELD_KEYS.daily, 'daily', status,
    );
    // cards.due(Ankiの新規カードの位置)は出力のたびに続き番号を採番する
    // (dueCounter.js の項を参照。以前は0始まりのインデックスだったため、
    // 別バッチのカードとAnki側で位置が衝突していた)。
    const startDue = getNextDue('daily');
    const blob = await buildApkg({
      cardDef, ankiSchema: shared.ankiSchema, items, media, startDue,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `daily_${stamp}.apkg`);
    // ダウンロードに成功した時点で初めて番号を進める(失敗したバッチで
    // 番号を消費すると、Anki側に存在しない番号が飛んでしまうため)。
    advanceNextDue('daily', items.length);
  } catch (e) {
    hideLoading(status);
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
    endApkgExport();
    return;
  }

  // -------------------------------------------------------------------------
  // ここから先は「.apkg の生成・ダウンロードに成功した後」の後処理。
  //
  // **生成本体とは別の try に分けてある**(2026-08-05修正)。以前は同じ try に
  // 入っており、シートへのマークが401やネットワークで失敗すると
  // 「.apkg の生成に失敗しました」と表示されていた。実際にはファイルは
  // ダウンロード済みなので、片桐が「失敗した」と読んで再出力する導線に
  // 乗りやすく、無駄なTTS/Gemini消費や二重マークにつながる。
  // -------------------------------------------------------------------------
  try {
    // シート側の「Anki出力済み」列マーク(③のチェックボックス)とは独立に、
    // 「このブラウザで.apkgに含めて出力した」ことをローカルへ記録する
    // (チェックボックスがOFFでも必ず記録する。マークし忘れ・書き込み失敗
    // 時の保険、renderDailyPending()の「✓ 出力済み」タグ/フィルターが使う)。
    dailyconv.addExportedIds(rows.map((r) => r.id));
    renderDailyPending();

    let note = '';
    if (skippedExported > 0) {
      note += `\n既に出力済みの ${skippedExported} 件は今回の対象から除きました。`;
    }
    if (duplicateIds.length > 0) note += `\nID重複の ${duplicateIds.length} 件は除外しました。`;

    // 「Anki出力済み」のマークは、.apkg の生成に**実際に成功してから**行う
    // (デスクトップ版と同じ2段階設計。失敗した行を出力済みにしないため)。
    if ($('daily-mark-exported').checked) {
      if (confirm(`${rows.length} 件をシートの「Anki出力済み」列にマークします。よろしいですか？`)) {
        showLoading(status, 'シートを更新中...');
        const cfg = await requireSheetsAccess();
        const result = await markRowsAsExported({ ...cfg, rowIds: rows.map((r) => r.id) });
        hideLoading(status);
        note += `\nシートの ${result.succeeded.length} 行を「Anki出力済み」にしました。`;
        if (result.failed.length > 0) {
          note += `(${result.failed.length} 件はID列に見つかりませんでした)`;
        }
        await refreshDailyPending(null);
      } else {
        note += '\nシートへのマークは行いませんでした。';
      }
    }

    setStatus(
      status,
      `${rows.length} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。${note}`,
    );
  } catch (e) {
    hideLoading(status);
    // apkg は既に手元にあることを最初に伝える(再出力しなくてよいと分かるように)。
    setStatus(
      status,
      `.apkg は ${rows.length} 件で出力済みです(ダウンロード済みのファイルをAnkiで開いてください)。\n`
      + `ただしシートの「Anki出力済み」への書き込みに失敗しました: ${e.message}\n`
      + '(この端末では出力済みとして記録済みです。シート側のマークだけやり直したい場合は、'
      + '②の「出力済みの印を外す」を押してから、もう一度出力してください)',
      true,
    );
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateGoogleAuthStatus();
    }
  } finally {
    endApkgExport();
  }
}

/**
 * シートの1行を、実際のカードテンプレート+CSSでプレビューする。
 * 出力前の行は9フィールドを持たないため、buildFieldsReadyItems() で
 * 1件だけ変換してから showPreview() と同じ手順でレンダリングする。
 */
function showDailyPreview(row) {
  const def = shared.cardDefs?.daily;
  if (!def) {
    alert('カード定義の読み込みが完了していません。');
    return;
  }
  const [item] = dailyconv.buildFieldsReadyItems([row]);
  const fields = fieldsFromItem(def, item);
  const values = {};
  def.fields.forEach((f, i) => { values[f.anki_name] = fields[i]; });

  const tmpl = def.anki_model.tmpls[0];
  const front = renderTemplate(tmpl.qfmt, values);
  const back = renderTemplate(tmpl.afmt, values, front);

  $('preview-title').textContent = `プレビュー: ${(row.original || '').slice(0, 30)}`;
  $('preview-frame').srcdoc = buildPreviewDoc(def.anki_model.css, front, back);
  $('preview-dialog').showModal();
}

// ---------------------------------------------------------------------------
// 共通: 一覧の行・削除・出力
// ---------------------------------------------------------------------------

/**
 * @param {string} [meta] 生成日時などの補足情報(2026-07-29追加)。
 *   空文字・未指定なら何も描画しない(古い形式で保存されたストック項目
 *   ("generated_at"を持たない)でも問題なく表示できるようにするため)。
 * @param {(string|{text: string, kind?: 'warning'|'done'})[]} [tags] 行に付ける
 *   バッジ(2026-07-29追加、複数指定可)。文字列を渡すと従来通り警告色
 *   (`.dup-tag`)になる(単語/AIに質問/習熟用タブの既存呼び出しはこの
 *   フォールバックのまま無変更で動く)。`{text, kind: 'done'}`を渡すと
 *   警告色ではない控えめな配色(`.done-tag`)になる(「✓ 出力済み」用、
 *   問題ではなく単なる状態表示のため警告色と区別する)。省略時は
 *   `isDuplicate`がtrueなら`[' ⚠ 重複']`を使う。DailyConversationタブは
 *   「重複の可能性」「誤りなし」「出力済み」を同時に持つ行があるため、
 *   明示的に配列で渡す。
 * @param {string} [rowId] 指定するとチェックボックスに`data-row-id`属性を
 *   付与する(2026-07-29追加)。フィルターで表示行が絞られると描画順序と
 *   元データのインデックスが一致しなくなるタブがあるため、位置ベースでは
 *   なくID経由で選択項目を特定する(全タブ共通、checkedRowIdsOf参照)。
 */
function buildStockRow({ isDuplicate, tags, title, subtitle, meta, rowId, onPreview }) {
  const li = document.createElement('li');
  if (isDuplicate) li.className = 'duplicate';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.setAttribute('aria-label', `${title} を選択`);
  if (rowId) cb.dataset.rowId = rowId;

  const body = document.createElement('div');
  body.className = 'body';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = title;
  const tagList = tags && tags.length > 0 ? tags : (isDuplicate ? [' ⚠ 重複'] : []);
  tagList.forEach((t) => {
    const spec = typeof t === 'string' ? { text: t, kind: 'warning' } : t;
    const tag = document.createElement('span');
    tag.className = spec.kind === 'done' ? 'done-tag' : 'dup-tag';
    tag.textContent = spec.text;
    titleEl.appendChild(tag);
  });

  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'subtitle';
  subtitleEl.textContent = subtitle;

  body.append(titleEl, subtitleEl);

  if (meta) {
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    metaEl.textContent = meta;
    body.append(metaEl);
  }

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'ghost';
  preview.textContent = '🔍';
  preview.title = 'カードをプレビュー';
  preview.addEventListener('click', onPreview);

  li.append(cb, body, preview);
  return li;
}

// ---------------------------------------------------------------------------
// 一括出力タブ(2026-08-20追加)
//
// 各タブの「.apkg をダウンロード」を1回で済ませるためのタブ。集める対象は
// 「まだ出力していないカード」から「重複としてマークされているもの」を除いた
// もので、**重複クラスタは片方だけ残さず丸ごと対象外にする**(どちらを残す
// べきかはアプリには判断できず、勝手に選ぶと意図しない方が出力されるため。
// 各タブの一覧で警告色になっているものと完全に同じ集合なので、そのタブで
// 整理してから出力すればよい)。
//
// デッキ・ノートタイプは種別ごとに分かれたまま1つの.apkgへ入る
// (lib/apkg.js の buildApkg({groups}) を参照)。Num・cards.due の採番、
// 出力済みの記録の付き方は、各タブから個別に出力したときとまったく同じ。
//
// DailyConversationだけは候補の実体がスプレッドシートなので、**このタブから
// シートを読みには行かない**(ネットワークアクセスと再ログインを一括出力の
// 副作用にしたくないため)。DailyConversationタブの②で読み込み済みの行だけを
// 対象にする。
// ---------------------------------------------------------------------------

/** 一括出力の対象を数える(ネットワークアクセスはしない)。 */
function collectBulkSources() {
  const wordDup = wordDuplicateIndices();
  const aiDup = aiAskDuplicateIndices();
  const sjDup = shuujukuDuplicateIndices();

  const word = wordStock.filter((item, i) => !item.exported_at && !wordDup.has(i));
  const aiAsk = aiAskStock.filter((item, i) => !item.exported_at && !aiDup.has(i));
  // 習熟用は出力するとストックから消える方式なので exported_at は持たない。
  const shuujuku = shuujukuStock.filter((item, i) => !sjDup.has(i));

  const wordSkipped = wordStock.filter((item, i) => !item.exported_at && wordDup.has(i)).length;
  const aiSkipped = aiAskStock.filter((item, i) => !item.exported_at && aiDup.has(i)).length;
  const sjSkipped = sjDup.size;

  let dailyRows = [];
  let dailyNote = '';
  const includeDaily = $('bulk-include-daily')?.checked;
  if (!includeDaily) {
    dailyNote = '含めない設定です';
  } else if (dailyPendingRows.length === 0) {
    dailyNote = 'DailyConversationタブの②で読み込むと対象になります';
  } else {
    const exportedIds = dailyconv.loadExportedIds();
    const notExported = dailyPendingRows.filter((row) => !exportedIds.has(row.id));
    // 「誤りなし」の行・ID重複行の除外はデスクトップ版と同じ processSheetRows に任せる。
    const processed = dailyconv.processSheetRows(notExported);
    dailyRows = processed.rows;
    const skipped = dailyPendingRows.length - notExported.length;
    const notes = [];
    if (skipped > 0) notes.push(`出力済み ${skipped} 件は対象外`);
    const dropped = notExported.length - dailyRows.length;
    if (dropped > 0) notes.push(`誤りなし/ID重複 ${dropped} 件は対象外`);
    dailyNote = notes.join(' / ');
  }

  return {
    word: { items: word, skipped: wordSkipped },
    aiAsk: { items: aiAsk, skipped: aiSkipped },
    shuujuku: { items: shuujuku, skipped: sjSkipped },
    daily: { items: dailyRows, note: dailyNote },
  };
}

/** 一括出力タブの内訳リストを描画する。 */
function renderBulkSummary() {
  const list = $('bulk-summary');
  if (!list) return;
  const src = collectBulkSources();
  const rows = [
    ['単語', src.word.items.length, src.word.skipped ? `重複 ${src.word.skipped} 件は対象外` : ''],
    ['AIに質問', src.aiAsk.items.length, src.aiAsk.skipped ? `重複 ${src.aiAsk.skipped} 件は対象外` : ''],
    ['習熟用(音読)', src.shuujuku.items.length, src.shuujuku.skipped ? `重複 ${src.shuujuku.skipped} 件は対象外` : ''],
    ['DailyConversation', src.daily.items.length, src.daily.note],
  ];
  const total = rows.reduce((sum, r) => sum + r[1], 0);
  list.textContent = '';
  for (const [label, count, note] of rows) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = label;
    if (note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'bulk-note';
      noteEl.textContent = ` (${note})`;
      left.appendChild(noteEl);
    }
    const right = document.createElement('span');
    right.className = 'bulk-count';
    right.textContent = `${count} 件`;
    li.appendChild(left);
    li.appendChild(right);
    list.appendChild(li);
  }
  const li = document.createElement('li');
  li.className = 'bulk-total';
  const left = document.createElement('span');
  left.textContent = '合計';
  const right = document.createElement('span');
  right.className = 'bulk-count';
  right.textContent = `${total} 件`;
  li.appendChild(left);
  li.appendChild(right);
  list.appendChild(li);
}

/** 生成した音声を1つのMapへ集める(ファイル名はタブごとの接頭辞で衝突しない)。 */
function mergeMedia(target, source) {
  if (!source) return target;
  for (const [name, bytes] of source) target.set(name, bytes);
  return target;
}

async function onExportBulk() {
  const status = $('bulk-export-status');
  if (rejectWhileExporting(status)) return;

  const src = collectBulkSources();
  const total = src.word.items.length + src.aiAsk.items.length
    + src.shuujuku.items.length + src.daily.items.length;
  if (total === 0) {
    setStatus(status, '出力できる未出力のカードがありません。', true);
    return;
  }
  if (!shared.cardDefs || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  // **出力対象を開始時点で固定する。** 習熟用ストックは「AIに質問」の4問目
  // 生成やDailyConversationの添削から非同期に増えるため、TTS付きの生成に
  // 数分かかっている間に増えた分まで出力済みにしてしまわないようにする
  // (onExportShuujuku と同じ理由)。
  const wordTargets = src.word.items.slice();
  const aiTargets = src.aiAsk.items.slice();
  const shuujukuTargets = src.shuujuku.items.slice();
  const dailyRows = src.daily.items.slice();

  if (!beginApkgExport(status)) return;
  let counts = null;
  try {
    setStatus(status, '.apkg を生成中...');
    const media = new Map();
    const groups = [];
    // 種別ごとの続き番号は、各タブから単独で出力したときとまったく同じ採番。
    let shuujukuStartNum = 0;

    if (shuujukuTargets.length > 0) {
      shuujukuStartNum = getNextNum();
      const embedded = await embedShuujukuTtsAudio(shuujukuTargets, status);
      mergeMedia(media, embedded.media);
      groups.push({
        cardDef: shared.cardDefs.shuujuku,
        items: buildFieldsReadyItems(shuujukuTargets, shuujukuStartNum, embedded.audioTagsByItem),
      });
    }
    if (aiTargets.length > 0) {
      const embedded = await embedTtsAudioIntoItems(
        aiTargets, TTS_FIELD_KEYS.ai_ask, 'ai_ask', status,
      );
      mergeMedia(media, embedded.media);
      groups.push({
        cardDef: shared.cardDefs.grammar_multi,
        items: embedded.items,
        startDue: getNextDue('grammar_multi'),
      });
    }
    if (wordTargets.length > 0) {
      const embedded = await embedTtsAudioIntoItems(
        wordTargets, TTS_FIELD_KEYS.word, 'word', status,
      );
      mergeMedia(media, embedded.media);
      groups.push({
        cardDef: shared.cardDefs.word,
        items: embedded.items,
        startDue: getNextDue('word'),
      });
    }
    if (dailyRows.length > 0) {
      const readyItems = dailyconv.buildFieldsReadyItems(dailyRows);
      const embedded = await embedTtsAudioIntoItems(
        readyItems, TTS_FIELD_KEYS.daily, 'daily', status,
      );
      mergeMedia(media, embedded.media);
      groups.push({
        cardDef: shared.cardDefs.daily,
        items: embedded.items,
        startDue: getNextDue('daily'),
      });
    }

    const blob = await buildApkg({ ankiSchema: shared.ankiSchema, groups, media });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `bulk_${stamp}.apkg`);
    hideLoading(status);

    // --- ここから後処理(ダウンロードに成功してから) ---
    // 各タブから単独で出力したときと同じ記録の付け方をする。
    counts = [];
    if (shuujukuTargets.length > 0) {
      addTombstoneIds(STORAGE.shuujukuTombstones, shuujukuTargets.map((item) => item.id));
      advanceNextNum(shuujukuTargets.length);
      const exportedSet = new Set(shuujukuTargets);
      shuujukuStock = shuujukuStock.filter((item) => !exportedSet.has(item));
      localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
      renderShuujukuStock();
      counts.push(`習熟用 ${shuujukuTargets.length} 件`);
    }
    const exportedAt = new Date().toISOString();
    if (aiTargets.length > 0) {
      advanceNextDue('grammar_multi', aiTargets.length);
      const exportedSet = new Set(aiTargets);
      aiAskStock = aiAskStock.map((item) => (
        exportedSet.has(item) ? { ...item, exported_at: exportedAt, updated_at: exportedAt } : item
      ));
      localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock));
      renderAiAskStock();
      counts.push(`AIに質問 ${aiTargets.length} 件`);
    }
    if (wordTargets.length > 0) {
      advanceNextDue('word', wordTargets.length);
      const exportedSet = new Set(wordTargets);
      wordStock = wordStock.map((item) => (
        exportedSet.has(item) ? { ...item, exported_at: exportedAt, updated_at: exportedAt } : item
      ));
      localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock));
      renderWordStock();
      counts.push(`単語 ${wordTargets.length} 件`);
    }
    if (dailyRows.length > 0) {
      advanceNextDue('daily', dailyRows.length);
      // シート側の「Anki出力済み」列とは独立に、この端末で出力したことを記録する
      // (onDailyExport と同じ。マークし忘れ・書き込み失敗時の保険)。
      dailyconv.addExportedIds(dailyRows.map((r) => r.id));
      renderDailyPending();
      counts.push(`DailyConversation ${dailyRows.length} 件`);
    }
    renderBulkSummary();

    setStatus(
      status,
      `${counts.join(' / ')} を1つの .apkg に書き出しました。`
      + 'ダウンロードした .apkg を Anki で開いてください。'
      + (dailyRows.length > 0
        ? '\nDailyConversationのシートの「Anki出力済み」列にはマークしていません'
          + '(必要ならDailyConversationタブから行ってください)。'
        : ''),
    );
  } catch (e) {
    hideLoading(status);
    if (counts) {
      // .apkg は既に手元にある。後処理で失敗した場合に「生成に失敗」と読ませない。
      setStatus(
        status,
        `.apkg は出力済みです(ダウンロード済みのファイルをAnkiで開いてください)。\n`
        + `ただし出力済みの記録に失敗しました: ${e.message}`,
        true,
      );
    } else {
      setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
    }
  } finally {
    endApkgExport();
  }
}

const TAB_CONFIG = {
  word: {
    get stock() { return wordStock; },
    setStock: (v) => { wordStock = v; localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock)); },
    listEl: 'word-stock-list',
    render: renderWordStock,
    label: (item) => item.word,
    cardDefKey: 'word',
  },
  ai_ask: {
    get stock() { return aiAskStock; },
    setStock: (v) => { aiAskStock = v; localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock)); },
    listEl: 'ai-ask-stock-list',
    render: renderAiAskStock,
    label: (item) => `[${item.pattern || '形式未設定'}] ${htmlToPlainText(item.question).slice(0, 20)}`,
    cardDefKey: 'grammar_multi',
  },
  // shuujuku: onDeleteSelected/onClearStock(汎用の一覧削除)からは使うが、
  // 出力(onExportShuujuku)・プレビュー(showShuujukuPreview)は続き番号(Num)の
  // 採番が必要なため専用関数を使う(cardDefKeyはここでは未使用)。
  shuujuku: {
    get stock() { return shuujukuStock; },
    setStock: (v) => { shuujukuStock = v; localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock)); },
    listEl: 'shuujuku-stock-list',
    render: renderShuujukuStock,
    label: (item) => item.pattern || '(パターン未設定)',
    cardDefKey: 'shuujuku',
  },
};

/**
 * `buildStockRow`が`rowId`付きで描画したチェックボックスのうち、選択済みの
 * `data-row-id`を集めて返す(2026-07-29追加)。単語/AIに質問/習熟用/
 * DailyConversationいずれのタブも、フィルターで表示行が絞られると
 * 描画順序と元データのインデックスが一致しなくなるため、位置ベースでは
 * なくこちらで選択項目を特定する(全タブで統一)。
 */
function checkedRowIdsOf(listElId) {
  return [...document.querySelectorAll(`#${listElId} input[type="checkbox"]`)]
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.rowId)
    .filter(Boolean);
}

function onDeleteSelected(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const ids = checkedRowIdsOf(cfg.listEl);
  if (ids.length === 0) {
    alert('削除する項目を選択してください。');
    return;
  }
  if (!confirm(`選択した ${ids.length} 件を削除します。よろしいですか？`)) return;
  const remove = new Set(ids);
  cfg.setStock(cfg.stock.filter((item) => !remove.has(item.id)));
  // 複数端末間の同期(onSyncNow)が「削除済みは復活させない」と判定できるよう、
  // 削除したidを打ち消し記録に残す(2026-07-30)。
  addTombstoneIds(TOMBSTONE_STORAGE[tabKey], ids);
  cfg.render();
}

function onClearStock(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  if (cfg.stock.length === 0) {
    alert('カードがありません。');
    return;
  }
  if (!confirm(`${cfg.stock.length} 件すべてを削除します。よろしいですか？(取り消せません)`)) return;
  addTombstoneIds(TOMBSTONE_STORAGE[tabKey], cfg.stock.map((item) => item.id));
  cfg.setStock([]);
  cfg.render();
}

/**
 * 「出力済み履歴をリセット」(2026-07-29追加、単語/AIに質問タブ)。
 * カード自体は削除せず、`exported_at`フラグだけを全項目から取り除く
 * (「✓ 出力済み」タグ・フィルターの対象から外れ、次回の出力対象にも
 * 再び含まれるようになる)。
 */
function onResetExported(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const exportedCount = cfg.stock.filter((item) => item.exported_at).length;
  if (exportedCount === 0) {
    alert('出力済みのカードがありません。');
    return;
  }
  if (!confirm(
    `${exportedCount} 件の「出力済み」記録をリセットします。カード自体は削除されません。よろしいですか？`,
  )) return;
  cfg.setStock(cfg.stock.map((item) => {
    const { exported_at, ...rest } = item;
    // 複数端末間の同期(2026-07-30)がこのリセットを「新しい変更」として
    // 優先できるよう updated_at を打ち直す(でないと、まだexported_atを
    // 持ったままの古いリモートの内容にマージで上書きされてしまう)。
    return { ...rest, updated_at: new Date().toISOString() };
  }));
  cfg.render();
}

/**
 * 「出力済みを削除」(2026-07-30追加、単語/AIに質問タブ)。片桐から
 * 「複数端末間の同期でAIに質問のセル使用率(保存上限に対する%)が
 * 19.6%とかなり高い」という報告を受けての対応。原因は、出力(`.apkg`
 * ダウンロード)しても`onExport`はカードを削除せず`exported_at`を付けて
 * ストックに残し続けており(「出力済みを隠す」フィルターで見えなくなるだけ)、
 * 複数端末間の同期(`runSync`)は出力済みも含めたストック全体をシートへ
 * 書き込んでいるため。`onResetExported`(フラグを消すだけで項目は残す、
 * 再出力目的)とは別物で、こちらはカード自体を完全に削除する
 * (`onClearStock`と同じ「打ち消し記録(tombstone)を残してから削除」設計。
 * 次回の同期でリモート側からも取り除かれ、セル使用率が下がる)。
 *
 * **バックアップに関する注意(片桐からの指摘を受けた設計判断)**: デスクトップ版は
 * apkg生成のたびに`backup/`フォルダへ自動保存するが、Web版はブラウザの
 * ダウンロード機構(`downloadBlob`)を使うだけで、アプリ側では生成物を
 * 一切保持していない(File System Access APIによる自動バックアップ先の
 * 指定はモバイルブラウザでの対応状況が不安定なため見送った)。つまりこの
 * ストックの項目こそが「Ankiに取り込む前の内容」を再現できる唯一のコピーで
 * あり、削除すると復元できない。この関数を`onResetExported`のように無条件・
 * 自動では呼ばず、片桐が明示的にボタンを押した場合のみ実行し、確認
 * ダイアログで「Ankiへの取り込みを確認してから」と警告するのはこのため。
 */
function onDeleteExported(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const exportedItems = cfg.stock.filter((item) => item.exported_at);
  if (exportedItems.length === 0) {
    alert('出力済みのカードがありません。');
    return;
  }
  if (!confirm(
    `出力済みの ${exportedItems.length} 件をストックから完全に削除します(カードの内容自体が消えます)。\n\n`
    + 'ダウンロードした.apkgが実際にAnkiへ取り込み済みであることを必ず確認してから'
    + '実行してください(Web版はデスクトップ版と違い、出力した.apkgを自動保存していません)。\n'
    + '事前に⚙設定の「バックアップを書き出す」を実行していれば、後から復元できます。',
  )) return;
  const exportedSet = new Set(exportedItems);
  cfg.setStock(cfg.stock.filter((item) => !exportedSet.has(item)));
  addTombstoneIds(TOMBSTONE_STORAGE[tabKey], exportedItems.map((item) => item.id));
  cfg.render();
}

/**
 * 単語/AIに質問タブの「.apkg をダウンロード」。2026-07-29に、出力対象を
 * ストック全体ではなく**まだ出力していない項目だけ**に変更した(以前は
 * 出力してもストックから何も変化させず、次回出力時に既出力分と新規分が
 * 毎回一緒にバンドルされて紛らわしいという指摘を受けた対応)。出力に
 * 実際に成功した項目だけへ`exported_at`を付ける2段階設計
 * (デスクトップ版の`mark_exported`と同じ考え方。生成に失敗した項目は
 * 次回も出力対象に残る)。カード自体はストックから削除しない
 * (「✓ 出力済み」タグ付きで残り、フィルターで隠す/表示を切り替えられる)。
 */
async function onExport(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const statusId = tabKey === 'word' ? 'word-export-status' : 'ai-ask-export-status';
  const status = $(statusId);
  if (rejectWhileExporting(status)) return;

  const pendingItems = cfg.stock.filter((item) => !item.exported_at);
  if (pendingItems.length === 0) {
    setStatus(
      status,
      cfg.stock.length === 0
        ? '出力するカードがありません。'
        : '出力する(未出力の)カードがありません。既に出力済みのカードのみです。',
      true,
    );
    return;
  }
  const cardDef = shared.cardDefs?.[cfg.cardDefKey];
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  if (!beginApkgExport(status)) return;
  try {
    setStatus(status, '.apkg を生成中...');
    // TTS APIキーが設定されていれば、対象フィールド(単語:Example、
    // AIに質問:Answer+Example)に音声を合成して埋め込む(未設定なら
    // 従来どおり音声無し。cfg.stock自体は変更しない、下記embedTtsAudioIntoItems参照)。
    const { items, media } = await embedTtsAudioIntoItems(
      pendingItems, TTS_FIELD_KEYS[tabKey] || [], tabKey, status,
    );
    // cards.due(Ankiの新規カードの位置)は出力のたびに続き番号を採番する
    // (dueCounter.js の項を参照。以前は word が全ノート due=0、
    // grammar_multi が0始まりのインデックスで、どちらも出力のたびに
    // 振り直されて別バッチのカードとAnki側で位置が衝突していた)。
    const startDue = getNextDue(cfg.cardDefKey);
    const blob = await buildApkg({
      cardDef,
      ankiSchema: shared.ankiSchema,
      items,
      media,
      startDue,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `${tabKey}_${stamp}.apkg`);
    // ダウンロードに成功した時点で初めて番号を進める(exported_atと同じ2段階設計)。
    advanceNextDue(cfg.cardDefKey, items.length);

    // .apkgの生成・ダウンロードに実際に成功した項目だけへexported_atを
    // 記録する。pendingItemsはcfg.stockの要素をそのまま参照しているため
    // (filter()は複製しない)、Setでの参照比較でどの項目が対象だったか
    // 判定できる(インデックス計算は不要)。
    const exportedAt = new Date().toISOString();
    const exportedSet = new Set(pendingItems);
    cfg.setStock(cfg.stock.map((item) => (
      // updated_at も一緒に打ち直す(2026-07-30、複数端末間の同期がこの
      // exported_atを「新しい変更」として優先できるようにするため)。
      exportedSet.has(item) ? { ...item, exported_at: exportedAt, updated_at: exportedAt } : item
    )));
    cfg.render();

    setStatus(
      status,
      `${pendingItems.length} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。`,
    );
  } catch (e) {
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
  } finally {
    endApkgExport();
  }
}

/**
 * 出力中なら理由をその場に表示して true を返す(呼び出し側はそこで中止する)。
 *
 * 各出力関数の**先頭**で呼ぶこと。「カードがありません」等の事前チェックより
 * 後ろに置くと、たまたま条件を満たさないタブを押したときに出力中であることが
 * 伝わらず、押しても無反応に見えてしまう。
 */
function rejectWhileExporting(statusEl) {
  if (!apkgExportInProgress) return false;
  setStatus(statusEl, EXPORT_BUSY_MESSAGE, true);
  return true;
}

/**
 * .apkg 出力の開始を宣言する。既に別の出力が走っていれば false を返す
 * (理由は上の EXPORT_BUTTON_IDS 付近を参照)。true を返した場合、
 * 呼び出し側は **必ず finally で endApkgExport() を呼ぶこと**
 * (でないと以後どのタブからも出力できなくなる)。
 */
function beginApkgExport(statusEl) {
  if (rejectWhileExporting(statusEl)) return false;
  apkgExportInProgress = true;
  // disabled ではなく aria-disabled を使う理由は EXPORT_BUTTON_IDS 付近を参照
  // (押せない見た目のまま、押されたら理由を出せるようにするため)。
  EXPORT_BUTTON_IDS.forEach((id) => {
    const b = $(id);
    if (b) b.setAttribute('aria-disabled', 'true');
  });
  return true;
}

function endApkgExport() {
  apkgExportInProgress = false;
  EXPORT_BUTTON_IDS.forEach((id) => {
    const b = $(id);
    if (b) b.removeAttribute('aria-disabled');
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS Safari では即座に revoke するとダウンロードが中断されることがある
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// カードプレビュー(実際のテンプレート + CSS でレンダリング)
// ---------------------------------------------------------------------------

function showPreview(tabKey, item) {
  const cardDefKey = TAB_CONFIG[tabKey].cardDefKey;
  const def = shared.cardDefs?.[cardDefKey];
  if (!def) {
    alert('カード定義の読み込みが完了していません。');
    return;
  }
  const fields = fieldsFromItem(def, item);
  const values = {};
  def.fields.forEach((f, i) => { values[f.anki_name] = fields[i]; });

  const tmpl = def.anki_model.tmpls[0];
  const front = renderTemplate(tmpl.qfmt, values);
  const back = renderTemplate(tmpl.afmt, values, front);

  $('preview-title').textContent = `プレビュー: ${TAB_CONFIG[tabKey].label(item)}`;
  $('preview-frame').srcdoc = buildPreviewDoc(def.anki_model.css, front, back);
  $('preview-dialog').showModal();
}

/** プレビューiframeに入れる、カードCSS+表面/裏面を並べたHTML文書を組み立てる。 */
function buildPreviewDoc(css, front, back) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}
hr.preview-sep{border:0;border-top:2px dashed #bbb;margin:24px 0}</style></head>
<body><div class="card">${front}<hr class="preview-sep">${back}</div></body></html>`;
}

/**
 * Anki のカードテンプレート(mustache 風)を簡易展開する。
 * デスクトップ版の tts_core.render_card_preview_html と同じ近似で、
 * {{Field}} / {{#Field}}...{{/Field}} / {{^Field}}...{{/Field}} /
 * {{FrontSide}} に対応する(条件の入れ子までは厳密に扱わない)。
 */
function renderTemplate(template, values, frontSide = '') {
  let out = template;
  out = out.replace(/\{\{FrontSide\}\}/g, frontSide);

  // 条件セクション: 値が空なら中身ごと削除、非空なら中身だけ残す
  for (const [name, value] of Object.entries(values)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filled = value !== '';
    out = out.replace(new RegExp(`\\{\\{#${esc}\\}\\}([\\s\\S]*?)\\{\\{/${esc}\\}\\}`, 'g'),
      filled ? '$1' : '');
    out = out.replace(new RegExp(`\\{\\{\\^${esc}\\}\\}([\\s\\S]*?)\\{\\{/${esc}\\}\\}`, 'g'),
      filled ? '' : '$1');
  }

  // 単純な置換({{Field}} と、読み上げ等の修飾子付き {{xxx:Field}})
  out = out.replace(/\{\{([^#^/}][^}]*)\}\}/g, (match, expr) => {
    const name = expr.includes(':') ? expr.slice(expr.lastIndexOf(':') + 1) : expr;
    return Object.prototype.hasOwnProperty.call(values, name.trim()) ? values[name.trim()] : '';
  });
  return out;
}

function setStatus(el, message, isError = false) {
  el.classList.remove('loading');
  el.textContent = message;
  el.classList.toggle('error', isError);
  // 通知バナーに出す文言は、数秒で自動的に消えても後から確認できるよう
  // ⚙設定の「ログ」にも残す(2026-08-06追加)。処理中の経過表示
  // (showLoading)は残さない——「〜中...」が大量に積もってログが
  // 読みにくくなるだけで、結果は必ず最後のsetStatusで記録されるため。
  if (el.hasAttribute('data-log')) appendAppLog(message, isError);
  if (el.hasAttribute('data-autohide')) {
    cancelAutoHideStatus(el);
    if (!message) {
      // 2026-08-05: message が空文字の呼び出し(例:
      // autoPullOnStartupの「変更なし」ケース)で el.hidden = false のまま
      // 自動非表示タイマーも立てず、中身が空のトースト枠だけが画面に
      // 残り続けるバグがあった(以前はこの状態表示が枠無しのインライン
      // テキストだったため気づきにくかったが、トースト化して背景・枠を
      // 付けたことで「空の丸い箱」として目立つようになり発覚した)。
      // 空文字なら即座に隠す。
      el.hidden = true;
      return;
    }
    el.hidden = false;
    // エラーは片桐が気づけるよう自動で隠さない。正常な文言だけ一定時間後に隠す。
    if (!isError) scheduleAutoHideStatus(el);
  }
}
