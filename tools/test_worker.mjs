// tools/test_worker.mjs
// ---------------------------------------------------------------------------
// worker/src/index.js(Googleのトークン交換を中継するCloudflare Worker)の
// 単体テスト。
//
// 【なぜ必要か】(2026-08-05追加)
// このWorkerは「ログインが1時間で切れる」問題を解決する要でありながら、
// 実装後しばらく自動テストが無かった。Workerは片桐のCloudflareアカウント上で
// 動くため、壊れていても気づけるのは実機でログインを試したときになり、
// しかも症状は「なぜかログインできない」という切り分けにくい形で出る。
// デプロイ前にここで振る舞いを固定しておく。
//
// Workerのエントリポイントは `export default { fetch(request, env) }` という
// 素のWeb標準APIなので、Nodeからそのままimportして呼べる(Cloudflareの実行環境も
// wranglerも不要)。Googleのトークンエンドポイントへの通信だけをfetchモックで
// 差し替える。**実際のGoogleにもCloudflareにもアクセスしない。**
//
// 【使い方】 cd tools && node test_worker.mjs

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };

console.log('worker/src/index.js の単体テスト\n');

const worker = (await import(new URL('../worker/src/index.js', import.meta.url))).default;

const ORIGIN = 'https://yoimachihime-tech.github.io';
const ENV = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret-value',
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8000`,
};

/** Googleのトークンエンドポイントを差し替える。飛んだリクエストを記録して返す。 */
function mockGoogle(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, params: Object.fromEntries(new URLSearchParams(init.body || '')) });
    const { status = 200, body } = await handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return calls;
}

function req(path, { method = 'GET', body = null, origin = ORIGIN } = {}) {
  return new Request(`https://worker.example.workers.dev${path}`, {
    method,
    headers: origin ? { Origin: origin, 'Content-Type': 'application/json' } : {},
    body: body === null ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
console.log('[1] CORS(許可オリジンの絞り込み)');

{
  const res = await worker.fetch(req('/config'), ENV);
  if (res.headers.get('Access-Control-Allow-Origin') === ORIGIN) {
    ok('許可オリジンからの要求には Allow-Origin を返す');
  } else {
    fail(`Allow-Origin が付いていない: ${res.headers.get('Access-Control-Allow-Origin')}`);
  }

  const other = await worker.fetch(req('/config', { origin: 'https://evil.example' }), ENV);
  if (other.headers.get('Access-Control-Allow-Origin') === null) {
    ok('許可していないオリジンには Allow-Origin を返さない(ブラウザ側で破棄される)');
  } else {
    fail(`未許可オリジンに Allow-Origin が付いた: ${other.headers.get('Access-Control-Allow-Origin')}`);
  }

  const preflight = await worker.fetch(req('/token', { method: 'OPTIONS' }), ENV);
  if (preflight.status === 204 && preflight.headers.get('Access-Control-Allow-Methods')?.includes('POST')) {
    ok('プリフライト(OPTIONS)に204と許可メソッドを返す');
  } else {
    fail(`プリフライトの応答が想定と違う: ${preflight.status}`);
  }

  // **これが無いと GET /appconfig はブラウザから一度も成功しない**(2026-08-19
  // 追加)。`Authorization` 付きの要求は単純リクエストにならないため、ブラウザは
  // 先に OPTIONS で許可を尋ね、許可リストに authorization が無ければ本リクエスト
  // 自体を送らない。アプリ側には「Failed to fetch」としか見えず、原因が
  // CORS だと分からないまま長く残っていた(2026-08-05〜2026-08-19)。
  //
  // このテストは Node から worker.fetch() を直接呼ぶだけで CORS の強制は
  // 働かないので、**ヘッダーの中身そのものを見る**しかない。
  const allowHeaders = (preflight.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
  if (allowHeaders.includes('authorization') && allowHeaders.includes('content-type')) {
    ok('プリフライトが Authorization を許可する(/appconfig がブラウザから呼べる)');
  } else {
    fail(`Allow-Headers に Authorization が無い: ${allowHeaders}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[2] GET /config(クライアントIDの配布)');

{
  const res = await worker.fetch(req('/config'), ENV);
  const body = await res.json();
  if (res.status === 200 && body.client_id === ENV.GOOGLE_CLIENT_ID) {
    ok('クライアントIDを返す(アプリ側はこれを唯一の出所にする)');
  } else {
    fail(`/config の応答が想定と違う: ${JSON.stringify(body)}`);
  }
  // 秘密情報が漏れていないことは、このWorkerで最も重要な性質。
  if (!JSON.stringify(body).includes(ENV.GOOGLE_CLIENT_SECRET)) {
    ok('クライアントシークレットは一切返さない');
  } else {
    fail('応答にクライアントシークレットが含まれている');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[3] POST /token(認可コード → トークン)');

{
  const calls = mockGoogle(() => ({
    body: { access_token: 'ya29.new', expires_in: 3599, refresh_token: 'RT-1' },
  }));
  const res = await worker.fetch(req('/token', {
    method: 'POST',
    body: { code: 'AUTH_CODE', code_verifier: 'VERIFIER', redirect_uri: `${ORIGIN}/ANKI-OutputTOOL/` },
  }), ENV);
  const body = await res.json();

  if (res.status === 200 && body.access_token === 'ya29.new' && body.refresh_token === 'RT-1') {
    ok('アクセストークンとリフレッシュトークンを返す');
  } else {
    fail(`/token の応答が想定と違う: ${JSON.stringify(body)}`);
  }

  const sent = calls[0]?.params || {};
  if (sent.grant_type === 'authorization_code' && sent.code === 'AUTH_CODE'
    && sent.code_verifier === 'VERIFIER' && sent.redirect_uri === `${ORIGIN}/ANKI-OutputTOOL/`) {
    ok('認可コード・PKCEのcode_verifier・リダイレクトURIをGoogleへ渡す');
  } else {
    fail(`Googleへ送った内容が想定と違う: ${JSON.stringify(sent)}`);
  }
  // client_secret をブラウザに置けないことがこのWorkerの存在理由なので、
  // 「Workerが代わりに付けている」ことを固定しておく。
  if (sent.client_secret === ENV.GOOGLE_CLIENT_SECRET && sent.client_id === ENV.GOOGLE_CLIENT_ID) {
    ok('client_id / client_secret はWorkerが付与する(ブラウザは知らなくてよい)');
  } else {
    fail('client_secret がGoogleへ渡っていない');
  }

  if (res.headers.get('Cache-Control') === 'no-store') {
    ok('トークンの応答はキャッシュさせない(Cache-Control: no-store)');
  } else {
    fail(`Cache-Control が no-store でない: ${res.headers.get('Cache-Control')}`);
  }
}

{
  // 必須パラメータが欠けている場合
  mockGoogle(() => ({ body: {} }));
  const res = await worker.fetch(req('/token', { method: 'POST', body: { code: 'X' } }), ENV);
  if (res.status === 400) ok('code_verifier / redirect_uri が無ければ400で弾く');
  else fail(`不足パラメータが通ってしまった: ${res.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n[4] POST /refresh(リフレッシュ → 新しいアクセストークン)');

{
  const calls = mockGoogle(() => ({ body: { access_token: 'ya29.refreshed', expires_in: 3599 } }));
  const res = await worker.fetch(req('/refresh', {
    method: 'POST', body: { refresh_token: 'RT-1' },
  }), ENV);
  const body = await res.json();

  if (res.status === 200 && body.access_token === 'ya29.refreshed') {
    ok('新しいアクセストークンを返す(利用者の操作は不要)');
  } else {
    fail(`/refresh の応答が想定と違う: ${JSON.stringify(body)}`);
  }
  if (calls[0]?.params.grant_type === 'refresh_token' && calls[0]?.params.refresh_token === 'RT-1') {
    ok('grant_type=refresh_token でGoogleへ問い合わせる');
  } else {
    fail(`Googleへ送った内容が想定と違う: ${JSON.stringify(calls[0]?.params)}`);
  }
}

{
  // 失効したリフレッシュトークン。アプリ側(sheets.js の refreshAccessToken)が
  // この `invalid_grant` を見て保存済みトークンを捨てるため、**握り潰さずに
  // そのまま透過させる**ことが重要。ここが変わると「ログインし直しても
  // 復帰できない」状態になる。
  mockGoogle(() => ({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
  }));
  const res = await worker.fetch(req('/refresh', {
    method: 'POST', body: { refresh_token: 'RT-DEAD' },
  }), ENV);
  const body = await res.json();
  if (res.status === 400 && body.error === 'invalid_grant') {
    ok('invalid_grant はそのまま透過させる(アプリが再ログインへ誘導できる)');
  } else {
    fail(`invalid_grant が透過していない: ${res.status} / ${JSON.stringify(body)}`);
  }

  mockGoogle(() => ({ body: {} }));
  const missing = await worker.fetch(req('/refresh', { method: 'POST', body: {} }), ENV);
  if (missing.status === 400) ok('refresh_token が無ければ400で弾く');
  else fail(`refresh_token 無しが通ってしまった: ${missing.status}`);
}

// ---------------------------------------------------------------------------
// [5] GET /appconfig(2026-08-05追加)
//
// 秘密情報(APIキー・スプレッドシートID)を返すエンドポイントなので、
// **本人確認を通さずに返してしまわないこと**がここでの最重要事項。
// CORSはブラウザ内のJSしか縛れず、curl等の直接呼び出しは防げないため、
// アクセストークンをGoogleのtokeninfoで検証してから返す設計になっている。
// ---------------------------------------------------------------------------
console.log('\n[5] GET /appconfig(ログイン済みの本人にだけ設定を配る)');

const CONFIG_ENV = {
  ...ENV,
  ALLOWED_EMAIL: 'Yoimachihime@GMail.com', // 大小差があっても一致させる
  SPREADSHEET_ID: 'SHEET_ID_VALUE',
  SHEET_NAME: '添削結果',
  GEMINI_API_KEY: 'gemini-key-value',
  TTS_API_KEY: 'tts-key-value',
};

/** tokeninfo の応答を差し替える。 */
function mockTokenInfo(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url) });
    const { status = 200, body } = await handler(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

function appConfigReq(token) {
  return new Request('https://worker.example.workers.dev/appconfig', {
    method: 'GET',
    headers: token ? { Origin: ORIGIN, Authorization: `Bearer ${token}` } : { Origin: ORIGIN },
  });
}

const VALID_INFO = {
  aud: ENV.GOOGLE_CLIENT_ID,
  azp: ENV.GOOGLE_CLIENT_ID,
  email: 'yoimachihime@gmail.com',
  email_verified: 'true',
  scope: 'openid email https://www.googleapis.com/auth/spreadsheets',
};

{
  const calls = mockTokenInfo(() => ({ body: VALID_INFO }));
  const res = await worker.fetch(appConfigReq('ya29.valid'), CONFIG_ENV);
  const body = await res.json();

  if (res.status === 200 && body.spreadsheet_id === 'SHEET_ID_VALUE'
    && body.gemini_api_key === 'gemini-key-value' && body.tts_api_key === 'tts-key-value'
    && body.sheet_name === '添削結果') {
    ok('本人のトークンなら設定一式を返す');
  } else {
    fail(`/appconfig の応答が想定と違う: ${res.status} / ${JSON.stringify(body)}`);
  }
  if (calls[0]?.url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    ok('返す前に必ず Google の tokeninfo で検証する');
  } else {
    fail(`tokeninfo を呼んでいない: ${JSON.stringify(calls)}`);
  }
  if (res.headers.get('Cache-Control') === 'no-store') {
    ok('秘密を含む応答はキャッシュさせない');
  } else {
    fail(`Cache-Control が no-store でない: ${res.headers.get('Cache-Control')}`);
  }
}

{
  // トークン無しで叩く(curl等での直接呼び出しを想定)
  mockTokenInfo(() => ({ body: VALID_INFO }));
  const res = await worker.fetch(appConfigReq(null), CONFIG_ENV);
  const text = JSON.stringify(await res.json());
  if (res.status === 401 && !text.includes('gemini-key-value')) {
    ok('トークン無しの要求は401で拒否し、秘密を一切返さない');
  } else {
    fail(`トークン無しで秘密が漏れている可能性: ${res.status} / ${text}`);
  }
}

{
  // 別のGoogleアカウントのトークン
  mockTokenInfo(() => ({ body: { ...VALID_INFO, email: 'someone-else@gmail.com' } }));
  const res = await worker.fetch(appConfigReq('ya29.other'), CONFIG_ENV);
  const text = JSON.stringify(await res.json());
  if (res.status === 403 && !text.includes('gemini-key-value')) {
    ok('別アカウントのトークンは403で拒否する');
  } else {
    fail(`別アカウントに秘密が漏れている: ${res.status} / ${text}`);
  }
}

{
  // 別アプリ向けに発行されたトークン(aud/azp が違う)
  mockTokenInfo(() => ({ body: { ...VALID_INFO, aud: 'other-app', azp: 'other-app' } }));
  const res = await worker.fetch(appConfigReq('ya29.foreign'), CONFIG_ENV);
  const text = JSON.stringify(await res.json());
  if (res.status === 403 && !text.includes('gemini-key-value')) {
    ok('別アプリ向けのトークンは403で拒否する');
  } else {
    fail(`別アプリのトークンが通ってしまった: ${res.status} / ${text}`);
  }
}

{
  // 期限切れ・無効なトークン(tokeninfo が 400 を返す)
  mockTokenInfo(() => ({ status: 400, body: { error: 'invalid_token' } }));
  const res = await worker.fetch(appConfigReq('ya29.expired'), CONFIG_ENV);
  if (res.status === 401) ok('無効・期限切れのトークンは401で拒否する');
  else fail(`無効トークンの扱いが想定と違う: ${res.status}`);
}

{
  // メールが未確認 / スコープ不足でメールが取れない場合
  mockTokenInfo(() => ({ body: { ...VALID_INFO, email_verified: 'false' } }));
  const unverified = await worker.fetch(appConfigReq('ya29.unverified'), CONFIG_ENV);
  if (unverified.status === 403) ok('メール未確認のトークンは403で拒否する');
  else fail(`メール未確認が通ってしまった: ${unverified.status}`);

  mockTokenInfo(() => ({ body: { aud: ENV.GOOGLE_CLIENT_ID, azp: ENV.GOOGLE_CLIENT_ID } }));
  const noEmail = await worker.fetch(appConfigReq('ya29.noemail'), CONFIG_ENV);
  const noEmailBody = await noEmail.json();
  if (noEmail.status === 403 && /openid email/.test(noEmailBody.error)) {
    ok('メールが取れない場合はスコープ不足だと分かるメッセージを返す');
  } else {
    fail(`スコープ不足時の案内が想定と違う: ${noEmail.status} / ${JSON.stringify(noEmailBody)}`);
  }
}

{
  // **最重要**: ALLOWED_EMAIL 未設定のまま秘密を返さないこと(fail closed)。
  // ここが開いていると、ログインさえすれば誰でもAPIキーを取得できてしまう。
  mockTokenInfo(() => ({ body: VALID_INFO }));
  const res = await worker.fetch(appConfigReq('ya29.valid'), { ...CONFIG_ENV, ALLOWED_EMAIL: undefined });
  const text = JSON.stringify(await res.json());
  if (res.status === 500 && !text.includes('gemini-key-value')) {
    ok('ALLOWED_EMAIL 未設定なら誰にも秘密を返さない(fail closed)');
  } else {
    fail(`ALLOWED_EMAIL 未設定で秘密が漏れている: ${res.status} / ${text}`);
  }
}

{
  // 一部のシークレットだけ登録されている場合(TTSキー未設定など)
  mockTokenInfo(() => ({ body: VALID_INFO }));
  const res = await worker.fetch(appConfigReq('ya29.valid'), {
    ...CONFIG_ENV, TTS_API_KEY: undefined, SHEET_NAME: undefined,
  });
  const body = await res.json();
  if (body.tts_api_key === null && body.sheet_name === null && body.gemini_api_key === 'gemini-key-value') {
    ok('未登録の項目は null で返す(端末側の手入力値を消さないため)');
  } else {
    fail(`未登録項目の扱いが想定と違う: ${JSON.stringify(body)}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[6] 設定漏れ・未知のパス');

{
  const res = await worker.fetch(req('/config'), { ALLOWED_ORIGINS: ORIGIN });
  const body = await res.json();
  if (res.status === 500 && /GOOGLE_CLIENT_ID/.test(body.error)) {
    ok('シークレット未登録なら、原因が分かるメッセージで500を返す');
  } else {
    fail(`設定漏れの扱いが想定と違う: ${res.status} / ${JSON.stringify(body)}`);
  }

  const notFound = await worker.fetch(req('/unknown'), ENV);
  if (notFound.status === 404) ok('未知のパスは404');
  else fail(`未知のパスの扱いが想定と違う: ${notFound.status}`);

  // GET /token のようなメソッド違いも 404 に落ちる(想定どおりの防御)。
  const wrongMethod = await worker.fetch(req('/token'), ENV);
  if (wrongMethod.status === 404) ok('メソッドが違う要求も受け付けない');
  else fail(`メソッド違いが通ってしまった: ${wrongMethod.status}`);
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n✅ すべて成功しました。' : `\n❌ ${failures} 件失敗しました。`);
process.exitCode = failures === 0 ? 0 : 1;
