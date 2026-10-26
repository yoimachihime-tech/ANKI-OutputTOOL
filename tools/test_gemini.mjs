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

// 2026-10-05追加: モデル一覧のページ送り・文章生成に使えないモデルの除外
console.log('\n[4] listModels / isNonTextModel / isGeminiTtsModel');
{
  const { listModels, isNonTextModel, isGeminiTtsModel } = await import(new URL('../docs/lib/gemini.js', import.meta.url));
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page2 = String(url).includes('pageToken=NEXT');
    return {
      ok: true,
      status: 200,
      json: async () => (page2
        ? { models: [{ name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] }] }
        : {
          models: [
            { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'NEXT',
        }),
    };
  };
  const names = await listModels('k');
  if (urls.length === 2 && JSON.stringify(names) === JSON.stringify(['gemini-3.8-flash-tts', 'gemini-flash-latest'])) {
    ok('ページ送り(nextPageToken)をたどって全件を取得する(2ページ目のモデルも落とさない)');
  } else {
    fail(`listModels: ${urls.length} 回 / ${JSON.stringify(names)}`);
  }
  const textOk = ['gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'].every((n) => !isNonTextModel(n));
  const nonText = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-image', 'lyria-3-pro-preview']
    .every((n) => isNonTextModel(n));
  if (textOk && nonText) ok('音声合成・画像・音楽生成のモデルは、カード生成用のモデル一覧から外す');
  else fail('isNonTextModel の判定が想定外');
  if (isGeminiTtsModel('gemini-3.8-flash-lite-tts') && isGeminiTtsModel('gemini-2.5-pro-preview-tts')
      && !isGeminiTtsModel('gemini-flash-latest')) {
    ok('TTS用モデル(-tts)を見分けられる');
  } else {
    fail('isGeminiTtsModel の判定が想定外');
  }
}

console.log('\n[5] まとめて生成の対応付け・途中で止まったときの扱い(2026-10-26)');

{
  const { alignBatchResults, generateVocabCards } = await import(new URL('../docs/lib/gemini.js', import.meta.url));
  const e = (index, tag) => ({ index, tag });

  // index が重複したら、後の要素で空いた位置を埋めない(別の単語の内容が付くのを防ぐ)
  const dup = alignBatchResults([e(1, 'a'), e(2, 'b'), e(2, 'c')], 3);
  if (dup[0]?.tag === 'a' && dup[1]?.tag === 'b' && dup[2] === null) {
    ok('index が重複した要素は捨て、空いた位置は「生成できなかった」のまま残す');
  } else {
    fail(`重複 index の扱いが想定外: ${JSON.stringify(dup)}`);
  }
  // 0始まりで揃っていれば1つずらして読む(全件ずれるのを防ぐ)
  const zero = alignBatchResults([e(0, 'a'), e(1, 'b'), e(2, 'c')], 3);
  if (zero.map((x) => x?.tag).join() === 'a,b,c') ok('0始まりの index は1つずらして読む');
  else fail(`0始まりの扱いが想定外: ${JSON.stringify(zero)}`);
  // index が1つも無ければ並び順のまま
  const none = alignBatchResults([{ tag: 'a' }, { tag: 'b' }], 3);
  if (none.map((x) => x?.tag ?? null).join() === 'a,b,') ok('index が無い応答は並び順のまま使う');
  else fail(`index なしの扱いが想定外: ${JSON.stringify(none)}`);
  // 数字の文字列も index として読む
  const str = alignBatchResults([e('2', 'b'), e('1', 'a')], 2);
  if (str.map((x) => x?.tag).join() === 'a,b') ok('数字の文字列の index も読む');
  else fail(`文字列 index の扱いが想定外: ${JSON.stringify(str)}`);

  // 11件 = 2回に分けて呼ぶ。2回目が日次上限で失敗しても、1回目の10件は返す
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (calls === 1) {
      const items = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, meaning: `m${i + 1}` }));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] }) };
    }
    return {
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }] } }),
    };
  };
  const pairs = Array.from({ length: 11 }, (_, i) => ({ word: `w${i + 1}`, context: '' }));
  try {
    const cards = await generateVocabCards({ pairs, apiKey: 'k', model: 'm', promptTemplate: '{{count}} {{items}}' });
    if (cards.length === 11 && cards.slice(0, 10).every(Boolean) && cards[10] === null
        && typeof cards.batchError === 'string' && cards.batchError.length > 0) {
      ok('途中のまとまりが失敗しても、それまでに生成できた分は返す(理由は batchError に入る)');
    } else {
      fail(`途中で失敗したときの戻り値が想定外: ${cards.length}件 / batchError=${cards.batchError}`);
    }
  } catch (err) {
    fail(`1回目の成功分まで失われた: ${err.message.slice(0, 60)}`);
  }
  // 1回目から失敗したら、従来どおり例外にする
  calls = 1;
  try {
    await generateVocabCards({ pairs: pairs.slice(0, 3), apiKey: 'k', model: 'm', promptTemplate: '{{count}} {{items}}' });
    fail('最初のまとまりが失敗したのに例外にならない');
  } catch (err) {
    if (err instanceof GeminiError) ok('最初のまとまりから失敗したときは従来どおり例外にする');
    else fail(`想定外の例外: ${err}`);
  }
}

console.log(`\n${failures === 0 ? '✅ 全テスト成功' : `❌ ${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
