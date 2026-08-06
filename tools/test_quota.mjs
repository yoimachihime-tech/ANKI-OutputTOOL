// tools/test_quota.mjs
// ---------------------------------------------------------------------------
// docs/lib/quota.js(Gemini APIの呼び出し回数カウンタ)の単体テスト。
//
// 2026-08-06、片桐の環境で gemini-3.5-flash の無料枠(20回/日)にぶつかったこと
// への対応。片桐からの指摘「AIの上限はすぐに変更になることが多いので、
// カウンターだと無意味になる可能性が高い」を踏まえ、**上限値はソースに書かず
// Googleの429応答から学習する**設計にしてある。ここではその要点を固定する:
//
//   - 上限は 429 応答の quotaValue から学習すること(ソースに数字を持たない)
//   - **日次(PerDay)の上限だけ**を学習すること(分あたりのRPMを日次の分母として
//     覚えてしまうと、実際よりずっと小さい分母が表示され誤解を招く)
//   - 日付が変わったらカウントは0に戻すが、**学習した上限は忘れない**こと
//   - リトライも1回として数えること(Google側は失敗したリクエストも
//     割り当てとして数えるため、成功数だけを数えると実際より少なく出る)
//
// 【使い方】 cd tools && node test_quota.mjs

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };

console.log('lib/quota.js(Gemini APIの使用状況)の単体テスト\n');

// --- 最小限の localStorage(gemini.js を読み込む前に用意しておくこと) -------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const STORAGE_KEY = 'anki_tool_gemini_usage';
const readRaw = () => JSON.parse(store.get(STORAGE_KEY) || '{}');

const quota = await import(new URL('../docs/lib/quota.js', import.meta.url));
const { callGemini, GeminiError } = await import(new URL('../docs/lib/gemini.js', import.meta.url));

/** 実際に片桐の環境が返した 429(日次の無料枠超過)の本文。 */
const DAILY_QUOTA_BODY = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          quotaDimensions: { model: 'gemini-3.5-flash', location: 'global' },
          quotaValue: '20',
        }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' },
    ],
  },
});

console.log('[1] 429応答からの上限の取り出し');

{
  const found = quota.extractDailyQuotaLimit(DAILY_QUOTA_BODY);
  if (found?.value === 20 && found.model === 'gemini-3.5-flash') {
    ok('quotaValue と対象モデルを取り出せる(ソースに固定の数字を持たない)');
  } else {
    fail(`取り出せなかった: ${JSON.stringify(found)}`);
  }
}

{
  // 分あたりのレート制限(RPM)。日次の分母として覚えてはいけない。
  const perMinute = JSON.stringify({
    error: {
      details: [{
        violations: [{
          quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          quotaDimensions: { model: 'gemini-3.5-flash' },
          quotaValue: '5',
        }],
      }],
    },
  });
  if (quota.extractDailyQuotaLimit(perMinute) === null) {
    ok('分あたり(PerMinute)の上限は学習しない');
  } else {
    fail('PerMinute の値を日次の上限として拾ってしまっている');
  }
}

if (quota.extractDailyQuotaLimit('not json at all') === null) {
  ok('JSONでない応答でも例外にせず null を返す');
} else {
  fail('壊れた応答の扱いが誤っている');
}

console.log('\n[2] 回数の記録と使用状況の取得');

store.clear();
quota.recordRequest('gemini-3.5-flash');
quota.recordRequest('gemini-3.5-flash');
quota.recordRequest('gemini-2.0-flash');

{
  const u = quota.getUsage('gemini-3.5-flash');
  if (u.count === 2 && u.limit === null) {
    ok('モデルごとに回数を数える');
  } else {
    fail(`使用状況: ${JSON.stringify(u)}`);
  }
}

if (quota.usageSummary('gemini-3.5-flash') === '今日 2回') {
  ok('上限を観測していないうちは分母を出さない(推測の数字を見せない)');
} else {
  fail(`表示文言: ${quota.usageSummary('gemini-3.5-flash')}`);
}

quota.learnDailyQuotaLimit('gemini-3.5-flash', DAILY_QUOTA_BODY);

if (quota.usageSummary('gemini-3.5-flash') === '今日 2/20回') {
  ok('上限を学習すると分母付きで表示される');
} else {
  fail(`表示文言: ${quota.usageSummary('gemini-3.5-flash')}`);
}

{
  const rows = quota.getAllUsage();
  const models = rows.map((r) => r.model);
  if (models.includes('gemini-3.5-flash') && models.includes('gemini-2.0-flash')) {
    ok('getAllUsage が今日使ったモデルをすべて返す');
  } else {
    fail(`一覧: ${JSON.stringify(models)}`);
  }
}

console.log('\n[3] 日付が変わったときの扱い');

{
  // 保存済みの状態を「昨日」のものに書き換えてから読み直す。
  const state = readRaw();
  state.date = '2000-01-01';
  store.set(STORAGE_KEY, JSON.stringify(state));

  const u = quota.getUsage('gemini-3.5-flash');
  if (u.count === 0) ok('日付が変わると回数は0に戻る');
  else fail(`回数が残っている: ${u.count}`);

  if (u.limit === 20) {
    ok('学習した上限は日付が変わっても忘れない(毎日ぶつかり直さなくてよい)');
  } else {
    fail(`上限が失われた: ${u.limit}`);
  }
}

console.log('\n[4] 明示的な消去');

quota.recordRequest('gemini-3.5-flash');
quota.clearCounts();
if (quota.getUsage('gemini-3.5-flash').count === 0 && quota.getUsage('gemini-3.5-flash').limit === 20) {
  ok('「今日の回数を0に戻す」は回数だけを消し、上限は残す');
} else {
  fail('clearCounts の挙動が誤っている');
}

quota.clearLearnedLimits();
if (quota.getUsage('gemini-3.5-flash').limit === null) {
  ok('「覚えた上限を忘れる」で上限だけを消せる(別プロジェクトのキーに変えたとき用)');
} else {
  fail('clearLearnedLimits の挙動が誤っている');
}

console.log('\n[5] gemini.js からの記録(リトライも1回として数える)');

{
  store.clear();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 429, text: async () => DAILY_QUOTA_BODY };
  };

  let message = '';
  try {
    await callGemini('hi', 'dummy-key', 'gemini-3.5-flash');
  } catch (e) {
    if (e instanceof GeminiError) message = e.message;
  }

  const u = quota.getUsage('gemini-3.5-flash');
  if (u.count === 1 && calls === 1) {
    ok('日次上限の429はリトライせず打ち切り、その1回ぶんだけ数える');
  } else {
    fail(`回数: ${u.count} / fetch: ${calls}`);
  }
  if (u.limit === 20) ok('429を受けた時点で上限を自動的に学習する');
  else fail(`上限を学習していない: ${u.limit}`);

  if (message.includes('1/20回')) {
    ok('エラーメッセージにその時点の使用状況が入る');
  } else {
    fail(`メッセージ: ${message.slice(0, 120)}`);
  }
}

{
  // 日次ではない 429(短期のレート制限)はリトライする。その各回も数えること。
  store.clear();
  const rateLimited = JSON.stringify({
    error: {
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          violations: [{
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
            quotaDimensions: { model: 'gemini-3.5-flash' },
            quotaValue: '5',
          }],
        },
        { retryDelay: '0s' },
      ],
    },
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => rateLimited };
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    };
  };

  await callGemini('hi', 'dummy-key', 'gemini-3.5-flash');

  const u = quota.getUsage('gemini-3.5-flash');
  if (u.count === 2) {
    ok('リトライした場合は失敗した1回も数える(Google側も割り当てを消費するため)');
  } else {
    fail(`回数: ${u.count}(期待:2)`);
  }
  if (u.limit === null) {
    ok('短期のレート制限(RPM)では日次の上限を学習しない');
  } else {
    fail(`日次でない上限を学習してしまっている: ${u.limit}`);
  }
}

console.log('\n[6] localStorage が使えない環境');

{
  const saved = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    quota.recordRequest('gemini-3.5-flash');
    quota.learnDailyQuotaLimit('gemini-3.5-flash', DAILY_QUOTA_BODY);
    const u = quota.getUsage('gemini-3.5-flash');
    if (u.count === 0 && u.limit === null) {
      ok('localStorage が無くても例外にならない(数え損なうだけ)');
    } else {
      fail(`予期しない値: ${JSON.stringify(u)}`);
    }
  } catch (e) {
    fail(`例外になった: ${e.message}`);
  } finally {
    globalThis.localStorage = saved;
  }
}

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} 件の問題が見つかりました。`);
  process.exit(1);
}
console.log('✅ Gemini APIの使用状況カウンタは正常です。');
