// worker/src/index.js
// ---------------------------------------------------------------------------
// Google OAuth 2.0 の「トークン交換」だけを中継する Cloudflare Worker。
//
// 【なぜ必要か】(2026-08-05 追加)
// Web版はこれまで Google Identity Services (GIS) の token client を使っていたが、
// この方式は仕様上リフレッシュトークンが発行されず、アクセストークンの寿命
// (約1時間)が切れるたびに実質ログインし直しになっていた。
//
// リフレッシュトークンを受け取るには「認可コードフロー」を使う必要があるが、
// Google の「ウェブ アプリケーション」型クライアントは認可コード→トークンの
// 交換に client_secret を要求する。client_secret を GitHub Pages で配信される
// JavaScript に埋め込むことは絶対にできない(公開ページのソースは誰でも読める)
// ため、**client_secret を保持するのはこの Worker だけ**にして、ブラウザからは
// 「コードを渡す→トークンを受け取る」だけを依頼する構成にした。
//
// 【この Worker がやること / やらないこと】
// - やる: 認可コード→トークン交換(/token)、リフレッシュ→アクセストークン
//   再発行(/refresh)、フロントへの client_id の配布(/config)
// - やらない: スプレッドシートの読み書き(従来どおりブラウザが直接 Sheets API を
//   叩く)、トークンの保存(この Worker は状態を一切持たない = ステートレス)
//
// 【セキュリティ上の位置づけ】
// この Worker は誰でも呼べる公開エンドポイントであり、「有効なリフレッシュ
// トークンを持っている者」であれば誰でもアクセストークンを取得できてしまう。
// これは client_secret を持たない公開クライアント(SPA/モバイルアプリ)の
// OAuth と同じ性質で、リフレッシュトークンそのものの秘匿がセキュリティの
// 前提になる。CORS の許可オリジンを絞ることで、少なくとも「別のサイトに
// 埋め込まれた JavaScript から勝手に呼ばれる」経路は塞いでいる
// (ブラウザ以外からの直接呼び出しは CORS では防げない点に注意)。
//
// 【必要な設定(wrangler.toml / wrangler secret)】
//   GOOGLE_CLIENT_ID     … OAuth クライアントID(秘密ではないので vars で可)
//   GOOGLE_CLIENT_SECRET … OAuth クライアントシークレット(**必ず secret で**)
//   ALLOWED_ORIGINS      … CORS を許可するオリジンのカンマ区切り
// デプロイ手順は worker/README.md を参照。
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** ALLOWED_ORIGINS(カンマ区切り)を配列にする。未設定なら空配列。 */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * CORS ヘッダーを組み立てる。
 * リクエスト元が許可リストに無い場合は Access-Control-Allow-Origin を付けない
 * (ブラウザ側がレスポンスを破棄するため、実質的に拒否になる)。
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function jsonResponse(body, { status = 200, request, env }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // ブラウザ・中間キャッシュにトークンを残さない。
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

function errorResponse(message, { status = 400, request, env, detail = null }) {
  return jsonResponse({ error: message, detail }, { status, request, env });
}

/**
 * Google のトークンエンドポイントを叩く共通処理。
 * 失敗時は Google が返した内容をそのまま添えて返す(利用者が原因を追える
 * ようにするため。client_secret は当然含まれない)。
 */
async function postToGoogle(params, { request, env }) {
  let res;
  try {
    res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    return errorResponse(`Googleのトークンエンドポイントへ接続できませんでした: ${e.message}`, {
      status: 502, request, env,
    });
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return errorResponse('Googleからの応答を解釈できませんでした。', {
      status: 502, request, env, detail: text.slice(0, 500),
    });
  }

  if (!res.ok) {
    // invalid_grant は「リフレッシュトークンが失効・取り消された」場合に返る
    // (OAuth同意画面が「テスト」ステータスのままだと7日で失効する、
    // ユーザーがアカウント設定からアクセスを取り消した、など)。
    // フロント側がこの文字列を見て「保存済みのトークンを捨てて再ログインを
    // 促す」判断をするため、そのまま透過させる。
    return jsonResponse(
      { error: data.error || 'token_request_failed', detail: data.error_description || text.slice(0, 500) },
      { status: res.status, request, env },
    );
  }
  return { data };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return errorResponse(
        'Worker側の設定が未完了です(GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)。',
        { status: 500, request, env },
      );
    }

    // -----------------------------------------------------------------------
    // GET /config … フロントに client_id を渡す
    //
    // クライアントIDは秘密情報ではないので公開して問題ない。フロント側にも
    // 同じ値を設定させると「Workerに設定した値と食い違う」事故が起きうる
    // ため、Worker を使う場合はここが唯一の出所になるようにしてある。
    // -----------------------------------------------------------------------
    if (url.pathname === '/config' && request.method === 'GET') {
      return jsonResponse({ client_id: env.GOOGLE_CLIENT_ID }, { request, env });
    }

    // -----------------------------------------------------------------------
    // POST /token … 認可コード → アクセストークン + リフレッシュトークン
    // body: { code, code_verifier, redirect_uri }
    // -----------------------------------------------------------------------
    if (url.pathname === '/token' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('リクエストのJSONを解釈できませんでした。', { request, env });
      }
      const { code, code_verifier: codeVerifier, redirect_uri: redirectUri } = body || {};
      if (!code || !codeVerifier || !redirectUri) {
        return errorResponse('code / code_verifier / redirect_uri が必要です。', { request, env });
      }

      const result = await postToGoogle({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }, { request, env });
      if (result instanceof Response) return result;

      const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken } = result.data;
      return jsonResponse(
        { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken || null },
        { request, env },
      );
    }

    // -----------------------------------------------------------------------
    // POST /refresh … リフレッシュトークン → 新しいアクセストークン
    // body: { refresh_token }
    //
    // Google はこの応答に refresh_token を含めない(既存のものを使い続ける)。
    // -----------------------------------------------------------------------
    if (url.pathname === '/refresh' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse('リクエストのJSONを解釈できませんでした。', { request, env });
      }
      const { refresh_token: refreshToken } = body || {};
      if (!refreshToken) {
        return errorResponse('refresh_token が必要です。', { request, env });
      }

      const result = await postToGoogle({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }, { request, env });
      if (result instanceof Response) return result;

      const { access_token: accessToken, expires_in: expiresIn } = result.data;
      return jsonResponse({ access_token: accessToken, expires_in: expiresIn }, { request, env });
    }

    return errorResponse('Not Found', { status: 404, request, env });
  },
};
