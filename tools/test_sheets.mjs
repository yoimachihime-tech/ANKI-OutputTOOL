// tools/test_sheets.mjs
// ---------------------------------------------------------------------------
// docs/lib/sheets.js と docs/lib/dailyconv.js の単体テスト
// (Node上で直接importして実行。Google Identity Services の読み込みは行わない)。
//
// 検証しているのは、デスクトップ版の sheets_reader.py / sheets_writer.py /
// daily_pending_exclusions.py と挙動が一致していること:
//   - fetchPendingRows: 「Anki出力済み」列が空の行だけを拾い、末尾の省略セル・
//     複数行セル・空欄スコアを Python 版と同じ形に整えるか
//   - appendCorrectionRows: シートの実ヘッダー行に合わせて列を並べ替えるか
//     (固定の列順を決め打ちしていないこと)
//   - markRowsAsExported: 「Anki出力済み」列**だけ**に書き、見つからないIDを
//     failed として返すか
//   - dailyconv: ローカル除外リストの読み書き
// カード内容(9フィールドへの変換)そのものは tools/verify_web_parity.mjs が
// Python版の apkg と直接突き合わせているため、ここでは重複して検証しない。
//
// Sheets API は fetch をモックするので、実際のスプレッドシートにも
// Googleアカウントにも一切アクセスしない。
//
// 【使い方】 cd tools && node test_sheets.mjs

import { JSDOM } from 'jsdom';

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// dailyconv.js のローカル除外リストは localStorage を使うため DOM を用意する。
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

console.log('lib/sheets.js / lib/dailyconv.js の単体テスト\n');

const {
  fetchPendingRows, appendCorrectionRows, markRowsAsExported, colLetter,
  SheetsError, SheetsAuthError, getStoredRefreshToken,
} = await import(new URL('../docs/lib/sheets.js', import.meta.url));
const dailyconv = await import(new URL('../docs/lib/dailyconv.js', import.meta.url));

const TOKEN = 'ya29.dummy-access-token';
const SHEET = { spreadsheetId: 'SHEET_ID', sheetName: '添削結果', accessToken: TOKEN };

const HEADERS = [
  'ID', '日時', '原文', '添削後', '解説', 'カテゴリ',
  '類似表現(英文)', '類似表現(解説)',
  '文法スコア', '自然さスコア', '伝わりやすさスコア', 'スコア解説', 'Anki出力済み',
];

/**
 * fetch をモックする。ハンドラは (url, init) を受け取り、
 * レスポンスの JSON(またはステータス)を返す。
 * @returns {object[]} 実際に飛んだリクエストの記録
 */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const result = await handler(url, init);
    if (result && result.__error) {
      return { ok: false, status: result.__error, text: async () => result.detail || '' };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  return calls;
}

// ---------------------------------------------------------------------------
console.log('[1] colLetter (sheets_writer._col_letter との一致)');

for (const [index, want] of [[0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA']]) {
  const got = colLetter(index);
  if (got === want) ok(`colLetter(${index}) = ${got}`);
  else fail(`colLetter(${index}): got=${got} / want=${want}`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] fetchPendingRows');

{
  const calls = mockFetch(async () => ({
    values: [
      HEADERS,
      // 出力済み(Anki出力済み列が非空)→ スキップされるはず
      ['id-done', '2026-07-20 10:00:00', 'Done.', 'Done.', '', '文法', '', '', '80', '80', '80', '', '2026-07-20 11:00:00'],
      // 通常の未出力行(類似表現は\n区切りの複数行、スコアあり)
      ['id-1', '2026-07-28 09:00:00', 'I go yesterday.', 'I went yesterday.', '過去形にします。', '文法',
        'I visited yesterday.\nI headed there yesterday.', 'visit は硬い。\nhead to は向かう。',
        '60', '70', '90', '時制の誤り。', ''],
      // 末尾セルが省略されている行(Sheets API は末尾の空セルを配列から落とす)
      ['id-2', '2026-07-28 09:05:00', "She don't like it.", "She doesn't like it."],
      // ID空欄の行(末尾の空行など)→ スキップされるはず
      ['', '', '', ''],
    ],
  }));

  const rows = await fetchPendingRows(SHEET);

  if (rows.length === 2) ok('「Anki出力済み」が非空の行とID空欄の行を除外する');
  else fail(`取得件数が想定と違う: ${rows.length} 件 (${rows.map((r) => r.id).join(', ')})`);

  if (deepEq(rows[0].similar_en_list, ['I visited yesterday.', 'I headed there yesterday.'])
    && deepEq(rows[0].similar_ja_list, ['visit は硬い。', 'head to は向かう。'])) {
    ok('類似表現の\\n区切りセルをリストに分割する(_split_multiline 相当)');
  } else {
    fail(`類似表現の分割が想定と違う: ${JSON.stringify(rows[0].similar_en_list)}`);
  }

  if (rows[0].created_at === '2026-07-28 09:00:00') {
    ok('シートの「日時」列を created_at としてそのまま返す(一覧の生成日時表示に使う)');
  } else {
    fail(`created_atが想定と違う: ${JSON.stringify(rows[0].created_at)}`);
  }

  if (rows[0].grammar_score === 60 && rows[0].naturalness_score === 70
    && rows[0].comprehensibility_score === 90) {
    ok('スコア列を数値に変換する(_to_int_or_none 相当)');
  } else {
    fail(`スコアの変換が想定と違う: ${JSON.stringify(rows[0])}`);
  }

  if (rows[1].grammar_score === null && rows[1].score_comment === ''
    && deepEq(rows[1].similar_en_list, [])) {
    ok('末尾セルが省略された行は、空欄スコア=null / その他=空文字になる');
  } else {
    fail(`末尾省略行の処理が想定と違う: ${JSON.stringify(rows[1])}`);
  }

  if (calls[0].method === 'GET'
    && calls[0].url.includes('/SHEET_ID/values/')
    && calls[0].url.includes(encodeURIComponent('添削結果'))
    && calls[0].headers.Authorization === `Bearer ${TOKEN}`) {
    ok('シート名をURLエンコードし、Bearerトークンを付けて読み取る');
  } else {
    fail(`リクエストの組み立てが想定と違う: ${calls[0].url}`);
  }
}

{
  // ヘッダーに必須列が無い場合
  mockFetch(async () => ({ values: [['原文', '添削後'], ['a', 'b']] }));
  try {
    await fetchPendingRows(SHEET);
    fail('ID列が無い場合は SheetsError を投げるべき');
  } catch (e) {
    if (e instanceof SheetsError && e.message.includes('ID')) ok('ID列が無ければ分かりやすいSheetsErrorになる');
    else fail(`例外が想定と違う: ${e.message}`);
  }
}

{
  // 空のシート
  mockFetch(async () => ({}));
  const rows = await fetchPendingRows(SHEET);
  if (deepEq(rows, [])) ok('シートが空なら空配列を返す');
  else fail(`空シートの処理が想定と違う: ${JSON.stringify(rows)}`);
}

{
  // トークン失効(401)は SheetsAuthError にする(呼び出し側が再ログインを促せるよう)
  mockFetch(async () => ({ __error: 401, detail: '{"error":{"status":"UNAUTHENTICATED"}}' }));
  try {
    await fetchPendingRows(SHEET);
    fail('401 は SheetsAuthError を投げるべき');
  } catch (e) {
    if (e instanceof SheetsAuthError) ok('401(トークン失効)は SheetsAuthError になる');
    else fail(`401 の例外型が想定と違う: ${e.constructor.name}`);
  }
}

{
  // 権限不足(403)は再ログインでは直らないので SheetsAuthError にしない
  mockFetch(async () => ({ __error: 403, detail: '{"error":{"message":"The caller does not have permission"}}' }));
  try {
    await fetchPendingRows(SHEET);
    fail('403 は SheetsError を投げるべき');
  } catch (e) {
    if (e instanceof SheetsError && !(e instanceof SheetsAuthError) && e.message.includes('権限')) {
      ok('403(権限不足)は SheetsError + 対処方法の説明になる');
    } else {
      fail(`403 の扱いが想定と違う: ${e.constructor.name} / ${e.message}`);
    }
  }
}

{
  // 同じ 403 でも「トークンにスプレッドシートのスコープが無い」場合は原因も対処も別。
  // 同意画面のチェックボックスをオフのまま進めると起きる(2026-08-13に実際に発生)。
  // 保存済みリフレッシュトークンも同じ足りないスコープを持つため、捨てないと
  // 無言の取り直しが同じ 403 を返し続けて永久に直らない。
  localStorage.setItem('anki_tool_google_refresh_token', '1//dummy-refresh-token');
  mockFetch(async () => ({
    __error: 403,
    detail: JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
      },
    }),
  }));
  try {
    await fetchPendingRows(SHEET);
    fail('403(スコープ不足)は SheetsAuthError を投げるべき');
  } catch (e) {
    if (e instanceof SheetsAuthError && e.message.includes('チェックボックス')) {
      ok('403(スコープ不足)は SheetsAuthError + 同意画面のやり直しを案内する');
    } else {
      fail(`403(スコープ不足)の扱いが想定と違う: ${e.constructor.name} / ${e.message}`);
    }
    if (e.message.includes('共有設定の問題ではありません')) {
      ok('403(スコープ不足)をシートの共有設定の問題と誤って案内しない');
    } else {
      fail('403(スコープ不足)で共有設定を疑わせる案内のままになっている');
    }
  }
  if (getStoredRefreshToken() === null) {
    ok('403(スコープ不足)では保存済みリフレッシュトークンを捨てる');
  } else {
    fail('403(スコープ不足)なのにリフレッシュトークンが残っている(同じ403を繰り返す)');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[3] appendCorrectionRows');

{
  // わざとヘッダーの並びを入れ替え、既知の列を1つ増やしておく
  // (「固定の列順を決め打ちしていない」ことの検証)。
  const SHUFFLED = ['カテゴリ', 'ID', '原文', '添削後', 'メモ(未知の列)', '類似表現(英文)', '類似表現(解説)', 'Anki出力済み', '日時'];
  const calls = mockFetch(async (url, init) => {
    if (init.method === 'POST') return { updates: { updatedRows: 1 } };
    return { values: [SHUFFLED] };
  });

  const corrections = [{
    original: 'I go yesterday.',
    corrected: 'I went yesterday.',
    explanation: '過去形。',
    category: '文法',
    similar_expressions: [
      { expression: 'I visited yesterday.', note: 'visit は硬い。' },
      { expression: 'I headed there.', note: 'head to は向かう。' },
    ],
    grammar_score: 60,
    naturalness_score: 70,
    comprehensibility_score: 90,
    score_comment: '時制の誤り。',
  }];

  const newIds = await appendCorrectionRows({ ...SHEET, corrections });

  const post = calls.find((c) => c.method === 'POST');
  const row = post.body.values[0];

  if (row.length === SHUFFLED.length
    && row[SHUFFLED.indexOf('ID')] === newIds[0]
    && row[SHUFFLED.indexOf('カテゴリ')] === '文法'
    && row[SHUFFLED.indexOf('添削後')] === 'I went yesterday.') {
    ok('シートの実ヘッダー行の並びに合わせて値を配置する');
  } else {
    fail(`列の並べ替えが想定と違う: ${JSON.stringify(row)}`);
  }

  if (row[SHUFFLED.indexOf('メモ(未知の列)')] === '') {
    ok('対応する値を持たない列は空文字で埋める');
  } else {
    fail(`未知の列の扱いが想定と違う: ${JSON.stringify(row[SHUFFLED.indexOf('メモ(未知の列)')])}`);
  }

  if (row[SHUFFLED.indexOf('類似表現(英文)')] === 'I visited yesterday.\nI headed there.'
    && row[SHUFFLED.indexOf('類似表現(解説)')] === 'visit は硬い。\nhead to は向かう。') {
    ok('類似表現を英文/解説それぞれ\\n区切りの1セルにまとめる');
  } else {
    fail(`類似表現の結合が想定と違う: ${JSON.stringify(row[SHUFFLED.indexOf('類似表現(英文)')])}`);
  }

  if (row[SHUFFLED.indexOf('Anki出力済み')] === '') {
    ok('「Anki出力済み」列は空(未出力)で追記する');
  } else {
    fail('「Anki出力済み」列が空になっていない');
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[SHUFFLED.indexOf('日時')])) {
    ok('日時列は YYYY-MM-DD HH:MM:SS 形式で書き込む');
  } else {
    fail(`日時の形式が想定と違う: ${row[SHUFFLED.indexOf('日時')]}`);
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(newIds[0])) {
    ok('ID列はuuid4を新規採番する');
  } else {
    fail(`採番したIDがuuid4形式でない: ${newIds[0]}`);
  }

  if (post.url.includes(':append')
    && post.url.includes('valueInputOption=USER_ENTERED')
    && post.url.includes('insertDataOption=INSERT_ROWS')) {
    ok('values:append を USER_ENTERED / INSERT_ROWS で呼ぶ');
  } else {
    fail(`appendのURLが想定と違う: ${post.url}`);
  }
}

{
  const calls = mockFetch(async () => ({ values: [HEADERS] }));
  const newIds = await appendCorrectionRows({ ...SHEET, corrections: [] });
  if (deepEq(newIds, []) && calls.length === 0) ok('corrections が空なら API を呼ばない');
  else fail('corrections が空のときに余計なAPI呼び出しが起きている');
}

// ---------------------------------------------------------------------------
console.log('\n[4] markRowsAsExported');

{
  const calls = mockFetch(async (url, init) => {
    if (init.method === 'POST') return { totalUpdatedCells: 2 };
    if (url.includes(encodeURIComponent('!A2:A'))) {
      return { values: [['id-1'], ['id-2'], ['id-3']] };
    }
    return { values: [HEADERS] };
  });

  const result = await markRowsAsExported({
    ...SHEET,
    rowIds: ['id-1', 'id-3', 'id-missing'],
  });

  const post = calls.find((c) => c.method === 'POST');

  if (deepEq(result.succeeded.sort(), ['id-1', 'id-3']) && deepEq(result.failed, ['id-missing'])) {
    ok('ID列に見つかった行だけを succeeded、無いものを failed で返す');
  } else {
    fail(`結果が想定と違う: ${JSON.stringify(result)}`);
  }

  // ID列=A(0)、Anki出力済み列=M(12)。データは2行目始まりなので id-1 → M2、id-3 → M4。
  const ranges = post.body.data.map((d) => d.range).sort();
  if (deepEq(ranges, ['添削結果!M2', '添削結果!M4'])) {
    ok('「Anki出力済み」列のセルだけを対象にする(他の列には触れない)');
  } else {
    fail(`書き込み先が想定と違う: ${JSON.stringify(ranges)}`);
  }

  if (post.body.valueInputOption === 'RAW'
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(post.body.data[0].values[0][0])) {
    ok('RAW で書き込み時刻(YYYY-MM-DD HH:MM:SS)を書く');
  } else {
    fail(`書き込む値が想定と違う: ${JSON.stringify(post.body)}`);
  }
}

{
  const calls = mockFetch(async () => ({ values: [HEADERS] }));
  const result = await markRowsAsExported({ ...SHEET, rowIds: [] });
  if (deepEq(result, { succeeded: [], failed: [] }) && calls.length === 0) {
    ok('rowIds が空なら API を呼ばない');
  } else {
    fail('rowIds が空のときに余計なAPI呼び出しが起きている');
  }
}

{
  // 1件も一致しない場合は、書き込みAPI自体を呼ばない
  const calls = mockFetch(async (url, init) => {
    if (init.method === 'POST') return { totalUpdatedCells: 0 };
    if (url.includes(encodeURIComponent('!A2:A'))) return { values: [['other']] };
    return { values: [HEADERS] };
  });
  const result = await markRowsAsExported({ ...SHEET, rowIds: ['id-x'] });
  if (deepEq(result.failed, ['id-x']) && !calls.some((c) => c.method === 'POST')) {
    ok('一致する行が1件も無ければ書き込みAPIを呼ばない');
  } else {
    fail('一致0件でも書き込みAPIが呼ばれている');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[5] dailyconv のローカル除外リスト');

{
  localStorage.clear();
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  if (deepEq(dailyconv.filterOutExcluded(rows), rows)) ok('除外登録が無ければ全行そのまま返す');
  else fail('除外登録が無いのに行が減っている');

  dailyconv.addExcludedIds(['b']);
  if (deepEq(dailyconv.filterOutExcluded(rows).map((r) => r.id), ['a', 'c'])) {
    ok('除外登録した行IDを一覧から取り除く');
  } else {
    fail('除外が効いていない');
  }

  dailyconv.addExcludedIds(['c', '']);   // 空文字は無視されるはず
  if (deepEq([...dailyconv.loadExcludedIds()].sort(), ['b', 'c'])) {
    ok('除外リストは追記され、空のIDは無視される');
  } else {
    fail(`除外リストの内容が想定と違う: ${JSON.stringify([...dailyconv.loadExcludedIds()])}`);
  }

  dailyconv.clearExcludedIds();
  if (dailyconv.loadExcludedIds().size === 0) ok('除外リストをまとめて解除できる');
  else fail('除外リストが解除されていない');
}

// ---------------------------------------------------------------------------
// [6] 認可コードフロー + PKCE + リフレッシュトークン(2026-08-05追加)
//
// 「ログインが1時間で切れる」問題への対応。ここで固定したいのは、
// Google が**リフレッシュトークンを返す条件**(access_type=offline かつ
// prompt=consent)と、PKCE/state の照合、失効(invalid_grant)時に保存済みの
// トークンを確実に捨てることの3点。ここが崩れると、症状としては
// 「ログインし直しても結局すぐ切れる」という分かりにくい形で現れる。
//
// Worker には接続せず fetch をモックする。window.location は jsdom だと
// 実際の遷移を伴い assign() が使えないため、必要な範囲だけの偽物に差し替える。
// ---------------------------------------------------------------------------
console.log('\n[6] 認可コードフロー(ログイン維持用Worker方式)');
{
  globalThis.sessionStorage = dom.window.sessionStorage;
  const WORKER = 'https://anki-tool-oauth.example.workers.dev';
  const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
  const ORIGIN = 'https://user.github.io';
  const PATHNAME = '/ANKI-OutputTOOL/';

  /** window.location / window.history のうち sheets.js が使う部分だけの偽物。 */
  function fakeWindow(search = '') {
    const navigations = [];
    const replaced = [];
    globalThis.window = {
      location: {
        origin: ORIGIN,
        pathname: PATHNAME,
        search,
        href: `${ORIGIN}${PATHNAME}${search}`,
        assign: (url) => navigations.push(url),
      },
      history: { replaceState: (_s, _t, url) => replaced.push(url) },
    };
    return { navigations, replaced };
  }

  /** Worker 用の fetch モック(workerFetch は res.text() を読む)。 */
  function mockWorker(handler) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      const { status = 200, body } = await handler(url, init);
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    };
    return calls;
  }

  const sheets = await import(new URL('../docs/lib/sheets.js', import.meta.url));

  // --- ログイン開始(同意画面へのURL組み立て) --------------------------------
  localStorage.clear();
  sessionStorage.clear();
  const { navigations } = fakeWindow();
  const beginCalls = mockWorker(() => ({ body: { client_id: CLIENT_ID } }));
  await sheets.beginAuthCodeFlow(WORKER);

  if (sheets.redirectUri() === `${ORIGIN}${PATHNAME}`) {
    ok('リダイレクトURIはクエリ・ハッシュを除いた現在のページになる');
  } else {
    fail(`リダイレクトURIが想定と違う: ${sheets.redirectUri()}`);
  }

  if (beginCalls.length === 1 && beginCalls[0].url === `${WORKER}/config`) {
    ok('クライアントIDはWorkerの /config から取得する(アプリ側に持たない)');
  } else {
    fail(`/config を呼んでいない: ${JSON.stringify(beginCalls)}`);
  }

  if (navigations.length !== 1) fail(`同意画面へ遷移していない: ${navigations.length}件`);
  const authUrl = new URL(navigations[0] || 'https://invalid.test/');
  const q = authUrl.searchParams;

  if (authUrl.origin + authUrl.pathname === 'https://accounts.google.com/o/oauth2/v2/auth') {
    ok('Googleの認可エンドポイントへ遷移する');
  } else {
    fail(`遷移先が想定と違う: ${authUrl.origin}${authUrl.pathname}`);
  }

  // ここが今回の修正の肝。どちらか一方でも欠けると Google は
  // リフレッシュトークンを返さず、「1時間で切れる」状態のままになる。
  if (q.get('access_type') === 'offline' && q.get('prompt') === 'consent') {
    ok('access_type=offline + prompt=consent でリフレッシュトークンを要求する');
  } else {
    fail(`リフレッシュトークンが得られない組み合わせ: access_type=${q.get('access_type')} / prompt=${q.get('prompt')}`);
  }

  if (q.get('response_type') === 'code' && q.get('client_id') === CLIENT_ID
      && q.get('redirect_uri') === `${ORIGIN}${PATHNAME}`
      && q.get('scope') === sheets.OAUTH_SCOPE) {
    ok('response_type/client_id/redirect_uri/scope が正しい');
  } else {
    fail(`認可リクエストのパラメータが想定と違う: ${authUrl.search}`);
  }

  // **`openid email` は Worker の GET /appconfig の本人確認に必須**
  // (2026-08-05追加)。これが欠けると Google の tokeninfo がメールアドレスを
  // 返さず、Worker が「呼んでいるのが本人か」を判定できないため、
  // APIキー等の設定を配れなくなる(症状は「新しい端末で設定が降ってこない」)。
  const scopes = (q.get('scope') || '').split(' ');
  if (scopes.includes('openid') && scopes.includes('email')
      && scopes.includes(sheets.SHEETS_SCOPE)) {
    ok('スコープに openid / email / spreadsheets がすべて含まれる');
  } else {
    fail(`スコープが不足している: ${q.get('scope')}`);
  }

  if (q.get('code_challenge_method') === 'S256' && (q.get('code_challenge') || '').length >= 43
      && !/[+/=]/.test(q.get('code_challenge') || '+')) {
    ok('PKCE の code_challenge を S256 / base64url で送る');
  } else {
    fail(`code_challenge が想定と違う: ${q.get('code_challenge')} (${q.get('code_challenge_method')})`);
  }

  const stateParam = q.get('state');
  if (stateParam && sessionStorage.getItem('anki_tool_oauth_pkce')) {
    ok('code_verifier と state をリダイレクトをまたいで保持する');
  } else {
    fail('PKCEの途中経過が保存されていない');
  }

  // --- state 不一致は拒否する ------------------------------------------------
  {
    fakeWindow(`?code=AUTH_CODE&state=tampered-${stateParam}`);
    const calls = mockWorker(() => ({ body: {} }));
    const result = await sheets.completeAuthCodeFlowIfReturning();
    if (result.handled && result.error?.includes('state') && calls.length === 0) {
      ok('state が一致しなければトークン交換せずに拒否する(CSRF対策)');
    } else {
      fail(`state不一致を通してしまった: ${JSON.stringify(result)} / calls=${calls.length}`);
    }
  }

  // --- 正常な戻り(code → トークン交換) ---------------------------------------
  // 上の state 不一致テストで途中経過が消費されているため、やり直す。
  sessionStorage.clear();
  fakeWindow();
  mockWorker(() => ({ body: { client_id: CLIENT_ID } }));
  await sheets.beginAuthCodeFlow(WORKER);
  const savedState = JSON.parse(sessionStorage.getItem('anki_tool_oauth_pkce')).state;

  const { replaced } = fakeWindow(`?code=AUTH_CODE&state=${savedState}&scope=x`);
  const tokenCalls = mockWorker(() => ({
    body: { access_token: 'ya29.first', expires_in: 3600, refresh_token: 'RT-1' },
  }));
  const okResult = await sheets.completeAuthCodeFlowIfReturning();

  if (okResult.handled && !okResult.error) ok('認可コードを受け取ってトークン交換できる');
  else fail(`トークン交換に失敗した: ${JSON.stringify(okResult)}`);

  const tokenReq = tokenCalls.find((c) => c.url === `${WORKER}/token`);
  if (tokenReq && tokenReq.method === 'POST' && tokenReq.body.code === 'AUTH_CODE'
      && tokenReq.body.code_verifier && tokenReq.body.redirect_uri === `${ORIGIN}${PATHNAME}`) {
    ok('Workerの /token へ code / code_verifier / redirect_uri を送る');
  } else {
    fail(`/token のリクエストが想定と違う: ${JSON.stringify(tokenReq)}`);
  }

  if (sheets.getStoredRefreshToken() === 'RT-1' && sheets.isSignedIn()) {
    ok('リフレッシュトークンを保存し、ログイン済みになる');
  } else {
    fail(`リフレッシュトークンが保存されていない: ${sheets.getStoredRefreshToken()}`);
  }

  // 認可コードはURLに残すと再読み込みで二重に使われてエラーになる。
  if (replaced.length === 1 && !replaced[0].includes('code=') && !replaced[0].includes('state=')) {
    ok('URLから認可コード等のパラメータを取り除く');
  } else {
    fail(`URLの掃除ができていない: ${JSON.stringify(replaced)}`);
  }

  if (!sessionStorage.getItem('anki_tool_oauth_pkce')) ok('使い終わった code_verifier を破棄する');
  else fail('code_verifier が残っている');

  // --- アクセストークンの無言での取り直し ------------------------------------
  sheets.clearAccessToken();          // ページを開き直した直後に相当
  if (sheets.isSignedIn()) {
    ok('アクセストークンが手元に無くても、リフレッシュトークンがあればログイン済み扱い');
  } else {
    fail('リフレッシュトークンがあるのに未ログイン扱いになっている');
  }

  const refreshCalls = mockWorker(() => ({ body: { access_token: 'ya29.second', expires_in: 3600 } }));
  const refreshed = await sheets.getAccessToken({ workerUrl: WORKER });
  const refreshReq = refreshCalls.find((c) => c.url === `${WORKER}/refresh`);
  if (refreshed === 'ya29.second' && refreshReq?.body.refresh_token === 'RT-1') {
    ok('期限切れ時は /refresh で無言で取り直す(利用者の操作は不要)');
  } else {
    fail(`リフレッシュできていない: ${refreshed} / ${JSON.stringify(refreshReq)}`);
  }

  // 有効なトークンが手元にある間は Worker を呼ばない。
  const cachedCalls = mockWorker(() => ({ body: {} }));
  const cached = await sheets.getAccessToken({ workerUrl: WORKER });
  if (cached === 'ya29.second' && cachedCalls.length === 0) {
    ok('有効なアクセストークンがある間は Worker を呼ばない');
  } else {
    fail(`余計なリフレッシュが走っている: ${cachedCalls.length}件`);
  }

  // --- 失効(invalid_grant)の扱い ---------------------------------------------
  // 同意画面が「テスト」ステータスのままだと7日で失効する。ここで保存済みの
  // トークンを捨てないと、以後ずっと同じエラーを繰り返して復帰できなくなる。
  sheets.clearAccessToken();
  mockWorker(() => ({ status: 400, body: { error: 'invalid_grant', detail: 'Token has been expired or revoked.' } }));
  let expiredError = null;
  try {
    await sheets.getAccessToken({ workerUrl: WORKER });
  } catch (e) {
    expiredError = e;
  }
  if (expiredError instanceof SheetsAuthError && expiredError.message.includes('有効期限')) {
    ok('invalid_grant は「ログインし直してください」の案内になる');
  } else {
    fail(`invalid_grant の扱いが想定と違う: ${expiredError?.message}`);
  }
  if (sheets.getStoredRefreshToken() === null && !sheets.isSignedIn()) {
    ok('失効したリフレッシュトークンは破棄する(再ログインへ誘導できる)');
  } else {
    fail('失効したリフレッシュトークンが残っている');
  }

  // --- ログアウト -------------------------------------------------------------
  fakeWindow();
  mockWorker(() => ({ body: { client_id: CLIENT_ID } }));
  await sheets.beginAuthCodeFlow(WORKER);
  const st2 = JSON.parse(sessionStorage.getItem('anki_tool_oauth_pkce')).state;
  fakeWindow(`?code=C2&state=${st2}`);
  mockWorker(() => ({ body: { access_token: 'ya29.third', expires_in: 3600, refresh_token: 'RT-2' } }));
  await sheets.completeAuthCodeFlowIfReturning();

  sheets.signOut();
  if (sheets.getStoredRefreshToken() === null && !sheets.isSignedIn()) {
    ok('ログアウトでリフレッシュトークンごと破棄する');
  } else {
    fail('ログアウトしてもリフレッシュトークンが残っている');
  }

  // --- 通常の起動(戻りではない)は何もしない ----------------------------------
  fakeWindow('?foo=bar');
  const idleCalls = mockWorker(() => ({ body: {} }));
  const idle = await sheets.completeAuthCodeFlowIfReturning();
  if (idle.handled === false && idleCalls.length === 0) {
    ok('通常の起動(codeが無い)ではトークン交換を行わない');
  } else {
    fail(`通常起動で余計な処理が走った: ${JSON.stringify(idle)}`);
  }
}

// ---------------------------------------------------------------------------
// [7] 401 を受けたときのアクセストークン自動リトライ(2026-08-05追加)
//
// Worker方式はリフレッシュトークンを持っているのに、以前は 401 のたびに
// 「もう一度同じ操作をしてください」と手動の再実行を求めていた。長い操作
// (添削→シート追記→習熟用生成)の途中で期限が切れると最初からやり直しに
// なるため、sheetsFetch が1回だけ自動でトークンを取り直して再送するようにした。
//
// ここで固定するのは次の3点:
//   - Worker方式では 401 → /refresh → 新しいトークンで再送、まで自動で通ること
//   - リトライは1回だけで、それでも 401 なら SheetsAuthError を投げること
//   - 従来方式(B、Workerなし)では自動リトライしないこと
//     (取り直しに同意画面・ポップアップが要るため、操作していないのに
//      勝手にポップアップが出るのを避ける)
// ---------------------------------------------------------------------------
console.log('\n[7] 401時のアクセストークン自動リトライ');
{
  const sheets = await import(new URL('../docs/lib/sheets.js', import.meta.url));
  const WORKER = 'https://anki-tool-oauth.example.workers.dev';
  const SHEET_ROWS = { values: [HEADERS, ['id-1', '', 'A.', 'A.', '', '文法', '', '', '', '', '', '', '']] };

  /** Worker(text()を読む)と Sheets API(json()を読む)の両方を1つで捌くモック。 */
  function mockBoth({ onWorker, onSheets }) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', headers: init.headers || {} });
      if (String(url).startsWith(WORKER)) {
        const { status = 200, body } = await onWorker(url, init);
        return { ok: status < 300, status, text: async () => JSON.stringify(body) };
      }
      const { status = 200, body } = await onSheets(url, init, calls);
      if (status >= 300) return { ok: false, status, text: async () => JSON.stringify(body) };
      return { ok: true, status, json: async () => body };
    };
    return calls;
  }

  // --- Worker方式: 401 を1回受けても自動で回復する ----------------------------
  localStorage.clear();
  globalThis.window = dom.window; // localStorage 経由のトークン保存に必要
  sheets.signOut();

  // 事前に「ログイン済み(リフレッシュトークンあり)」の状態を作る。
  mockBoth({
    onWorker: () => ({ body: { access_token: 'ya29.first', expires_in: 3600, refresh_token: 'RT-1' } }),
    onSheets: () => ({ body: {} }),
  });
  await sheets.completeAuthCodeFlowIfReturning().catch(() => {});
  localStorage.setItem('anki_tool_google_refresh_token', 'RT-1');
  // getAccessToken で lastAuthOptions(= workerUrl)を覚えさせる。
  const firstToken = await sheets.getAccessToken({ workerUrl: WORKER });

  let sheetsHits = 0;
  const calls = mockBoth({
    onWorker: () => ({ body: { access_token: 'ya29.refreshed', expires_in: 3600 } }),
    onSheets: () => {
      sheetsHits += 1;
      // 1回目は期限切れ、2回目(取り直し後)は成功する。
      if (sheetsHits === 1) return { status: 401, body: { error: { message: 'Invalid Credentials' } } };
      return { body: SHEET_ROWS };
    },
  });

  const rows = await fetchPendingRows({
    spreadsheetId: 'SHEET_ID', sheetName: '添削結果', accessToken: firstToken,
  });

  if (rows.length === 1 && rows[0].id === 'id-1') {
    ok('401を受けても自動でトークンを取り直し、利用者の操作なしに成功する');
  } else {
    fail(`自動リトライで回復できていない: ${JSON.stringify(rows)}`);
  }

  const refreshCalls = calls.filter((c) => c.url === `${WORKER}/refresh`);
  if (refreshCalls.length === 1) ok('取り直しは /refresh を1回だけ呼ぶ');
  else fail(`/refresh の呼び出し回数が想定と違う: ${refreshCalls.length}`);

  const sheetCalls = calls.filter((c) => !String(c.url).startsWith(WORKER));
  if (sheetCalls.length === 2 && sheetCalls[1].headers.Authorization === 'Bearer ya29.refreshed') {
    ok('再送は取り直した新しいアクセストークンで行う');
  } else {
    fail(`再送のトークンが更新されていない: ${JSON.stringify(sheetCalls.map((c) => c.headers.Authorization))}`);
  }

  // --- リトライは1回だけ(無限ループにしない) ---------------------------------
  localStorage.setItem('anki_tool_google_refresh_token', 'RT-1');
  await sheets.getAccessToken({ workerUrl: WORKER });
  let alwaysUnauthorized = 0;
  mockBoth({
    onWorker: () => ({ body: { access_token: 'ya29.refreshed2', expires_in: 3600 } }),
    onSheets: () => {
      alwaysUnauthorized += 1;
      return { status: 401, body: { error: { message: 'Invalid Credentials' } } };
    },
  });

  let thrown = null;
  try {
    await fetchPendingRows({
      spreadsheetId: 'SHEET_ID', sheetName: '添削結果', accessToken: 'ya29.stale',
    });
  } catch (e) {
    thrown = e;
  }
  if (thrown instanceof SheetsAuthError && alwaysUnauthorized === 2) {
    ok('取り直しても401なら、2回目で打ち切って SheetsAuthError を投げる');
  } else {
    fail(`リトライ回数/例外の型が想定と違う: 回数=${alwaysUnauthorized} / ${thrown?.constructor?.name}`);
  }
  if (thrown && /ログインし直/.test(thrown.message)) {
    ok('打ち切り時のメッセージは手動での再ログインを案内する');
  } else {
    fail(`401のメッセージが想定と違う: ${thrown?.message}`);
  }

  // --- 従来方式(Workerなし)では自動リトライしない ------------------------------
  // 有効なアクセストークンを持たせた状態で workerUrl を空にして getAccessToken を
  // 呼ぶと、GIS を読み込まずに lastAuthOptions だけを従来方式へ切り替えられる
  // (jsdom には GIS のスクリプトが読み込めないため、この順序でないと止まる)。
  localStorage.setItem('anki_tool_google_refresh_token', 'RT-1');
  mockBoth({
    onWorker: () => ({ body: { access_token: 'ya29.valid', expires_in: 3600 } }),
    onSheets: () => ({ body: {} }),
  });
  await sheets.getAccessToken({ workerUrl: WORKER });
  localStorage.removeItem('anki_tool_google_refresh_token');
  await sheets.getAccessToken({ clientId: 'x', workerUrl: '' });

  let legacyHits = 0;
  mockBoth({
    onWorker: () => ({ body: {} }),
    onSheets: () => {
      legacyHits += 1;
      return { status: 401, body: { error: { message: 'Invalid Credentials' } } };
    },
  });
  await fetchPendingRows({
    spreadsheetId: 'SHEET_ID', sheetName: '添削結果', accessToken: 'ya29.legacy',
  }).catch(() => {});
  if (legacyHits === 1) {
    ok('従来方式(Workerなし)では自動リトライせず、1回で利用者に返す');
  } else {
    fail(`従来方式でリトライが走った: ${legacyHits} 回`);
  }
}

// ---------------------------------------------------------------------------
// [8] fetchAppConfig(Workerから設定一式を受け取る、2026-08-05追加)
//
// 新しい端末で使い始めるたびにAPIキー・スプレッドシートIDを手入力する手間を
// なくすための経路。Worker側の検証は test_worker.mjs が担当するので、ここでは
// 「アクセストークンを Authorization ヘッダーで送ること」と、失敗時に
// 分かるメッセージになることだけを固定する。
// ---------------------------------------------------------------------------
console.log('\n[8] fetchAppConfig(Workerからの設定の受け取り)');
{
  const sheets = await import(new URL('../docs/lib/sheets.js', import.meta.url));
  const WORKER = 'https://anki-tool-oauth.example.workers.dev';

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        spreadsheet_id: 'SHEET_ID', sheet_name: '添削結果',
        gemini_api_key: 'gemini-key', tts_api_key: null,
      }),
    };
  };

  const config = await sheets.fetchAppConfig(WORKER, 'ya29.token');
  if (config.spreadsheet_id === 'SHEET_ID' && config.gemini_api_key === 'gemini-key') {
    ok('Workerから設定一式を受け取れる');
  } else {
    fail(`受け取った設定が想定と違う: ${JSON.stringify(config)}`);
  }
  if (calls[0]?.url === `${WORKER}/appconfig`
      && calls[0]?.headers.Authorization === 'Bearer ya29.token') {
    ok('アクセストークンを Authorization: Bearer で送る');
  } else {
    fail(`リクエストが想定と違う: ${JSON.stringify(calls[0])}`);
  }
  if (config.tts_api_key === null) {
    ok('Worker側で未登録の項目は null のまま渡す(呼び出し側が反映しない判断に使う)');
  } else {
    fail(`未登録項目の扱いが想定と違う: ${config.tts_api_key}`);
  }

  // 末尾スラッシュ付きのURLでも二重スラッシュにならないこと
  calls.length = 0;
  await sheets.fetchAppConfig(`${WORKER}/`, 'ya29.token');
  if (calls[0]?.url === `${WORKER}/appconfig`) {
    ok('Worker URL の末尾スラッシュは無視する');
  } else {
    fail(`URLの正規化が効いていない: ${calls[0]?.url}`);
  }

  // 未ログイン・Worker未設定は呼ぶ前に弾く
  let thrown = null;
  try {
    await sheets.fetchAppConfig(WORKER, '');
  } catch (e) { thrown = e; }
  if (thrown instanceof SheetsAuthError) ok('未ログインなら呼び出す前に SheetsAuthError にする');
  else fail(`未ログイン時の扱いが想定と違う: ${thrown}`);

  thrown = null;
  try {
    await sheets.fetchAppConfig('', 'ya29.token');
  } catch (e) { thrown = e; }
  if (thrown instanceof SheetsAuthError) ok('Worker URL 未設定なら呼び出す前に SheetsAuthError にする');
  else fail(`Worker URL 未設定時の扱いが想定と違う: ${thrown}`);

  // Worker が 403 を返した場合(別アカウント・スコープ不足)
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: 'このアカウントには設定の取得を許可していません。' }),
  });
  thrown = null;
  try {
    await sheets.fetchAppConfig(WORKER, 'ya29.token');
  } catch (e) { thrown = e; }
  if (thrown && /設定の取得に失敗しました/.test(thrown.message)
      && /許可していません/.test(thrown.message)) {
    ok('失敗時は「トークン取得」ではなく「設定の取得」の失敗として伝える');
  } else {
    fail(`失敗時のメッセージが想定と違う: ${thrown?.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n✅ すべて成功しました。' : `\n❌ ${failures} 件失敗しました。`);
process.exitCode = failures === 0 ? 0 : 1;
