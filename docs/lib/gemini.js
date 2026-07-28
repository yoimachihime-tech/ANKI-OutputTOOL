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
 * 429 のうち「課金・クレジット切れ」によるものかを判定する(2026-07-28追加)。
 *
 * Gemini API は前払いクレジットが尽きた場合も 429 RESOURCE_EXHAUSTED を返すが、
 * これは短期のレート制限とは違い待っても回復しない。以前はこれを
 * 「レート制限に達しました」と表示したうえリトライしており、原因が伝わらず
 * 無駄な呼び出しも発生していた(実際に片桐の環境で発生)。
 */
function isBillingError(detail) {
  const n = (detail || '').replace(/[\s_-]/g, '').toLowerCase();
  return n.includes('prepayment')
    || n.includes('billing')
    || (n.includes('credit') && n.includes('deplet'));
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
      if (isBillingError(lastDetail)) {
        throw new GeminiError(
          'Gemini APIの前払いクレジットが尽きているため利用できません'
          + '(レート制限ではないので、待っても回復しません)。\n\n'
          + '対処:\n'
          + '・無料で使いたい場合 … このAPIキーが「無料利用枠」のプロジェクトの'
          + 'ものか確認してください。有料設定のプロジェクトのキーだと、'
          + 'クレジットが尽きた時点で使えなくなります。\n'
          + '・有料で使う場合 … https://ai.studio/projects でクレジットを追加'
          + `してください。\n\n詳細: ${lastDetail}`,
        );
      }
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

/** 応答から JSON 配列を取り出す(gemini_client._extract_json_array と同じ)。 */
export function extractJsonArray(text) {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  const candidate = fence ? fence[1] : text.trim();
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new GeminiError(`Gemini応答をJSON配列として解析できませんでした: ${text.slice(0, 300)}`);
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

// ---------------------------------------------------------------------------
// Grammar Multi (文法・複数出題形式) — 「AIに質問」タブ
// gemini_client.py の同名関数群(_format_question_html /
// _prefix_answer_with_correct_opt / generate_grammar_multi_items_from_question)
// と処理内容を一致させてある。HTMLヘルパー(choice/whynotItem/exampleEn/
// exampleJa)は build_grammar_multi_v1_updated.py の choice()/whynot_item()/
// example_en()/example_ja() と同一の出力になるようにしている。
// ---------------------------------------------------------------------------

function gmChoice(opt, text) {
  return `<div class="choice">(${opt}) ${text}</div>`;
}

function gmWhynotItem(opt, reason) {
  return `<div class="whynot-item"><span class="opt">(${opt})</span> ${reason}</div>`;
}

function gmExampleEn(pairs) {
  return pairs.map(([en], i) => `<span class="ex-num">Ex${i + 1}.</span> ${en}`).join('<br>');
}

function gmExampleJa(pairs) {
  return pairs.map(([, ja]) => `└ ${ja}`).join('<br>');
}

// 日本語の指示文(「〜しなさい。」等)の直後に、改行なしで引用符付き英文が
// 続く箇所を検出する。Grammar MultiのQuestionフィールドはGeminiが
// 「指示文+英文」を1つの文字列として返すため、そのままでは
// 「選びなさい。'She showed...'」のように改行なしで並んでしまい読みにくい
// (Ankiフィールドはmustacheで生HTML展開されるため、改行させるには明示的な
// <br>が必要)。
const JA_EN_BOUNDARY_RE = /([。！？])\s*(?=["'“”‘’A-Za-z])/g;
// 英文側が複数文にわたる場合、文末(.!?)+空白+次の文の頭(引用符/大文字)の
// 境目でも改行する。
const EN_SENTENCE_BREAK_RE = /(?<=[.!?])\s+(?=["'A-Z])/g;

/** 日本語の指示文と英文の間、英文が複数文ある場合は文と文の間に<br>を挿入する。 */
function formatQuestionHtml(text) {
  if (!text) return text;
  let out = text.replace(JA_EN_BOUNDARY_RE, '$1<br><br>');
  // 既存の<br>を境に分割し、<br>以外の断片だけに文区切りの<br>を適用する
  // (挿入済みの<br><br>自体を誤って再分割しないため)。
  return out
    .split(/(<br\s*\/?>)/i)
    .map((part) => (/^<br\s*\/?>$/i.test(part) ? part : part.replace(EN_SENTENCE_BREAK_RE, '<br>')))
    .join('');
}

/**
 * 選択問題(choicesが空でない)の場合、Answerフィールドの先頭に正解の
 * 選択肢ラベル(例: "(B) ")を付ける。誤り訂正・記述式問題(choicesが空)の
 * 場合はanswerをそのまま返す。
 *
 * correctOpt(Geminiが返す正解のopt)がchoicesの実際のoptと一致しない・
 * 空文字などの場合は、answerとchoicesの各textを突き合わせて(前後空白・
 * 大小文字を無視)一致するものを探すフォールバックを行う。それでも
 * 特定できなければ記号無しのまま返す(誤った記号を付けるより安全)。
 */
function prefixAnswerWithCorrectOpt(answer, choices, correctOpt) {
  if (!choices || choices.length === 0 || !answer) return answer;
  const validOpts = new Set(
    choices.filter((c) => c.opt).map((c) => String(c.opt).trim().toUpperCase()),
  );
  let opt = String(correctOpt || '').trim().toUpperCase();
  if (!validOpts.has(opt)) {
    const normalizedAnswer = answer.trim().toLowerCase();
    opt = '';
    for (const c of choices) {
      if (String(c.text || '').trim().toLowerCase() === normalizedAnswer) {
        opt = String(c.opt || '').trim().toUpperCase();
        break;
      }
    }
  }
  return opt ? `(${opt}) ${answer}` : answer;
}

/**
 * 質問文から、Grammar Multi(文法・複数出題形式)の独立ノート3件分の
 * item を生成する(gemini_client.generate_grammar_multi_items_from_question
 * に対応)。戻り値の各itemはdocs/shared/card_defs.jsonの"grammar_multi"定義の
 * fields(pattern/question/choices/answer/example/example_ja/why/whynot)に
 * 加え、guid計算・重複検出用のtopic_key/note_indexを持つ。
 */
export async function generateGrammarMultiItems({ question, apiKey, model, promptTemplate }) {
  const prompt = fillPlaceholders(promptTemplate, { question });
  const text = await callGemini(prompt, apiKey, model);
  const parsed = extractJsonArray(text);
  if (!parsed || parsed.length === 0) {
    throw new GeminiError(`Gemini応答が空、または配列ではありません: ${text.slice(0, 300)}`);
  }

  const topicKey = question.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  return parsed.map((note, i) => {
    const choices = note.choices || [];
    const whynot = note.whynot || [];
    const examples = (note.examples || []).map((ex) => [ex[0], ex[1]]);
    return {
      pattern: note.pattern || '',
      question: formatQuestionHtml(note.question || ''),
      choices: choices.map((c) => gmChoice(c.opt || '', c.text || '')).join(''),
      answer: prefixAnswerWithCorrectOpt(note.answer || '', choices, note.correct_opt || ''),
      example: examples.length ? gmExampleEn(examples) : '',
      example_ja: examples.length ? gmExampleJa(examples) : '',
      why: note.why || '',
      whynot: whynot.map((w) => gmWhynotItem(w.opt || '', w.reason || '')).join(''),
      topic_key: topicKey,
      note_index: i,
    };
  });
}

// ---------------------------------------------------------------------------
// 習熟用(音読) — 「AIに質問」タブからの4問目
// gemini_client.py の _item_from_parsed() / generate_shuujuku_item_from_question()
// と処理内容を一致させてある。
// ---------------------------------------------------------------------------

/**
 * 質問文から、習熟用(音読)ストックに追加する item を1件生成する
 * (gemini_client.generate_shuujuku_item_from_question() に対応)。
 *
 * 戻り値は docs/lib/shuujuku.js の buildFieldsReadyItems() にそのまま渡せる
 * 形式(pattern/meaning/examples/expl/source_label)に加え、guid計算に使う
 * source_kind/source_topic を持つ(build_shuujuku_v1.build_guid()の
 * `kind, key = item['source_key']` に対応する2値を、Web側では
 * guid_scheme.item_keysが参照できるようフラットなフィールドとして持たせている。
 * docs/shared/card_defs.jsonのshuujuku.guid_scheme.item_keys = ["source_kind",
 * "source_topic"] と対応関係にあることに注意)。
 */
export async function generateShuujukuItem({ question, apiKey, model, promptTemplate }) {
  const prompt = fillPlaceholders(promptTemplate, { question });
  const text = await callGemini(prompt, apiKey, model);
  const parsed = extractJson(text);
  const topicKey = question.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  return {
    pattern: parsed.pattern || '',
    meaning: parsed.meaning || null,
    examples: parsed.examples || [],
    expl: parsed.expl || null,
    source_kind: 'chat',
    source_topic: topicKey,
    source_label: '由来: AIに質問',
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
