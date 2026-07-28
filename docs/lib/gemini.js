// gemini.js
// ---------------------------------------------------------------------------
// Gemini API(Generative Language API)をブラウザから直接呼ぶ。
// デスクトップ版の gemini_client.py に対応する Web 版。
//
// 【APIキーについて】
// 利用者がページ上で入力し localStorage に保存する方式(2026-07-28、片桐が選択)。
// **リポジトリにもこのソースにも API キーを絶対に書かないこと。**
// リポジトリ自体は非公開だが、GitHub Pages で公開したページの JavaScript は
// 誰でも閲覧できるため、ハードコードは鍵の流出・不正課金に直結する。
//
// 【CORS】
// generativelanguage.googleapis.com は x-goog-api-key ヘッダを含む
// クロスオリジン要求を許可しているため、プロキシ無しで直接呼べる
// (2026-07-28 に実測して確認済み)。

const ENDPOINT_TMPL =
  'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';

// 429(レート制限)時のリトライ。gemini_client.py と同じ考え方で、
// 1日あたりの上限と判定できる場合は待っても回復しないので即座に諦める。
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

export class GeminiError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** エラー本文から Google が示す retryDelay("17s")をミリ秒で取り出す。 */
function extractRetryDelayMs(detail) {
  try {
    const parsed = JSON.parse(detail);
    for (const d of parsed?.error?.details || []) {
      if (typeof d.retryDelay === 'string' && d.retryDelay.endsWith('s')) {
        const sec = parseFloat(d.retryDelay.slice(0, -1));
        if (!Number.isNaN(sec)) return sec * 1000;
      }
    }
  } catch { /* JSON でなければ既定値を使う */ }
  return null;
}

/**
 * 1日あたりの上限(RPD)超過かを判定する。
 * gemini_client._is_daily_quota_error() と同じ判定
 * (quotaId に "PerDay" が含まれるか)。
 */
function isDailyQuotaError(detail) {
  return (detail || '').replace(/[\s_-]/g, '').toLowerCase().includes('perday');
}

/**
 * 403 などの失敗理由を、利用者が対処できる日本語の説明にする。
 * 判定できない場合は null を返す(その場合は生のレスポンスをそのまま見せる)。
 *
 * 特に「本番用キー(ウェブサイト制限あり)を localhost で使ってしまった」は
 * この構成では起こりやすいため、原因と対処が分かるようにしている。
 */
function describeError(status, detail) {
  const n = (detail || '').replace(/[\s_-]/g, '').toLowerCase();

  if (n.includes('referer') || n.includes('referrer')) {
    return 'このAPIキーには「ウェブサイト(HTTPリファラー)」制限がかかっており、'
      + '今開いているアドレスからは使えません。\n'
      + 'localhost で動作確認する場合は、アプリケーションの制限が「なし」の'
      + '開発用キーを使ってください(localhost はウェブサイト制限に登録できません)。';
  }
  if (n.includes('apikeyserviceblocked')) {
    return 'このAPIキーの「APIの制限」で Gemini API が許可されていません。\n'
      + 'キーの設定で対象APIに Gemini API を含めてください。';
  }
  if (n.includes('apikeyinvalid') || status === 401) {
    return 'APIキーが無効です。⚙設定のキーを確認してください。';
  }
  if (n.includes('servicedisabled') || n.includes('hasnotbeenused')) {
    return 'このプロジェクトで Gemini API が有効化されていません。\n'
      + 'Google Cloud Console の「APIとサービス → ライブラリ」で有効にしてください。';
  }
  if (status === 403) {
    return 'Gemini API へのアクセスが拒否されました(403)。APIキーの制限設定を確認してください。';
  }
  return null;
}

/**
 * Gemini にプロンプトを投げ、応答テキストを返す。
 * @param {string} prompt
 * @param {string} apiKey
 * @param {string} model 例: "gemini-2.0-flash"
 */
export async function callGemini(prompt, apiKey, model) {
  if (!apiKey) throw new GeminiError('Gemini APIキーが設定されていません。');

  const url = ENDPOINT_TMPL.replace('{model}', encodeURIComponent(model));
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

  let lastDetail = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        throw new GeminiError(`Gemini APIの応答形式が想定と異なります: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return text;
    }

    lastDetail = await res.text();

    if (res.status === 429) {
      if (isDailyQuotaError(lastDetail)) {
        throw new GeminiError(
          'Gemini APIの1日あたりのリクエスト数上限に達しました。時間を置いてもすぐには'
          + '回復しないため、リトライは行わず打ち切りました。翌日まで待つか、別のモデルを'
          + `お試しください。\n詳細: ${lastDetail}`,
        );
      }
      if (attempt < MAX_RETRIES - 1) {
        const delay = extractRetryDelayMs(lastDetail) ?? DEFAULT_RETRY_DELAY_MS;
        await sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
        continue;
      }
      throw new GeminiError(`Gemini APIの利用上限(レート制限)に達しました。\n詳細: ${lastDetail}`);
    }

    const described = describeError(res.status, lastDetail);
    throw new GeminiError(
      described
        ? `${described}\n\n詳細: ${lastDetail}`
        : `Gemini API呼び出しに失敗しました(HTTP ${res.status}): ${lastDetail}`,
    );
  }
  throw new GeminiError(`Gemini API呼び出しに失敗しました: ${lastDetail}`);
}

/** 応答から JSON オブジェクトを取り出す(```json フェンス付きにも対応)。 */
export function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fence ? fence[1] : text.trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new GeminiError(`Gemini応答をJSONとして解析できませんでした: ${text.slice(0, 300)}`);
  }
}

/** `{{name}}` 形式のプレースホルダを置換する(gemini_client._fill_placeholders と同じ)。 */
export function fillPlaceholders(template, values) {
  let out = template;
  for (const [name, value] of Object.entries(values)) {
    out = out.split(`{{${name}}}`).join(String(value));
  }
  return out;
}

/**
 * 単語と文脈から単語カードの item を1件生成する。
 * gemini_client.generate_vocab_card_from_word() に対応。
 * word はAIに生成させず入力値をそのまま使う(表記ゆれ防止)。
 */
export async function generateVocabCard({ word, contextSentence, apiKey, model, promptTemplate }) {
  const prompt = fillPlaceholders(promptTemplate, {
    word,
    context_sentence: contextSentence,
  });
  const parsed = extractJson(await callGemini(prompt, apiKey, model));
  return {
    word: word.trim(),
    reading: parsed.reading || '',
    pos: parsed.pos || '',
    meaning: parsed.meaning || '',
    example: parsed.example || '',
    example_ja: parsed.example_ja || '',
    example_blank: parsed.example_blank || '',
    note: parsed.note || '',
    context_sentence: (contextSentence || '').trim(),
  };
}

/** generateContent に対応しているモデル名の一覧を取得する。 */
export async function listModels(apiKey) {
  if (!apiKey) throw new GeminiError('Gemini APIキーが設定されていません。');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) {
    const detail = await res.text();
    const described = describeError(res.status, detail);
    throw new GeminiError(
      described
        ? `${described}\n\n詳細: ${detail}`
        : `Geminiモデル一覧の取得に失敗しました: ${detail}`,
    );
  }
  const data = await res.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => (m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}
