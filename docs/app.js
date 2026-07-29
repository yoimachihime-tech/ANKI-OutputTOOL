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
  generateVocabCard, generateGrammarMultiItems, generateShuujukuItem, generateShuujukuItemFromRow,
  correctEnglishText, consolidateNoErrorCorrections, listModels, GeminiError,
} from './lib/gemini.js';
import { buildApkg, fieldsFromItem } from './lib/apkg.js';
import { buildContentHtml, buildFieldsReadyItems, getNextNum, advanceNextNum } from './lib/shuujuku.js';
import {
  synthesizeFieldWithTags, synthesizeExampleAudioTags, synthesizeTestSample,
  decodeAudioSamples, computeWaveformMinMax, computePeakAmplitude, isClipped, findSafeVolumeGainDb,
} from './lib/tts.js';
import {
  getAccessToken, clearAccessToken, hasValidAccessToken,
  fetchPendingRows, appendCorrectionRows, markRowsAsExported, SheetsAuthError,
  readSyncState, writeSyncState,
} from './lib/sheets.js';
import * as dailyconv from './lib/dailyconv.js';
import {
  newSyncId, ensureItemIds, mergeStock, capacityPercent, parseIdArray,
} from './lib/sync.js';

// フィルターチェックボックスの状態をlocalStorageに永続化する際のキー接頭辞
// (bindPersistentCheckbox()参照)。init()がモジュール読み込み直後に即時
// 呼び出されるため、この定数は必ずその呼び出しより前(モジュール先頭側)に
// 置くこと(TDZで「初期化前にアクセスされた」エラーになる)。
const FILTER_STORAGE_PREFIX = 'anki_tool_filter_';

const STORAGE = {
  apiKey: 'anki_tool_gemini_api_key',
  model: 'anki_tool_gemini_model',
  wordStock: 'anki_tool_word_stock',
  aiAskStock: 'anki_tool_ai_ask_stock',
  shuujukuStock: 'anki_tool_shuujuku_stock',
  ttsApiKey: 'anki_tool_tts_api_key',
  ttsVoice: 'anki_tool_tts_voice',
  ttsLang: 'anki_tool_tts_lang',
  ttsVolumeGainDb: 'anki_tool_tts_volume_gain_db',
  ttsExcludeJapanese: 'anki_tool_tts_exclude_japanese',
  googleClientId: 'anki_tool_google_client_id',
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

const $ = (id) => document.getElementById(id);

/** 共有アセット(プロンプト・カード定義・スキーマ)。起動時に読み込む。 */
const shared = {
  wordPrompt: null,
  grammarMultiPrompt: null,
  shuujukuPrompt: null,
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
  localStorage.setItem(storageKey, JSON.stringify([...new Set(ids)].filter(Boolean).sort()));
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
  $('model').value = localStorage.getItem(STORAGE.model) || 'gemini-2.0-flash';
  $('tts-api-key').value = localStorage.getItem(STORAGE.ttsApiKey) || '';
  $('tts-voice').value = localStorage.getItem(STORAGE.ttsVoice) || $('tts-voice').value;
  $('tts-lang').value = localStorage.getItem(STORAGE.ttsLang) || $('tts-lang').value;
  $('tts-volume-gain').value = localStorage.getItem(STORAGE.ttsVolumeGainDb) || $('tts-volume-gain').value;
  $('tts-exclude-japanese').checked = localStorage.getItem(STORAGE.ttsExcludeJapanese) === '1';
  $('google-client-id').value = localStorage.getItem(STORAGE.googleClientId) || '';
  $('sheets-spreadsheet-id').value = localStorage.getItem(STORAGE.spreadsheetId) || '';
  $('sheets-sheet-name').value = localStorage.getItem(STORAGE.sheetName) || $('sheets-sheet-name').value;
  renderWordStock();
  renderAiAskStock();
  renderShuujukuStock();
  renderDailyPending();
  updateDailyAuthStatus();

  const [
    wordPrompt, grammarMultiPrompt, shuujukuPrompt, shuujukuDailyconvPrompt,
    correctionSystemInstruction, correctionResponseSchema, cardDefsJson, ankiSchema,
  ] = await Promise.all([
    fetchText('./shared/word_card_prompt.txt'),
    fetchText('./shared/grammar_multi_prompt.txt'),
    fetchText('./shared/shuujuku_prompt.txt'),
    fetchText('./shared/shuujuku_dailyconv_prompt.txt'),
    fetchText('./shared/correction_system_instruction.txt'),
    fetchJson('./shared/correction_response_schema.json'),
    fetchJson('./shared/card_defs.json'),
    fetchJson('./shared/anki_schema.json'),
  ]);
  shared.wordPrompt = wordPrompt;
  shared.grammarMultiPrompt = grammarMultiPrompt;
  shared.shuujukuPrompt = shuujukuPrompt;
  shared.shuujukuDailyconvPrompt = shuujukuDailyconvPrompt;
  shared.correctionSystemInstruction = correctionSystemInstruction;
  shared.correctionResponseSchema = correctionResponseSchema;
  shared.cardDefs = cardDefsJson.defs;
  shared.ankiSchema = ankiSchema;
}

async function fetchText(url) {
  const res = await fetch(url);
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
  const key = FILTER_STORAGE_PREFIX + id;
  const stored = localStorage.getItem(key);
  el.checked = stored === null ? defaultValue : stored === '1';
  el.addEventListener('change', () => {
    localStorage.setItem(key, el.checked ? '1' : '0');
    onChange();
  });
}

function bindEvents() {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ヘッダーのログインボタン(全タブ共通、2026-07-30追加)
  $('header-signin').addEventListener('click', onHeaderSignIn);

  // 設定(全タブ共通)
  $('settings-toggle').addEventListener('click', toggleSettings);
  $('toggle-key').addEventListener('click', () => {
    const el = $('api-key');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('api-key').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.apiKey, e.target.value.trim());
  });
  $('model').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.model, e.target.value.trim());
  });
  $('clear-key').addEventListener('click', onClearKey);
  $('fetch-models').addEventListener('click', onFetchModels);

  // TTS設定(全タブ共通)
  $('toggle-tts-key').addEventListener('click', () => {
    const el = $('tts-api-key');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('tts-api-key').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.ttsApiKey, e.target.value.trim());
  });
  $('tts-voice').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.ttsVoice, e.target.value.trim());
  });
  $('tts-lang').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.ttsLang, e.target.value.trim());
  });
  $('tts-volume-gain').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.ttsVolumeGainDb, e.target.value.trim());
  });
  $('tts-exclude-japanese').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.ttsExcludeJapanese, e.target.checked ? '1' : '0');
  });
  $('tts-test-play').addEventListener('click', onTestPlay);
  $('tts-auto-gain').addEventListener('click', onAutoGain);
  $('clear-tts-key').addEventListener('click', onClearTtsKey);

  // スプレッドシート設定(DailyConversationタブ用)
  $('google-client-id').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.googleClientId, e.target.value.trim());
    // クライアントIDが変わったら、古いトークンは使い回さない
    clearAccessToken();
    updateDailyAuthStatus();
  });
  $('sheets-spreadsheet-id').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.spreadsheetId, e.target.value.trim());
  });
  $('sheets-sheet-name').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.sheetName, e.target.value.trim());
  });
  $('sync-now').addEventListener('click', onSyncNow);

  // 単語タブ
  $('word-generate').addEventListener('click', onWordGenerate);
  $('word-delete-selected').addEventListener('click', () => onDeleteSelected('word'));
  $('word-clear-stock').addEventListener('click', () => onClearStock('word'));
  bindPersistentCheckbox('word-filter-hide-exported', true, renderWordStock);
  $('word-reset-exported').addEventListener('click', () => onResetExported('word'));
  $('word-export').addEventListener('click', () => onExport('word'));

  // AIに質問タブ
  $('ai-ask-generate').addEventListener('click', onAiAskGenerate);
  $('ai-ask-delete-selected').addEventListener('click', () => onDeleteSelected('ai_ask'));
  $('ai-ask-clear-stock').addEventListener('click', () => onClearStock('ai_ask'));
  bindPersistentCheckbox('ai-ask-filter-hide-exported', true, renderAiAskStock);
  $('ai-ask-reset-exported').addEventListener('click', () => onResetExported('ai_ask'));
  $('ai-ask-export').addEventListener('click', () => onExport('ai_ask'));

  // 習熟用(音読)タブ(入力欄は無く、AIに質問からの4問目でのみ増える)
  $('shuujuku-delete-selected').addEventListener('click', () => onDeleteSelected('shuujuku'));
  $('shuujuku-clear-stock').addEventListener('click', () => onClearStock('shuujuku'));
  $('shuujuku-export').addEventListener('click', onExportShuujuku);

  // DailyConversationタブ
  $('daily-signin').addEventListener('click', onDailySignIn);
  $('daily-signout').addEventListener('click', onDailySignOut);
  $('daily-correct').addEventListener('click', onDailyCorrect);
  $('daily-refresh').addEventListener('click', () => refreshDailyPending($('daily-export-status')));
  bindPersistentCheckbox('daily-filter-hide-no-error', false, renderDailyPending);
  bindPersistentCheckbox('daily-filter-only-duplicates', false, renderDailyPending);
  bindPersistentCheckbox('daily-filter-hide-exported', true, renderDailyPending);
  $('daily-exclude-selected').addEventListener('click', onDailyExcludeSelected);
  $('daily-clear-exclusions').addEventListener('click', onDailyClearExclusions);
  $('daily-reset-exported').addEventListener('click', onDailyResetExported);
  $('daily-export').addEventListener('click', onDailyExport);

  // プレビュー(共通)
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
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
}

function hideLoading(statusEl) {
  statusEl.classList.remove('loading');
}

// ---------------------------------------------------------------------------
// 設定(APIキー・モデル)
// ---------------------------------------------------------------------------

function onClearKey() {
  if (!confirm('保存したAPIキーをこのブラウザから消去します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE.apiKey);
  $('api-key').value = '';
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
    const dl = $('model-list');
    dl.textContent = '';
    names.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      dl.appendChild(opt);
    });
    alert(`${names.length} 件のモデルを取得しました。モデル欄の候補から選べます。`);
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
 */
function createSilentWavBlobUrl() {
  const buffer = new ArrayBuffer(46);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 38, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 16000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, 2, true);
  view.setInt16(44, 0, true);
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
  audio.pause();
  audio.src = url;
  audio.currentTime = 0;
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
  const silentUrl = createSilentWavBlobUrl();
  audio.src = silentUrl;
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
    URL.revokeObjectURL(silentUrl);
    if (testPlayAudio !== audio) return; // 連打等で既に別の再生に切り替わっている
    await playTestWaveform(audio, bytes, audioBuffer.duration, buckets, clipped);
  } catch (e) {
    URL.revokeObjectURL(silentUrl);
    hideLoading(statusEl);
    setStatus(statusEl, e.message, true);
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
 * buildFieldsReadyItems()のaudioTagsByItem引数にそのまま渡せる形で返す。
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
    // デスクトップ版と同じく1件ずつ直列で呼ぶ(レート制限に配慮)。
    for (let i = 0; i < pairs.length; i += 1) {
      const { word, context } = pairs[i];
      showLoading(status, `生成中... (${i + 1}/${pairs.length}) ${word}`);
      try {
        const card = await generateVocabCard({
          word,
          contextSentence: context,
          apiKey,
          model,
          promptTemplate: shared.wordPrompt,
        });
        const generatedAt = new Date().toISOString();
        generated.push({
          ...card, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt,
        });
      } catch (e) {
        failed.push(`${word}: ${e.message}`);
        if (e instanceof GeminiError && (e.message.includes('1日あたり') || e.message.includes('前払いクレジット'))) break;
      }
    }

    if (generated.length > 0) {
      wordStock = wordStock.concat(generated);
      localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock));
      renderWordStock();
    }

    hideLoading(status);
    // 全件成功したときだけ入力欄を空にする(失敗した行を片桐が確認できるように)。
    if (failed.length === 0) {
      $('word-input').value = '';
      setStatus(status, `${generated.length} 件のカードを生成しました。`);
    } else {
      setStatus(
        status,
        `${generated.length} 件成功 / ${failed.length} 件失敗\n${failed.join('\n')}`,
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
    setStatus(status, `${items.length} 件のカードを生成しました${shuujukuNote}`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 習熟用(音読)タブ
// このタブには直接の入力欄が無く、onAiAskGenerate()の4問目としてのみ増える
// (CLAUDE.mdの「習熟用の populate source」を参照)。
// ---------------------------------------------------------------------------

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
  if (shuujukuStock.length === 0) {
    setStatus(status, '出力するカードがありません。', true);
    return;
  }
  const cardDef = shared.cardDefs?.shuujuku;
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const btn = $('shuujuku-export');
  btn.disabled = true;
  try {
    setStatus(status, '.apkg を生成中...');
    // Numフィールド・cards.dueは出力するたびに続き番号を採番する(desktop版の
    // shuujuku_stock.get_next_num()と同じ理由: Anki側のソートフィールド衝突を
    // 避けるため)。そのためbuildFieldsReadyItems()でNum/Contentを確定させて
    // から渡す(ストックの生item自体はNum/Contentを持たない)。
    const startNum = getNextNum();
    // TTS APIキーが設定されていれば、例文ごとに音声を合成してContentに
    // 埋め込む(未設定なら従来どおり音声無し)。
    const { audioTagsByItem, media } = await embedShuujukuTtsAudio(shuujukuStock, status);
    const readyItems = buildFieldsReadyItems(shuujukuStock, startNum, audioTagsByItem);
    const blob = await buildApkg({ cardDef, ankiSchema: shared.ankiSchema, items: readyItems, media });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `shuujuku_${stamp}.apkg`);

    // apkgの生成に成功した時点で初めて続き番号を進め、出力済みの項目を
    // ストックから取り除く(desktop版のmark_exportedと同じ2段階設計。
    // 生成に失敗した場合はストックも番号も変化させない)。
    // 出力済みで消える項目のidは打ち消し記録に残す(2026-07-30、複数端末間の
    // 同期が「削除済み(出力済み)は復活させない」と判定できるようにするため)。
    addTombstoneIds(STORAGE.shuujukuTombstones, shuujukuStock.map((item) => item.id));
    advanceNextNum(shuujukuStock.length);
    const count = shuujukuStock.length;
    shuujukuStock = [];
    localStorage.setItem(STORAGE.shuujukuStock, JSON.stringify(shuujukuStock));
    renderShuujukuStock();

    setStatus(status, `${count} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。`);
  } catch (e) {
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 習熟用アイテムのプレビュー(実際に出力される次の番号を仮に使ってレンダリング
 * する。出力前のitemはNum/Contentを持たないため、他タブのshowPreview()を
 * そのまま使えない)。
 */
function showShuujukuPreview(item) {
  const def = shared.cardDefs?.shuujuku;
  if (!def) {
    alert('カード定義の読み込みが完了していません。');
    return;
  }
  const previewNum = getNextNum();
  const values = {
    Num: String(previewNum).padStart(3, '0'),
    Content: buildContentHtml(previewNum, item),
  };
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
    spreadsheetId: $('sheets-spreadsheet-id').value.trim(),
    sheetName: $('sheets-sheet-name').value.trim(),
  };
}

/**
 * ログイン状態の表示と、ログイン系ボタンの文言を現在の状態に合わせる。
 * DailyConversationタブのボタンだけでなく、ヘッダーのログインボタン
 * (2026-07-30追加、`header-signin`)もここでまとめて同期する。DailyConversation
 * タブを開かなくても、⚙設定の「複数端末間の同期」等のためにログインだけ
 * 先に済ませられるようにするのが目的。状態管理はこの関数に一本化してあり、
 * ログイン状態が変わりうる箇所(onHeaderSignIn/onDailySignIn/onDailySignOut/
 * requireSheetsAccess/onSyncNow等)は全てここを呼ぶだけでよい。
 */
function updateDailyAuthStatus() {
  const signedIn = hasValidAccessToken();
  setStatus(
    $('daily-auth-status'),
    signedIn
      ? 'ログイン済みです(このページを閉じるか約1時間で失効します)。'
      : '未ログインです。シートを読み書きする操作の前にログインしてください。',
  );
  // 既にログイン済みの状態で押した場合は「アカウントを選び直したい」
  // ケースとみなし、同意画面を明示的に出す(forceConsent)。ヘッダーの
  // ボタンも同じ文言・同じ挙動にする。
  const signinLabel = signedIn ? '別のアカウントでログイン' : 'Googleにログイン';
  $('daily-signin').textContent = signinLabel;
  $('daily-signout').disabled = !signedIn;
  $('header-signin').textContent = signinLabel;
}

/**
 * Googleログインの実処理(2026-07-30、ヘッダーのログインボタン追加に伴い
 * onDailySignIn()から切り出し)。DailyConversationタブのボタンとヘッダーの
 * ボタンは見た目(進捗を出すstatus要素・disabledにするbutton要素)だけが
 * 違うため、状態表示先を引数で受け取れるようにしてある。
 * @returns {Promise<boolean>} ログインに成功したか
 */
async function signInToGoogle(statusEl, btnEl) {
  const { clientId } = sheetsConfig();
  if (!clientId) {
    setStatus(statusEl, 'OAuthクライアントIDを設定してください(⚙ 設定 → スプレッドシート)。', true);
    return false;
  }
  btnEl.disabled = true;
  try {
    const forceConsent = hasValidAccessToken();
    showLoading(statusEl, 'Googleログインを待っています...');
    await getAccessToken(clientId, { forceConsent });
    updateDailyAuthStatus();
    return true;
  } catch (e) {
    hideLoading(statusEl);
    setStatus(statusEl, e.message, true);
    return false;
  } finally {
    btnEl.disabled = false;
  }
}

async function onDailySignIn() {
  await signInToGoogle($('daily-auth-status'), $('daily-signin'));
}

/** ヘッダーのログインボタン(2026-07-30追加)。 */
async function onHeaderSignIn() {
  const status = $('header-auth-status');
  const ok = await signInToGoogle(status, $('header-signin'));
  // updateDailyAuthStatus()はdaily-auth-status側しか更新しないため、成功時の
  // メッセージはここで出す(失敗時はsignInToGoogle内でエラーを表示済み)。
  if (ok) setStatus(status, 'ログインしました。');
}

function onDailySignOut() {
  clearAccessToken();
  updateDailyAuthStatus();
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
 * 「🔄 今すぐ同期」ボタン。読み込み→マージ→ローカル反映→書き戻しを1回の
 * 操作で行う(pull-merge-pushを毎回まとめて行うことで、書き込みレースの窓を
 * 小さくする。真の同時書き込みは片桐一人が順番に端末を使う想定では
 * ほぼ起きない前提)。
 */
async function onSyncNow() {
  const status = $('sync-status');
  const btn = $('sync-now');
  const { clientId, spreadsheetId } = sheetsConfig();
  if (!clientId || !spreadsheetId) {
    setStatus(
      status,
      '⚙ 設定 → スプレッドシート で、クライアントID・スプレッドシートIDを設定してください。'
      + '(シート名の設定は同期には使いません)',
      true,
    );
    return;
  }

  btn.disabled = true;
  try {
    showLoading(status, 'Googleにログイン中...');
    const accessToken = await getAccessToken(clientId);
    updateDailyAuthStatus();

    showLoading(status, '同期データを読み込み中...');
    const remote = await readSyncState({ spreadsheetId, accessToken });

    const newState = {};
    const capacityLines = [];
    for (const spec of syncSpecs()) {
      const remoteItems = parseIdArray(remote[spec.itemsKey]);
      const remoteTombstoneIds = parseIdArray(remote[spec.tombKey]);
      const localTombstoneIds = loadTombstoneIds(spec.tombStorage);

      const merged = mergeStock(spec.get(), remoteItems, localTombstoneIds, remoteTombstoneIds);
      spec.set(merged.items);
      saveTombstoneIds(spec.tombStorage, merged.tombstoneIds);
      spec.render();

      const itemsJson = JSON.stringify(merged.items);
      const tombJson = JSON.stringify(merged.tombstoneIds);
      newState[spec.itemsKey] = itemsJson;
      newState[spec.tombKey] = tombJson;
      const percent = Math.max(capacityPercent(itemsJson), capacityPercent(tombJson));
      capacityLines.push(`${spec.label} ${percent}%`);
    }

    showLoading(status, 'シートへ書き込み中...');
    await writeSyncState({ spreadsheetId, accessToken, state: newState });

    hideLoading(status);
    setStatus(status, `同期しました。(セル容量使用率: ${capacityLines.join(' / ')})`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateDailyAuthStatus();
    }
  } finally {
    btn.disabled = false;
  }
}

/**
 * シート操作に必要なアクセストークンを取得する。設定漏れは分かりやすい
 * メッセージにして投げ直す(呼び出し側は catch して status に出すだけでよい)。
 */
async function requireSheetsAccess() {
  const cfg = sheetsConfig();
  if (!cfg.clientId || !cfg.spreadsheetId || !cfg.sheetName) {
    throw new SheetsAuthError(
      '⚙ 設定 → スプレッドシート で、クライアントID・スプレッドシートID・シート名を'
      + '設定してください。',
    );
  }
  const accessToken = await getAccessToken(cfg.clientId);
  updateDailyAuthStatus();
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
 * 「誤りなし」の行は④で除外されるため、一覧でもその旨を明示する。
 * 2026-07-29に、原文が重複している行の警告表示と、両方をチェックボックスで
 * 絞り込めるフィルター機能を追加した(フィルターは表示のみに影響し、
 * dailyPendingRows自体やシート側のデータは変更しない)。
 * 同日、3つ目のフィルターとして「出力済み(このブラウザで記録)を隠す」を
 * 追加した。シート側の「Anki出力済み」列マーク(④のチェックボックス)とは
 * 独立して、`.apkg`生成に成功した行を`dailyconv.addExportedIds()`で
 * ローカルに記録しており(`onDailyExport()`参照)、④のチェックボックスを
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
      updateDailyAuthStatus();
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
    $('daily-input').value = '';
    setStatus(status, `${newIds.length} 件をシートに追加しました。③の一覧を更新します...`);

    // デスクトップ版と同じく、追記に成功したらそのまま③の読み込みまで連鎖させる
    // (確認導線が上下バラバラになるのを避けるため)。
    await refreshDailyPending(null);

    // デスクトップ版の_generate_shuujuku_candidates_from_rowsと同じく、今回
    // シートに追記した行(「誤りなし」を除く)ごとに習熟用(音読)候補を自動生成
    // する(2026-07-29、片桐の指示で④の.apkgダウンロード時からこのタイミング
    // へ変更。デスクトップ版は直接入力→①への自動連鎖でこのタイミングに
    // 相当する挙動になっており、それに揃えた。「誤りなし」の行には
    // 抽出すべき「誤りの背景にある文法パターン」が無いため対象外)。
    const rowsForShuujuku = corrections
      .map((c, i) => ({
        id: newIds[i], original: c.original, corrected: c.corrected, explanation: c.explanation,
      }))
      .filter((_, i) => corrections[i].category !== '誤りなし');
    const shuujukuNote = await generateShuujukuCandidatesFromRows(rowsForShuujuku, status);

    setStatus(status, `${newIds.length} 件をシートに追加し、③の一覧を更新しました。${shuujukuNote}`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateDailyAuthStatus();
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
 * 引き続き③の一覧には出てこない(fetchPendingRowsが除外するため)。
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
 * `onDailyCorrect()`(②添削→シート追記の成功直後)から呼ぶ(2026-07-29、
 * 片桐の指示で④の.apkgダウンロード時からこのタイミングへ変更。デスクトップ版は
 * 直接入力→①シートから読み込むへの自動連鎖でこのタイミングに相当する挙動に
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
  for (let i = 0; i < rows.length; i += 1) {
    showLoading(status, `習熟用(音読)候補を生成中... (${i + 1}/${rows.length})`);
    try {
      const item = await generateShuujukuItemFromRow({
        row: rows[i], apiKey, model, promptTemplate: shared.shuujukuDailyconvPrompt,
      });
      const generatedAt = new Date().toISOString();
      items.push({ ...item, id: newSyncId(), generated_at: generatedAt, updated_at: generatedAt });
    } catch {
      failed += 1;
    }
  }

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
  if (dailyPendingRows.length === 0) {
    setStatus(status, '出力する行がありません。先に③でシートから読み込んでください。', true);
    return;
  }
  const cardDef = shared.cardDefs?.daily;
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  // build_grammar_dailyconv_v1_final.process_sheet_rows() と同じ除外
  // (「誤りなし」の行・ID重複行はカード化しない)。
  const { rows, duplicateIds } = dailyconv.processSheetRows(dailyPendingRows);
  if (rows.length === 0) {
    setStatus(
      status,
      '出力対象の行がありません。読み込んだ行はすべて「誤りなし」またはID重複のため'
      + '除外されました(誤りのある行だけがカード化の対象です)。',
      true,
    );
    return;
  }

  const btn = $('daily-export');
  btn.disabled = true;
  try {
    setStatus(status, '.apkg を生成中...');
    const readyItems = dailyconv.buildFieldsReadyItems(rows);
    // TTS APIキーが設定されていれば、Answer(添削後)とExample(類似表現)に
    // 音声を合成して埋め込む(未設定なら従来どおり音声無し)。
    const { items, media } = await embedTtsAudioIntoItems(
      readyItems, TTS_FIELD_KEYS.daily, 'daily', status,
    );
    const blob = await buildApkg({ cardDef, ankiSchema: shared.ankiSchema, items, media });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `daily_${stamp}.apkg`);

    // シート側の「Anki出力済み」列マーク(④のチェックボックス)とは独立に、
    // 「このブラウザで.apkgに含めて出力した」ことをローカルへ記録する
    // (チェックボックスがOFFでも必ず記録する。マークし忘れ・書き込み失敗
    // 時の保険、renderDailyPending()の「✓ 出力済み」タグ/フィルターが使う)。
    dailyconv.addExportedIds(rows.map((r) => r.id));
    renderDailyPending();

    let note = '';
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
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
    if (e instanceof SheetsAuthError) {
      clearAccessToken();
      updateDailyAuthStatus();
    }
  } finally {
    btn.disabled = false;
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

  const btnId = tabKey === 'word' ? 'word-export' : 'ai-ask-export';
  const btn = $(btnId);
  btn.disabled = true;
  try {
    setStatus(status, '.apkg を生成中...');
    // TTS APIキーが設定されていれば、対象フィールド(単語:Example、
    // AIに質問:Answer+Example)に音声を合成して埋め込む(未設定なら
    // 従来どおり音声無し。cfg.stock自体は変更しない、下記embedTtsAudioIntoItems参照)。
    const { items, media } = await embedTtsAudioIntoItems(
      pendingItems, TTS_FIELD_KEYS[tabKey] || [], tabKey, status,
    );
    const blob = await buildApkg({
      cardDef,
      ankiSchema: shared.ankiSchema,
      items,
      media,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `${tabKey}_${stamp}.apkg`);

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
    btn.disabled = false;
  }
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
}
