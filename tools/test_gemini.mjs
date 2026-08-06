// tools/test_gemini.mjs
// ---------------------------------------------------------------------------
// docs/lib/gemini.js の callGemini() のエラー処理・リトライ挙動を、
// fetchモックで単体検証する(実際のGemini APIは呼ばない)。
//
// 2026-07-28、片桐の環境で "503 UNAVAILABLE / This model is currently
// experiencing high demand" が発生し、それまで429(レート制限)しか
// リトライしていなかったため即座に生のエラーとして表示されていた問題への
// 対応(5xxも429と同じ回数だけ短い間隔でリトライするよう修正)を検証する。
//
// 【使い方】 cd tools && node test_gemini.mjs

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };

console.log('lib/gemini.js callGemini() の単体テスト\n');

const { callGemini, GeminiError } = await import(new URL('../docs/lib/gemini.js', import.meta.url));

console.log('[1] 503(一時的な過負荷)の挙動');

{
  // gemini_client._post_gemini_requestと同じMAX_RETRIES=2に合わせ、
  // 1回目503→2回目成功、を検証する。
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.', status: 'UNAVAILABLE' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    };
  };
  const text = await callGemini('hello', 'k', 'gemini-2.0-flash');
  if (calls === 2 && text === 'ok') ok('503は自動リトライし、2回目で成功すればテキストを返す');
  else fail(`503リトライの挙動が想定外(calls=${calls}, text=${text})`);
}

{
  // MAX_RETRIES回とも503が続く場合は、分かりやすいメッセージのGeminiErrorで打ち切る。
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 503, text: async () => 'UNAVAILABLE' };
  };
  try {
    await callGemini('hello', 'k', 'gemini-2.0-flash');
    fail('503が続く場合は最終的に例外を投げるべき');
  } catch (e) {
    if (e instanceof GeminiError && e.message.includes('混雑') && calls === 2) {
      ok('503が続く場合は「一時的に混雑しています」という分かりやすいメッセージで打ち切る');
    } else {
      fail(`想定外のエラー(calls=${calls}): ${e}`);
    }
  }
}

console.log('\n[2] 429の既存の挙動(回帰確認)');

{
  // 1日あたりの上限超過はリトライせず即座に打ち切る(5xxのリトライ追加で
  // 壊れていないことの回帰確認)。
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => 'Quota exceeded for quota metric PerDay' };
  };
  try {
    await callGemini('hello', 'k', 'gemini-2.0-flash');
    fail('1日あたりのQuota超過はリトライせず即座に例外を投げるべき');
  } catch (e) {
    if (e instanceof GeminiError && calls === 1) ok('1日あたりのQuota超過は1回で打ち切る(5xxリトライ追加後も回帰なし)');
    else fail(`想定外(calls=${calls}): ${e}`);
  }
}

{
  // 課金エラーも同様にリトライしないことを確認。
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => 'Your prepayment credits are depleted.' };
  };
  try {
    await callGemini('hello', 'k', 'gemini-2.0-flash');
    fail('課金エラーはリトライせず即座に例外を投げるべき');
  } catch (e) {
    if (e instanceof GeminiError && e.message.includes('前払いクレジット') && calls === 1) {
      ok('前払いクレジット切れは1回で打ち切る(5xxリトライ追加後も回帰なし)');
    } else {
      fail(`想定外(calls=${calls}): ${e}`);
    }
  }
}

console.log('\n[3] 無料枠の上限超過を「前払いクレジット切れ」と取り違えないこと');

{
  // 2026-08-06: Googleが**ただの無料枠超過**で返す標準の文面には
  // "please check your plan and billing details" が含まれる。
  // isBillingError が単なる "billing" で判定していたため、片桐の環境で
  // 20回/日の無料枠にぶつかっただけなのに「前払いクレジットが尽きている、
  // 新しいプロジェクトでキーを作り直せ」という**そのとおりに操作しても
  // 解決しない案内**が表示されていた。
  const realBody = JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaDimensions: { model: 'gemini-3.5-flash' },
          quotaValue: '20',
        }],
      }],
    },
  });
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => realBody });
  try {
    await callGemini('hello', 'k', 'gemini-3.5-flash');
    fail('無料枠の上限超過は例外を投げるべき');
  } catch (e) {
    if (e.message.includes('前払いクレジット')) {
      fail('ただの無料枠超過を「前払いクレジット切れ」と誤判定している');
    } else if (e.message.includes('1日あたりのリクエスト数上限')) {
      ok('本文に "billing" を含んでいても、無料枠の1日あたり上限として正しく案内する');
    } else {
      fail(`想定外のメッセージ: ${e.message.slice(0, 120)}`);
    }
  }
}

console.log(`\n${failures === 0 ? '✅ 全テスト成功' : `❌ ${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
