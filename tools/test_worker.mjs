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
console.log('\n[5] 設定漏れ・未知のパス');

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
