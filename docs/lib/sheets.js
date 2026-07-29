// sheets.js
// ---------------------------------------------------------------------------
// 「添削結果」スプレッドシートの読み書きを、ブラウザから直接行う。
// デスクトップ版の sheets_reader.py / sheets_writer.py に対応する Web 版。
//
// 【認証方式(2026-07-29、片桐が選択)】
// Google Identity Services (GIS) の **token client**(`initTokenClient`)を使う。
//
// デスクトップ版はサービスアカウント(JSON秘密鍵)方式だが、その鍵をブラウザに
// 置くことは絶対にできない(鍵を持つ者は誰でもシートを自由に読み書きできる)。
// またCLAUDE.mdには当初「OAuth 2.0 (PKCE)」と書かれていたが、Googleの
// 「ウェブアプリケーション」型クライアントは認可コード→トークン交換に
// client_secret を要求するため、静的サイトだけではPKCEを完結できない。
// client_secret 不要でバックエンドも不要な唯一の正規ルートが token client。
//
// - 利用者がページ上でOAuthクライアントIDを入力し localStorage に保存する
//   (APIキーと同じ方針。**クライアントIDは秘密情報ではない**ので公開ページに
//   置いても問題ないが、片桐以外が使う場合に備えて設定項目にしてある)
// - アクセストークンは**メモリ上にのみ**保持する(localStorage に置くと
//   XSS で持ち出されうるため)。有効期限は約1時間で、切れたら再取得する。
//   リフレッシュトークンはこの方式では発行されない。
// - 一度同意していれば `prompt: ''` での再取得は基本的に無操作で通る
//   (同意画面が再表示されるのは初回のみ)。
//
// 【必要なスコープ】
// 読み取り(未出力行の取得)と書き込み(添削結果の追記・Anki出力済みのマーク)の
// 両方を行うため、readonly ではなく spreadsheets を要求する。

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Sheets API 呼び出し全般の失敗。 */
export class SheetsError extends Error {}

/** ログインし直せば解決する失敗(未ログイン・トークン失効・権限不足)。 */
export class SheetsAuthError extends SheetsError {}

// ---------------------------------------------------------------------------
// 認証(Google Identity Services token client)
// ---------------------------------------------------------------------------

let gisScriptPromise = null;
let tokenClient = null;
let tokenClientId = null;
let accessToken = null;
let accessTokenExpiresAt = 0;

// 有効期限ぎりぎりのトークンで実行すると、通信中に切れて401になるため、
// 期限の1分前には切れたものとして扱う。
const EXPIRY_MARGIN_MS = 60 * 1000;

/** GIS のスクリプトを一度だけ読み込む。 */
function loadGisScript() {
  if (gisScriptPromise) return gisScriptPromise;
  gisScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve();
      else reject(new SheetsAuthError('Googleログイン用ライブラリを初期化できませんでした。'));
    };
    script.onerror = () => reject(new SheetsAuthError(
      'Googleログイン用ライブラリ(accounts.google.com/gsi/client)を読み込めませんでした。'
      + 'ネットワーク接続や広告ブロッカーの設定を確認してください。',
    ));
    document.head.appendChild(script);
  });
  return gisScriptPromise;
}

/**
 * token client を用意する(クライアントIDが変わった場合は作り直す)。
 * @param {string} clientId OAuth 2.0 クライアントID(ウェブアプリケーション)
 */
async function ensureTokenClient(clientId) {
  if (!clientId) {
    throw new SheetsAuthError(
      'GoogleのOAuthクライアントIDが設定されていません(⚙ 設定 → スプレッドシート)。',
    );
  }
  await loadGisScript();
  if (tokenClient && tokenClientId === clientId) return tokenClient;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SHEETS_SCOPE,
    // コールバックは requestToken() のたびに差し替える(Promise を解決するため)。
    callback: () => {},
  });
  tokenClientId = clientId;
  return tokenClient;
}

/**
 * 実際にトークンを要求する。
 * @param {string} clientId
 * @param {''|'consent'} prompt '' なら同意済みの場合は無操作で通る
 */
function requestToken(clientId, prompt) {
  return new Promise((resolve, reject) => {
    ensureTokenClient(clientId).then((client) => {
      client.callback = (response) => {
        if (response.error) {
          reject(new SheetsAuthError(
            `Googleログインに失敗しました: ${response.error_description || response.error}`,
          ));
          return;
        }
        accessToken = response.access_token;
        // expires_in は秒。省略された場合は控えめに30分とみなす。
        const expiresInSec = Number(response.expires_in) || 1800;
        accessTokenExpiresAt = Date.now() + expiresInSec * 1000;
        resolve(accessToken);
      };
      client.error_callback = (err) => {
        reject(new SheetsAuthError(
          `Googleログインを完了できませんでした: ${err?.type || err?.message || err}`,
        ));
      };
      client.requestAccessToken({ prompt });
    }).catch(reject);
  });
}

/** 今保持しているアクセストークンがまだ使えるか。 */
export function hasValidAccessToken() {
  return Boolean(accessToken) && Date.now() < accessTokenExpiresAt - EXPIRY_MARGIN_MS;
}

/** 保持しているトークンを破棄する(ログアウト相当。同意自体は取り消さない)。 */
export function clearAccessToken() {
  accessToken = null;
  accessTokenExpiresAt = 0;
}

/**
 * 有効なアクセストークンを返す。保持しているものが使えればそれを返し、
 * 無ければ取得しに行く。
 *
 * @param {string} clientId
 * @param {object} [opts]
 * @param {boolean} [opts.forceConsent] true なら必ず同意画面を出す
 *   (「ログイン」ボタンから明示的に押された場合に使う)
 */
export async function getAccessToken(clientId, { forceConsent = false } = {}) {
  if (!forceConsent && hasValidAccessToken()) return accessToken;
  return requestToken(clientId, forceConsent ? 'consent' : '');
}

// ---------------------------------------------------------------------------
// Sheets API 呼び出しの共通処理
// ---------------------------------------------------------------------------

/** シート名など、A1表記に含める文字列をURLに載せられる形にする。 */
function encodeRange(range) {
  return encodeURIComponent(range);
}

/** 0始まりの列インデックスをA1表記の列名にする(sheets_writer._col_letter と同じ)。 */
export function colLetter(index) {
  let letters = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    n = Math.floor((n - 1) / 26);
    letters = String.fromCharCode(65 + remainder) + letters;
  }
  return letters;
}

/** 失敗理由を、利用者が対処できる日本語の説明にする(判定できなければ null)。 */
function describeSheetsError(status, detail) {
  const n = (detail || '').replace(/[\s_-]/g, '').toLowerCase();

  if (status === 401) {
    return 'Googleのログイン(アクセストークン)が期限切れです。「Googleにログイン」を押し直してください。';
  }
  if (status === 403) {
    if (n.includes('servicedisabled') || n.includes('hasnotbeenused')) {
      return 'このプロジェクトで Google Sheets API が有効化されていません。\n'
        + 'Google Cloud Console の「APIとサービス → ライブラリ」で有効にしてください。';
    }
    if (n.includes('insufficient') || n.includes('permission')) {
      return 'このGoogleアカウントには、対象のスプレッドシートを編集する権限がありません。\n'
        + 'シートの共有設定と、ログインしたアカウントを確認してください。';
    }
    return 'スプレッドシートへのアクセスが拒否されました(403)。';
  }
  if (status === 404) {
    return 'スプレッドシートが見つかりません。⚙ 設定のスプレッドシートIDを確認してください。';
  }
  if (status === 400 && (n.includes('unabletoparserange') || n.includes('range'))) {
    return 'シート(タブ)名が見つかりません。⚙ 設定のシート名を確認してください。';
  }
  return null;
}

async function sheetsFetch(url, accessTokenValue, init = {}) {
  if (!accessTokenValue) {
    throw new SheetsAuthError('Googleにログインしていません。');
  }
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessTokenValue}`,
        'Content-Type': 'application/json; charset=utf-8',
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    throw new SheetsError(`スプレッドシートへの通信に失敗しました: ${e.message}`);
  }

  if (!res.ok) {
    const detail = await res.text();
    const described = describeSheetsError(res.status, detail);
    const message = described
      ? `${described}\n\n詳細: ${detail}`
      : `スプレッドシートの操作に失敗しました(HTTP ${res.status}): ${detail}`;
    throw res.status === 401 ? new SheetsAuthError(message) : new SheetsError(message);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 読み取り(sheets_reader.py の移植)
// ---------------------------------------------------------------------------

/** _split_multiline() と同一。 */
function splitMultiline(cell) {
  return String(cell ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

/** _to_int_or_none() と同一(空欄・数値でないものは null)。 */
function toIntOrNull(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * 「Anki出力済み」列が空の行だけを取得する
 * (sheets_reader.fetch_pending_rows() と同一の戻り値形式 + created_at)。
 *
 * `created_at` はシートの「日時」列をそのまま文字列で返す(デスクトップ版の
 * sheets_reader.fetch_pending_rows() は持たない、Web版のみの追加項目。
 * 一覧に生成日時を表示するために2026-07-29に追加した)。
 *
 * @returns {Promise<object[]>} id/created_at/original/corrected/... を持つ行の配列
 */
export async function fetchPendingRows({
  spreadsheetId,
  sheetName,
  accessToken: token,
  idColumnName = 'ID',
  exportedColumnName = 'Anki出力済み',
}) {
  if (!spreadsheetId) throw new SheetsError('スプレッドシートIDが設定されていません(⚙ 設定)。');
  if (!sheetName) throw new SheetsError('シート(タブ)名が設定されていません(⚙ 設定)。');

  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(sheetName)}`;
  const data = await sheetsFetch(url, token);

  const values = data.values || [];
  if (values.length === 0) return [];

  const headers = values[0].map((h) => String(h ?? ''));
  if (!headers.includes(idColumnName)) {
    throw new SheetsError(`ヘッダーに「${idColumnName}」列が見つかりません: ${headers.join(', ')}`);
  }
  if (!headers.includes(exportedColumnName)) {
    throw new SheetsError(`ヘッダーに「${exportedColumnName}」列が見つかりません: ${headers.join(', ')}`);
  }

  const rows = [];
  for (const rawRow of values.slice(1)) {
    // 末尾の空セルは配列から省略されるため、ヘッダー数まで空文字で埋める
    const record = {};
    headers.forEach((h, i) => { record[h] = String(rawRow[i] ?? ''); });

    if (!record[idColumnName].trim()) continue;      // ID空欄の行(末尾の空行など)
    if (record[exportedColumnName].trim()) continue; // 既にAnki出力済みの行

    rows.push({
      id: record.ID.trim(),
      created_at: record['日時'] ?? '',
      original: record['原文'] ?? '',
      corrected: record['添削後'] ?? '',
      explanation: record['解説'] ?? '',
      category: record['カテゴリ'] ?? '',
      similar_en_list: splitMultiline(record['類似表現(英文)']),
      similar_ja_list: splitMultiline(record['類似表現(解説)']),
      grammar_score: toIntOrNull(record['文法スコア']),
      naturalness_score: toIntOrNull(record['自然さスコア']),
      comprehensibility_score: toIntOrNull(record['伝わりやすさスコア']),
      score_comment: record['スコア解説'] ?? '',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 書き込み(sheets_writer.py の移植)
// ---------------------------------------------------------------------------

/** ヘッダー行(1行目)だけを取得する。 */
async function fetchHeaders(spreadsheetId, sheetName, token) {
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(`${sheetName}!1:1`)}`;
  const data = await sheetsFetch(url, token);
  return (data.values?.[0] || []).map((h) => String(h ?? ''));
}

/** sheets_writer._CORRECTION_COLUMN_BUILDERS と同一(ヘッダー名 → 値)。 */
const CORRECTION_COLUMN_BUILDERS = {
  ID: (c, rowId) => rowId,
  日時: (c, rowId, nowStr) => nowStr,
  原文: (c) => c.original || '',
  添削後: (c) => c.corrected || '',
  解説: (c) => c.explanation || '',
  カテゴリ: (c) => c.category || '',
  '類似表現(英文)': (c) => (c.similar_expressions || []).map((s) => s.expression || '').join('\n'),
  '類似表現(解説)': (c) => (c.similar_expressions || []).map((s) => s.note || '').join('\n'),
  文法スコア: (c) => c.grammar_score ?? '',
  自然さスコア: (c) => c.naturalness_score ?? '',
  伝わりやすさスコア: (c) => c.comprehensibility_score ?? '',
  スコア解説: (c) => c.score_comment || '',
  Anki出力済み: () => '',
};

/** Apps Script の Utilities.getUuid() / Python の uuid4() に相当する新規ID。 */
function newRowId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // crypto.randomUUID が使えない環境(古いブラウザ・jsdom)向けのフォールバック
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** sheets_writer の datetime.now().strftime("%Y-%m-%d %H:%M:%S") と同じ形式。 */
function nowString(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * 添削結果(gemini.correctEnglishText() の戻り値)をシートに新規行として追記する
 * (sheets_writer.append_correction_rows() の移植)。
 *
 * 列の並びはシートの実ヘッダー行を読み取って動的に対応させる
 * (固定の列順を決め打ちしない = 手元でシートの列を並べ替えていても壊れない)。
 *
 * @returns {Promise<string[]>} 追記した各行のID列の値
 */
export async function appendCorrectionRows({
  spreadsheetId, sheetName, corrections, accessToken: token,
}) {
  if (!corrections || corrections.length === 0) return [];

  const headers = await fetchHeaders(spreadsheetId, sheetName, token);
  if (headers.length === 0) {
    throw new SheetsError(`シート「${sheetName}」のヘッダー行が空です。`);
  }

  const nowStr = nowString();
  const newIds = [];
  const values = corrections.map((c) => {
    const rowId = newRowId();
    newIds.push(rowId);
    return headers.map((header) => {
      const builder = CORRECTION_COLUMN_BUILDERS[header];
      return builder ? builder(c, rowId, nowStr) : '';
    });
  });

  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(sheetName)}:append`
    + '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
  await sheetsFetch(url, token, { method: 'POST', body: JSON.stringify({ values }) });
  return newIds;
}

/**
 * 指定した行ID(ID列の値)に対応する「Anki出力済み」列に、書き込み時刻を書く
 * (sheets_writer.mark_rows_as_exported() の移植)。他の列には一切触れない。
 *
 * @returns {Promise<{succeeded: string[], failed: string[]}>}
 *   failed は ID列に見つからなかった行ID。
 */
export async function markRowsAsExported({
  spreadsheetId,
  sheetName,
  rowIds,
  accessToken: token,
  idColumnName = 'ID',
  exportedColumnName = 'Anki出力済み',
}) {
  if (!rowIds || rowIds.length === 0) return { succeeded: [], failed: [] };

  const headers = await fetchHeaders(spreadsheetId, sheetName, token);
  const idColIdx = headers.indexOf(idColumnName);
  if (idColIdx === -1) {
    throw new SheetsError(`ヘッダーに「${idColumnName}」列が見つかりません: ${headers.join(', ')}`);
  }
  const exportedColIdx = headers.indexOf(exportedColumnName);
  if (exportedColIdx === -1) {
    throw new SheetsError(`ヘッダーに「${exportedColumnName}」列が見つかりません: ${headers.join(', ')}`);
  }

  const idColLetter = colLetter(idColIdx);
  const idUrl = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}`
    + `/values/${encodeRange(`${sheetName}!${idColLetter}2:${idColLetter}`)}`;
  const idData = await sheetsFetch(idUrl, token);
  const idValues = idData.values || [];

  const wanted = new Set(rowIds);
  const rowNumberById = new Map();
  idValues.forEach((row, offset) => {
    const value = String(row?.[0] ?? '');
    // 1行目はヘッダーなのでデータは2行目始まり
    if (wanted.has(value)) rowNumberById.set(value, offset + 2);
  });

  const exportedColLetter = colLetter(exportedColIdx);
  const timestamp = nowString();
  const data = [];
  const succeeded = [];
  for (const [rowId, rowNumber] of rowNumberById) {
    data.push({
      range: `${sheetName}!${exportedColLetter}${rowNumber}`,
      values: [[timestamp]],
    });
    succeeded.push(rowId);
  }
  const failed = rowIds.filter((rid) => !rowNumberById.has(rid));

  if (data.length > 0) {
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`;
    await sheetsFetch(url, token, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
  }
  return { succeeded, failed };
}

// ---------------------------------------------------------------------------
// 複数端末間の同期(2026-07-30追加)
// ---------------------------------------------------------------------------
//
// 「添削結果」スプレッドシート内に、片桐の目に触れない隠しタブ(_AppSync)を
// 追加し、単語/AIに質問/習熟用の3ストックをJSONとして保存する。既に使っている
// `spreadsheets` スコープのGoogleログインをそのまま流用できる(Drive APIへの
// スコープ追加・再同意は不要)。マージ(和集合+打ち消し記録)のロジック自体は
// docs/lib/sync.js が持ち、ここは純粋にSheets APIとの読み書きだけを担当する。

/** 同期用の隠しタブのシート名。 */
export const SYNC_SHEET_NAME = '_AppSync';

/** 各行のキー(A列)。B列に対応するJSON文字列を保存する(行の順序は固定)。 */
export const SYNC_ROW_KEYS = [
  'word_stock_items', 'word_stock_tombstones',
  'ai_ask_stock_items', 'ai_ask_stock_tombstones',
  'shuujuku_stock_items', 'shuujuku_stock_tombstones',
];

/** `_AppSync` タブが無ければ、片桐の目に触れない隠しタブとして作成する。 */
async function ensureSyncSheetExists(spreadsheetId, token) {
  const metaUrl = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
  const meta = await sheetsFetch(metaUrl, token);
  const titles = (meta.sheets || []).map((s) => s.properties?.title);
  if (titles.includes(SYNC_SHEET_NAME)) return;

  const batchUrl = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
  await sheetsFetch(batchUrl, token, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: SYNC_SHEET_NAME, hidden: true } } }],
    }),
  });
}

/**
 * 同期用の隠しタブから、3ストック分のitems/tombstonesをまとめて読む
 * (タブが無ければ自動作成した上で、中身は空として返す)。
 * @returns {Promise<Record<string, string>>} SYNC_ROW_KEYS をキーにしたJSON文字列
 *   (未保存の行は空文字)
 */
export async function readSyncState({ spreadsheetId, accessToken: token }) {
  await ensureSyncSheetExists(spreadsheetId, token);
  const range = `${SYNC_SHEET_NAME}!A1:B${SYNC_ROW_KEYS.length}`;
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}`;
  const data = await sheetsFetch(url, token);
  const values = data.values || [];
  const out = {};
  SYNC_ROW_KEYS.forEach((key, i) => { out[key] = values[i]?.[1] || ''; });
  return out;
}

/**
 * マージ済みの3ストック分をまとめて隠しタブへ書き戻す(A1:B{N}の範囲を
 * まるごと上書きする1回のAPI呼び出しで済ませ、往復回数・競合の窓を減らす)。
 * @param {Record<string, string>} state SYNC_ROW_KEYS をキーにしたJSON文字列
 */
export async function writeSyncState({ spreadsheetId, accessToken: token, state }) {
  await ensureSyncSheetExists(spreadsheetId, token);
  const range = `${SYNC_SHEET_NAME}!A1:B${SYNC_ROW_KEYS.length}`;
  const values = SYNC_ROW_KEYS.map((key) => [key, state[key] || '']);
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}`
    + '?valueInputOption=RAW';
  await sheetsFetch(url, token, { method: 'PUT', body: JSON.stringify({ values }) });
}
