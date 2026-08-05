// sheets.js
// ---------------------------------------------------------------------------
// 「添削結果」スプレッドシートの読み書きを、ブラウザから直接行う。
// デスクトップ版の sheets_reader.py / sheets_writer.py に対応する Web 版。
//
// 【認証方式】
// 次の2方式を持ち、⚙設定の「ログイン維持用 Worker の URL」が設定されているか
// どうかで自動的に切り替わる。
//
//   (A) 認可コードフロー + PKCE + リフレッシュトークン … Worker URL を設定済み
//       (2026-08-05追加、既定の推奨方式)
//   (B) Google Identity Services (GIS) の token client … Worker URL が空
//       (2026-07-29からの従来方式、フォールバックとして残してある)
//
// デスクトップ版はサービスアカウント(JSON秘密鍵)方式だが、その鍵をブラウザに
// 置くことは絶対にできない(鍵を持つ者は誰でもシートを自由に読み書きできる)ため、
// Web版はどちらの方式でも「片桐自身のGoogleアカウントでログインしてもらう」形を取る。
//
// --- (B) を最初に選んだ理由と、その限界 ---
// Googleの「ウェブ アプリケーション」型クライアントは認可コード→トークン交換に
// client_secret を要求し、それを公開ページのJavaScriptに置くことはできない。
// client_secret もバックエンドも不要な唯一の正規ルートが token client だったため
// 当初これを採用したが、**この方式は仕様上リフレッシュトークンが発行されない**。
// そのためアクセストークンの寿命(約1時間)が切れるたびに実質ログインし直しになり、
// 「1時間しか持たない」という不便が残っていた。
//
// --- (A) の構成 ---
// client_secret を預かるだけの小さな中継(Cloudflare Worker、リポジトリの
// `worker/` を参照)を置くことで認可コードフローが使えるようになり、
// リフレッシュトークンを受け取れる。これにより、アクセストークンが切れても
// 利用者の操作なしに裏で取り直せる(= ログインが長持ちする)。
//   1. ログインボタン → Googleの同意画面へページ遷移(PKCE付き)
//   2. `?code=...` を付けてこのページへ戻ってくる
//   3. code を Worker の /token へ送り、アクセストークン + リフレッシュトークンを得る
//   4. 以降、アクセストークンが切れたら Worker の /refresh で無言で再取得する
//
// --- トークンの保管場所 ---
// - アクセストークン: **メモリ上のみ**(どちらの方式でも共通)。
// - リフレッシュトークン: localStorage((A)のみ)。ページを閉じても
//   ログインを保つには永続化が避けられないための判断で、XSS で持ち出されうる
//   というトレードオフは受け入れている(このページは外部からの入力を
//   innerHTML に流し込まない作りであること・片桐本人しか使わないことが前提)。
//   ログアウト(`signOut()`)で明示的に破棄できる。
// - 同意画面が「テスト」ステータスのままの場合、Googleの仕様でリフレッシュ
//   トークンは7日で失効する(その場合は再ログインが必要。詳細は worker/README.md)。
//
// 【必要なスコープ】
// 読み取り(未出力行の取得)と書き込み(添削結果の追記・Anki出力済みのマーク)の
// 両方を行うため、readonly ではなく spreadsheets を要求する。

// 同期データの分割保存(2026-08-05)。1キーの値が1セルの上限(50,000文字)を
// 超えても書けるよう、B列以降へチャンクに分けて並べる。定数と分割・連結の
// 処理そのものは sync.js が持つ(このファイルは Sheets API との入出力だけを担う)。
import { splitIntoChunks, joinChunks, SYNC_MAX_CHUNKS } from './sync.js';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * 実際にログインで要求するスコープ(2026-08-05に `openid email` を追加)。
 *
 * `openid email` が必要なのは、Worker の `GET /appconfig` が
 * 「呼んでいるのが片桐本人か」をメールアドレスで確かめるため
 * (worker/src/index.js の verifyAccessToken を参照)。これが無いと
 * Google の tokeninfo がメールアドレスを返さず、本人確認ができない。
 *
 * **スコープを増やすと同意画面がもう一度出る**(既存のリフレッシュトークンは
 * 古いスコープのまま)。これは追加時の一度きり。
 */
export const OAUTH_SCOPE = `openid email ${SHEETS_SCOPE}`;

/** リフレッシュトークンの保存先(localStorage)。 */
const REFRESH_TOKEN_KEY = 'anki_tool_google_refresh_token';
/** 認可コードフローの途中経過(PKCEのcode_verifier・state)の保存先。 */
const PKCE_STATE_KEY = 'anki_tool_oauth_pkce';

/** Sheets API 呼び出し全般の失敗。 */
export class SheetsError extends Error {}

/** ログインし直せば解決する失敗(未ログイン・トークン失効・権限不足)。 */
export class SheetsAuthError extends SheetsError {}

// ---------------------------------------------------------------------------
// 認証(共通の状態)
// ---------------------------------------------------------------------------

let gisScriptPromise = null;
let tokenClient = null;
let tokenClientId = null;
let accessToken = null;
let accessTokenExpiresAt = 0;

/**
 * 直近の `getAccessToken()` に渡された認証オプション(workerUrl / clientId)。
 *
 * `sheetsFetch()` が 401 を受けたときに、その場でトークンを取り直して1回だけ
 * 自動リトライするために保持している(2026-08-05追加)。Worker方式は
 * リフレッシュトークンを持っているのに、以前は 401 のたびに利用者へ手動の
 * 再操作を求めており、「ログインが長持ちする」という本来の狙いが
 * 実現できていなかった。
 */
let lastAuthOptions = null;

// 有効期限ぎりぎりのトークンで実行すると、通信中に切れて401になるため、
// 期限の1分前には切れたものとして扱う。
const EXPIRY_MARGIN_MS = 60 * 1000;

/** 末尾スラッシュを落とした Worker の URL(未設定なら空文字)。 */
function normalizeWorkerUrl(workerUrl) {
  return String(workerUrl || '').trim().replace(/\/+$/, '');
}

/** アクセストークンを受け取ったときの共通処理(メモリへ保持する)。 */
function storeAccessToken(token, expiresInSec) {
  accessToken = token;
  // expires_in は秒。省略された場合は控えめに30分とみなす。
  const seconds = Number(expiresInSec) || 1800;
  accessTokenExpiresAt = Date.now() + seconds * 1000;
  return accessToken;
}

// ---------------------------------------------------------------------------
// 認証(A) 認可コードフロー + PKCE + リフレッシュトークン(2026-08-05追加)
// ---------------------------------------------------------------------------

/** 保存済みのリフレッシュトークン(無ければ null)。 */
export function getStoredRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function setStoredRefreshToken(token) {
  try {
    if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* プライベートブラウジング等で localStorage が使えない場合は諦める */
  }
}

/** ランダムなURLセーフ文字列(PKCEのcode_verifier・stateに使う)。 */
function randomUrlSafeString(byteLength = 48) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Uint8Array/ArrayBuffer を base64url(パディング無し)にする。 */
function base64UrlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE の code_challenge(S256)を作る。 */
async function makeCodeChallenge(codeVerifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(digest);
}

/**
 * リダイレクトURI。Google Cloud Console の「承認済みのリダイレクト URI」に
 * **完全一致で**登録しておく必要がある(worker/README.md 参照)。
 * クエリ・ハッシュを落とした「今開いているページ」そのものを使う。
 */
export function redirectUri() {
  return window.location.origin + window.location.pathname;
}

/**
 * Worker のエンドポイントを叩く共通処理。
 * @param {string} failureLabel 失敗時のメッセージ先頭に付ける説明
 *   (エンドポイントごとに何をしようとして失敗したのかが分かるようにするため)
 */
async function workerFetch(workerUrl, path, init, failureLabel = 'Googleのトークン取得') {
  const base = normalizeWorkerUrl(workerUrl);
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (e) {
    throw new SheetsAuthError(
      `ログイン維持用 Worker (${base}) へ接続できませんでした: ${e.message}\n`
      + 'URLが正しいか、Workerがデプロイ済みかを確認してください'
      + '(⚙ 設定 → スプレッドシート)。',
    );
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new SheetsAuthError(`Workerからの応答を解釈できませんでした: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = new SheetsAuthError(
      `${failureLabel}に失敗しました: ${data?.error || res.status}`
      + (data?.detail ? `\n\n詳細: ${data.detail}` : ''),
    );
    // invalid_grant = リフレッシュトークンが失効・取り消された。呼び出し側が
    // 「保存済みトークンを捨てて再ログインを促す」判断に使う。
    err.code = data?.error || null;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Worker から**アプリの設定一式**を受け取る(2026-08-05追加)。
 *
 * 【なぜ】新しいPC・スマホで使い始めるたびに、APIキー・スプレッドシートIDなど
 * 8項目を手入力する必要があった。これらを Worker のシークレットに集約し、
 * ログイン後に配ってもらうことで「開いてログインするだけ」で使えるようにする。
 *
 * このエンドポイントは秘密情報(APIキー)を返すため、Worker 側が
 * アクセストークンを Google の tokeninfo で検証し、**片桐本人のトークンで
 * あることを確かめてから**返す(worker/src/index.js の verifyAccessToken)。
 * そのため呼び出しにはログイン済みのアクセストークンが要る。
 *
 * @returns {Promise<{spreadsheet_id: string|null, sheet_name: string|null,
 *                    gemini_api_key: string|null, tts_api_key: string|null}>}
 *   Worker 側で未登録の項目は null。呼び出し側は**null の項目を反映しない**こと
 *   (端末で手入力した値を消してしまわないため)。
 */
export async function fetchAppConfig(workerUrl, accessTokenValue) {
  if (!normalizeWorkerUrl(workerUrl)) {
    throw new SheetsAuthError('ログイン維持用 Worker の URL が設定されていません。');
  }
  if (!accessTokenValue) {
    throw new SheetsAuthError('Googleにログインしていません。');
  }
  return workerFetch(workerUrl, '/appconfig', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessTokenValue}` },
  }, 'Workerからの設定の取得');
}

/** Worker から client_id を受け取る(Workerを使う場合、これが唯一の出所)。 */
export async function fetchWorkerClientId(workerUrl) {
  const data = await workerFetch(workerUrl, '/config', { method: 'GET' });
  if (!data?.client_id) {
    throw new SheetsAuthError('WorkerからクライアントIDを取得できませんでした(Worker側の設定を確認してください)。');
  }
  return data.client_id;
}

/**
 * Googleの同意画面へページ遷移する(認可コードフローの開始)。
 * この関数は戻ってこない(遷移する)。
 *
 * `access_type=offline` + `prompt=consent` の両方が揃っていないと、
 * Googleはリフレッシュトークンを返さない(2回目以降の同意では省略される)。
 */
export async function beginAuthCodeFlow(workerUrl) {
  const clientId = await fetchWorkerClientId(workerUrl);
  const codeVerifier = randomUrlSafeString();
  const state = randomUrlSafeString(16);
  const uri = redirectUri();

  // リダイレクトでページが作り直されるため、照合用の値を残しておく。
  // sessionStorage はタブを閉じると消えるので、この用途には十分。
  sessionStorage.setItem(PKCE_STATE_KEY, JSON.stringify({
    codeVerifier, state, redirectUri: uri, workerUrl: normalizeWorkerUrl(workerUrl),
  }));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: uri,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: await makeCodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`);
}

/**
 * 同意画面から戻ってきた直後に呼ぶ。URLに `code` が付いていれば
 * トークン交換まで済ませ、URLからクエリを掃除する。
 *
 * @returns {Promise<{handled: boolean, error?: string}>}
 *   handled=false なら「戻ってきた直後ではない」= 通常の起動。
 */
export async function completeAuthCodeFlowIfReturning() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return { handled: false };

  const rawSaved = sessionStorage.getItem(PKCE_STATE_KEY);
  sessionStorage.removeItem(PKCE_STATE_KEY);
  // 認可コードはURLに残すと再読み込みで二重に使われる(=エラーになる)ため、
  // 成否にかかわらず必ず消す。
  cleanAuthParamsFromUrl();

  if (error) {
    return { handled: true, error: `Googleログインが中断されました: ${params.get('error_description') || error}` };
  }

  let saved = null;
  try {
    saved = rawSaved ? JSON.parse(rawSaved) : null;
  } catch {
    saved = null;
  }
  if (!saved?.codeVerifier) {
    return { handled: true, error: 'ログインの途中経過が見つかりませんでした。もう一度ログインしてください。' };
  }
  if (saved.state !== params.get('state')) {
    // state 不一致は CSRF の可能性。黙って通さない。
    return { handled: true, error: 'ログインの照合に失敗しました(state不一致)。もう一度ログインしてください。' };
  }

  try {
    const data = await workerFetch(saved.workerUrl, '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: saved.codeVerifier,
        redirect_uri: saved.redirectUri,
      }),
    });
    storeAccessToken(data.access_token, data.expires_in);
    if (data.refresh_token) setStoredRefreshToken(data.refresh_token);
    return { handled: true };
  } catch (e) {
    return { handled: true, error: e.message };
  }
}

/** URL から code/state/error/scope 等の認可パラメータを取り除く。 */
function cleanAuthParamsFromUrl() {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'error', 'error_description', 'scope', 'authuser', 'prompt', 'hd']) {
    url.searchParams.delete(key);
  }
  const search = url.searchParams.toString();
  window.history.replaceState(
    {}, '', url.pathname + (search ? `?${search}` : '') + url.hash,
  );
}

/**
 * リフレッシュトークンで新しいアクセストークンを取り直す(利用者の操作は不要)。
 * 失効していた場合は保存済みトークンを破棄したうえで例外を投げる。
 */
async function refreshAccessToken(workerUrl) {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    throw new SheetsAuthError('Googleにログインしていません。「Googleにログイン」を押してください。');
  }
  try {
    const data = await workerFetch(workerUrl, '/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return storeAccessToken(data.access_token, data.expires_in);
  } catch (e) {
    if (e.code === 'invalid_grant') {
      setStoredRefreshToken(null);
      throw new SheetsAuthError(
        'Googleログインの有効期限が切れました(または利用者がアクセスを取り消しました)。\n'
        + 'もう一度「Googleにログイン」を押してください。\n'
        + '※ OAuth同意画面が「テスト」ステータスのままだと、Googleの仕様で7日ごとに'
        + 'ログインし直しが必要です(worker/README.md 参照)。',
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 認証(B) Google Identity Services token client(Worker 未設定時のフォールバック)
// ---------------------------------------------------------------------------

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
    scope: OAUTH_SCOPE,
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
        resolve(storeAccessToken(response.access_token, response.expires_in));
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

// ---------------------------------------------------------------------------
// 認証(共通の入口)
// ---------------------------------------------------------------------------

/** 今保持しているアクセストークンがまだ使えるか。 */
export function hasValidAccessToken() {
  return Boolean(accessToken) && Date.now() < accessTokenExpiresAt - EXPIRY_MARGIN_MS;
}

/**
 * 「利用者から見てログイン済みか」。
 *
 * リフレッシュトークンを持っていれば、アクセストークンが手元に無くても
 * (ページを開き直した直後など)無操作で取り直せるためログイン済みとみなす。
 *
 * @param {object} [opts]
 * @param {string} [opts.workerUrl] 現在の Worker URL。**渡すこと**
 *   (2026-08-05追加)。渡さないと、Worker URL を消した/変えた後に残っている
 *   リフレッシュトークンだけで「ログイン済み」と表示してしまう
 *   ——実際には従来方式(B)へ落ちるので、ヘッダーの表示と実際の挙動が食い違う。
 *   リフレッシュトークンは Worker 経由でしか使えないため、Worker URL が
 *   空のときはアクセストークンの有無だけで判定する。
 */
export function isSignedIn({ workerUrl = null } = {}) {
  if (hasValidAccessToken()) return true;
  // workerUrl を渡さない旧来の呼び出しは、従来どおり保存済みトークンの有無で
  // 判定する(後方互換。呼び出し側は順次 workerUrl を渡すようにしてある)。
  if (workerUrl === null) return Boolean(getStoredRefreshToken());
  return Boolean(normalizeWorkerUrl(workerUrl) && getStoredRefreshToken());
}

/**
 * 手元のアクセストークンだけを破棄する(リフレッシュトークンは残す)。
 * 401 を受けたときに「次回は取り直す」ためのもので、ログアウトではない。
 */
export function clearAccessToken() {
  accessToken = null;
  accessTokenExpiresAt = 0;
}

/**
 * ログアウト。アクセストークンに加えて保存済みのリフレッシュトークンも捨てる
 * (Google側の同意そのものは取り消さないため、次回のログインは同意画面を
 * 通るだけで済む)。
 */
export function signOut() {
  clearAccessToken();
  setStoredRefreshToken(null);
}

/**
 * 有効なアクセストークンを返す。保持しているものが使えればそれを返し、
 * 無ければ取得しに行く。
 *
 * Worker URL が設定されていればリフレッシュトークン方式(A)、空なら従来の
 * GIS token client 方式(B)で動く。
 *
 * @param {object} opts
 * @param {string} [opts.clientId]  (B) 用の OAuth クライアントID
 * @param {string} [opts.workerUrl] (A) 用の Worker URL。設定時は (A) を使う
 * @param {boolean} [opts.forceConsent] (B) で必ず同意画面を出す
 *   (「ログイン」ボタンから明示的に押された場合に使う)
 */
export async function getAccessToken({ clientId = '', workerUrl = '', forceConsent = false } = {}) {
  // 401 を受けたときに sheetsFetch() が同じ条件で取り直せるよう覚えておく。
  lastAuthOptions = { clientId, workerUrl };
  if (hasValidAccessToken() && !forceConsent) return accessToken;

  if (normalizeWorkerUrl(workerUrl)) {
    // (A) 保存済みリフレッシュトークンから無言で取り直す。
    // 持っていない場合は refreshAccessToken() が「ログインしてください」を投げる
    // (ログインボタンの押下は beginAuthCodeFlow() が担当し、ここでは
    //  勝手にページ遷移させない)。
    return refreshAccessToken(workerUrl);
  }

  // (B) 従来方式。
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
    // ここに到達するのは「自動でのトークン取り直しができなかった/しても
    // まだ401だった」場合だけ(sheetsFetch が Worker方式では1回自動リトライ
    // する、2026-08-05)。つまり手動でのログインし直しが必要な状態。
    return 'Googleのログインが期限切れです。'
      + 'ヘッダーの「Googleにログイン」からログインし直してください。';
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

/**
 * 401 を受けたときに、その場でアクセストークンを取り直せるか。
 *
 * Worker方式(A)かつリフレッシュトークンを保存済みの場合だけ true。従来方式(B)は
 * 取り直しに利用者の操作(同意画面・ポップアップ)が要るため、勝手に発火させると
 * 操作していないのにポップアップが出ることになり対象外にする。
 */
function canSilentlyReauth() {
  return Boolean(normalizeWorkerUrl(lastAuthOptions?.workerUrl) && getStoredRefreshToken());
}

/**
 * 実際に1回リクエストを投げる(リトライ判定は sheetsFetch が行う)。
 * @returns {Promise<{res: Response}>}
 */
async function sendSheetsRequest(url, accessTokenValue, init) {
  try {
    return await fetch(url, {
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
}

/**
 * Sheets API を叩く共通処理。
 *
 * **401 を受けた場合は、可能なら1回だけ自動でトークンを取り直して再送する**
 * (2026-08-05追加)。Worker方式ではリフレッシュトークンを持っているため
 * 利用者の操作なしに取り直せるのに、以前は毎回「もう一度同じ操作をしてください」
 * と手動の再実行を求めており、長い操作(添削→シート追記→習熟用生成)の途中で
 * 期限が切れると最初からやり直しになっていた。リトライは1回だけで、それでも
 * 401 なら従来どおり SheetsAuthError を投げる(無限ループにしない)。
 */
async function sheetsFetch(url, accessTokenValue, init = {}) {
  if (!accessTokenValue) {
    throw new SheetsAuthError('Googleにログインしていません。');
  }

  let res = await sendSheetsRequest(url, accessTokenValue, init);

  if (res.status === 401 && canSilentlyReauth()) {
    // 手元のトークンは使えないと確定したので捨ててから取り直す
    // (捨てないと getAccessToken() が期限内と判断して同じものを返してしまう)。
    clearAccessToken();
    let refreshedToken = null;
    try {
      refreshedToken = await refreshAccessToken(lastAuthOptions.workerUrl);
    } catch {
      // 取り直しに失敗(リフレッシュトークンの失効など)。元の401をそのまま
      // 報告して、利用者に再ログインを促す。
      refreshedToken = null;
    }
    if (refreshedToken) {
      res = await sendSheetsRequest(url, refreshedToken, init);
    }
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

/**
 * 読み書きする範囲の右端の列(2026-08-05追加)。
 * A列がキー名、B列以降がチャンク(SYNC_MAX_CHUNKS 個)。
 */
function syncLastColumn() {
  return colLetter(SYNC_MAX_CHUNKS); // 0=A(キー名) なので、チャンク数と同じ添字が右端
}

/** 各行のキー(A列)。B列に対応するJSON文字列を保存する(行の順序は固定)。 */
export const SYNC_ROW_KEYS = [
  'word_stock_items', 'word_stock_tombstones',
  'ai_ask_stock_items', 'ai_ask_stock_tombstones',
  'shuujuku_stock_items', 'shuujuku_stock_tombstones',
  // 好みの設定(Geminiモデル・TTS音声/言語/音量ゲイン・日本語除外)。
  // 2026-08-05追加。**秘密情報(APIキー)はここに入れないこと**——それらは
  // Worker のシークレットに置き、GET /appconfig で配る(このシートには
  // サービスアカウントも編集者権限を持っているため。app.js の
  // ensureAppConfigLoaded と worker/src/index.js を参照)。
  // 行の対応付けはA列のキー名で行うので、末尾への追加は既存端末に影響しない。
  'app_settings',
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
  const range = `${SYNC_SHEET_NAME}!A1:${syncLastColumn()}${SYNC_ROW_KEYS.length}`;
  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}`;
  const data = await sheetsFetch(url, token);
  const values = data.values || [];

  // **A列のキー名で引く**(2026-08-05修正)。以前は行の位置だけで
  // `values[i][1]` を読んでおり、A列に書いてあるキー名を一切照合していなかった。
  // 将来 SYNC_ROW_KEYS の順序が変わる・途中にキーが増えると、既にシートを
  // 持っている端末が「単語のJSONを習熟用として読み込む」ような取り違えを
  // 起こす(エラーにならず静かにストックが混ざり、次の書き戻しで他端末へも
  // 伝播する)。キーで引いておけば、順序の変更に対して無害になる。
  const byKey = new Map();
  for (const row of values) {
    const key = String(row?.[0] ?? '').trim();
    // B列以降をすべて連結する(2026-08-05、複数セルへの分割保存に対応)。
    // 1セルしか無い場合もそのまま連結されるだけなので、分割対応より前に
    // 書かれたデータもそのまま読める(下位互換。既存データの移行は不要)。
    if (key) byKey.set(key, joinChunks((row || []).slice(1)));
  }

  const out = {};
  SYNC_ROW_KEYS.forEach((key) => { out[key] = byKey.get(key) || ''; });
  return out;
}

/**
 * マージ済みの3ストック分をまとめて隠しタブへ書き戻す(A1:B{N}の範囲を
 * まるごと上書きする1回のAPI呼び出しで済ませ、往復回数・競合の窓を減らす)。
 * @param {Record<string, string>} state SYNC_ROW_KEYS をキーにしたJSON文字列
 */
export async function writeSyncState({ spreadsheetId, accessToken: token, state }) {
  await ensureSyncSheetExists(spreadsheetId, token);
  const range = `${SYNC_SHEET_NAME}!A1:${syncLastColumn()}${SYNC_ROW_KEYS.length}`;

  const values = SYNC_ROW_KEYS.map((key) => {
    const chunks = splitIntoChunks(state[key] || '');
    if (chunks.length > SYNC_MAX_CHUNKS) {
      // 呼び出し側(app.js の runSync)が exceedsSyncLimit で事前に止めている
      // はずだが、そこを通らない経路から呼ばれても壊れたデータを書かないよう
      // ここでも止める(切り詰めて書くと、読み直したときJSONとして壊れる)。
      throw new SheetsError(
        `同期データ(${key})が保存できる上限を超えています`
        + `(${chunks.length} / ${SYNC_MAX_CHUNKS} セル)。`
        + '各タブの「出力済みを削除」で整理してください。',
      );
    }
    // 行の長さを必ず揃える。**使わないセルも空文字で埋めること**——
    // 短い行を書くとSheetsは足りない分を「変更なし」として扱い、
    // 前回より短くなったときに古いチャンクが残って、読み直したとき
    // 壊れたJSONになる。
    const row = [key];
    for (let i = 0; i < SYNC_MAX_CHUNKS; i += 1) row.push(chunks[i] || '');
    return row;
  });

  const url = `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeRange(range)}`
    + '?valueInputOption=RAW';
  await sheetsFetch(url, token, { method: 'PUT', body: JSON.stringify({ values }) });
}
