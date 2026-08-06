// quota.js
// ---------------------------------------------------------------------------
// Gemini API の呼び出し回数を「日付 × モデル」ごとに数え、上限に対する
// 使用率を表示できるようにする(2026-08-06追加)。
//
// 【なぜ上限値をソースに書かないか】
// 片桐からの指摘:「AIの上限はすぐに変更になることが多いので、カウンターだと
// 無意味になる可能性が高い」。実際そのとおりで、陳腐化するのは**上限値**
// だけであり、「今日何回呼んだか」という数字自体は古くならない。そこで
// この2つを分離し、
//   - 回数 … このモジュールが数える(常に正しい)
//   - 上限 … **Google が 429 の応答本文で自分から教えてくれる値**を学習する
// という設計にしてある。ソースには上限の数字を一切書かないので、Google が
// 上限を変更しても、次に一度ぶつかった時点で自動的に新しい値へ入れ替わる。
//
// 429 の応答本文には次の形で上限が入っている(2026-08-06に片桐の環境で実際に
// 返ってきたもの):
//   "violations": [{
//     "quotaMetric": "generativelanguage.googleapis.com/generate_content_free_tier_requests",
//     "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
//     "quotaDimensions": { "model": "gemini-3.5-flash", "location": "global" },
//     "quotaValue": "20"
//   }]
//
// 【限界(先に把握しておくこと)】
// - Google は**プロジェクト単位**で数えるため、複数の端末・ブラウザから
//   同じAPIキーを使うと、この端末のカウンタは実際より少なく出る。
//   (同期の `_AppSync` に載せれば揃えられるが、まずはローカルで十分と判断)
// - 上限を一度も観測していないモデルでは分母を表示しない。推測で埋めると、
//   まさに片桐が懸念した「古い数字を信じてしまう」状態になるため。

const STORAGE_KEY = 'anki_tool_gemini_usage';

/**
 * 無料枠の1日あたり上限(RPD)は**太平洋時間**の深夜にリセットされるため、
 * 端末のローカル日付ではなく太平洋時間の日付でバケットを切る。
 * (日本時間だと、日付が変わってもGoogle側のカウンタはまだ戻っていない、
 *  という食い違いが毎日起きる)
 */
export function quotaDateString(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // タイムゾーンデータを持たない実行環境向けのフォールバック。
    return now.toISOString().slice(0, 10);
  }
}

function emptyState() {
  // counts は日付が変わると捨てる。limits は「学習した知識」なので持ち越す。
  return { date: quotaDateString(), counts: {}, limits: {} };
}

function readState() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    const state = {
      date: typeof parsed?.date === 'string' ? parsed.date : quotaDateString(),
      counts: (parsed && typeof parsed.counts === 'object' && parsed.counts) || {},
      limits: (parsed && typeof parsed.limits === 'object' && parsed.limits) || {},
    };
    const today = quotaDateString();
    if (state.date !== today) {
      state.date = today;
      state.counts = {};
    }
    return state;
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* プライベートモード等で書けなくても数え損なうだけなので無視する */ }
}

/**
 * generateContent を1回呼んだことを記録する。
 *
 * **リトライも1回として数えること**。Google 側は失敗したリクエストも
 * 割り当てとして数えるため、成功した論理呼び出しの数だけを数えると
 * 実際より少なく出てしまう(呼び出し元は fetch のたびにこれを呼ぶ)。
 */
export function recordRequest(model) {
  const key = (model || '').trim();
  if (!key) return;
  const state = readState();
  state.counts[key] = (state.counts[key] || 0) + 1;
  writeState(state);
}

/**
 * 429 の応答本文から「1日あたりの上限」を取り出す。
 * 日次(quotaId に PerDay を含む)のものだけを対象にする——分あたりの
 * レート制限(RPM)の値を日次の分母として覚えてしまわないため。
 *
 * @returns {{value:number, quotaId:string, model:string}|null}
 */
export function extractDailyQuotaLimit(detail) {
  let parsed;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  for (const d of parsed?.error?.details || []) {
    for (const v of d?.violations || []) {
      const quotaId = String(v?.quotaId || '');
      if (!quotaId.replace(/[\s_-]/g, '').toLowerCase().includes('perday')) continue;
      const value = Number(v?.quotaValue);
      if (!Number.isFinite(value) || value <= 0) continue;
      return { value, quotaId, model: String(v?.quotaDimensions?.model || '') };
    }
  }
  return null;
}

/**
 * 429 の応答本文を見て、日次上限が書かれていれば学習して保存する。
 * @param {string} requestModel リクエストに使ったモデル名(応答に model が
 *   入っていない場合のフォールバック)
 * @returns {{value:number, quotaId:string, model:string}|null} 学習した内容
 */
export function learnDailyQuotaLimit(requestModel, detail) {
  const found = extractDailyQuotaLimit(detail);
  if (!found) return null;
  const key = (found.model || requestModel || '').trim();
  if (!key) return null;

  const state = readState();
  state.limits[key] = {
    value: found.value,
    quota_id: found.quotaId,
    observed_at: new Date().toISOString(),
  };
  writeState(state);
  return { ...found, model: key };
}

/** モデル1つぶんの使用状況を返す。 */
export function getUsage(model) {
  const key = (model || '').trim();
  const state = readState();
  const limit = state.limits[key];
  return {
    model: key,
    date: state.date,
    count: state.counts[key] || 0,
    limit: limit ? limit.value : null,
    quotaId: limit ? limit.quota_id : null,
    observedAt: limit ? limit.observed_at : null,
  };
}

/** 今日1回以上呼んだモデル、および上限を学習済みのモデルの一覧を返す。 */
export function getAllUsage() {
  const state = readState();
  const models = new Set([...Object.keys(state.counts), ...Object.keys(state.limits)]);
  return [...models]
    .map((m) => getUsage(m))
    .filter((u) => u.count > 0 || u.limit !== null)
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/**
 * ステータス表示に添える短い文言。
 * 上限を観測していなければ分母を出さない(推測の数字を出さないため)。
 */
export function usageSummary(model) {
  const u = getUsage(model);
  if (!u.model) return '';
  return u.limit ? `今日 ${u.count}/${u.limit}回` : `今日 ${u.count}回`;
}

/** 今日のカウントだけを消す(学習した上限は残す)。 */
export function clearCounts() {
  const state = readState();
  state.counts = {};
  writeState(state);
}

/** 学習した上限を忘れる(別のティア・別プロジェクトのキーに変えたとき用)。 */
export function clearLearnedLimits() {
  const state = readState();
  state.limits = {};
  writeState(state);
}
