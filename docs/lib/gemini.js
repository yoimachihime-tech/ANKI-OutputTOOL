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

import { recordRequest, learnDailyQuotaLimit, usageSummary } from './quota.js';

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
 *
 * **単なる "billing" という語だけで判定してはいけない**(2026-08-06修正)。
 * Googleが無料枠の上限超過で返す標準の文面にも
 * "please check your plan and billing details" が含まれるため、以前の実装
 * (`n.includes('billing')`)だと**ただの無料枠20回/日の超過まで「前払い
 * クレジットが尽きている」と表示**していた。片桐が実際にこの誤った
 * メッセージ(「新しいプロジェクトでキーを作り直してください」)を受け取って
 * おり、そのとおりに操作しても解決しない案内になっていた。前払いクレジット
 * 切れの実際の文面は "Your prepayment credits are depleted." なので、
 * prepayment または credit+deplet だけで十分に判定できる。
 */
function isBillingError(detail) {
  const n = (detail || '').replace(/[\s_-]/g, '').toLowerCase();
  return n.includes('prepayment')
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
 * Gemini の generateContent にリクエストを投げ、応答 JSON をそのまま返す共通処理
 * (gemini_client._post_gemini_request() に対応)。429/5xx のリトライ判定と
 * エラーメッセージの日本語化はすべてここに集約する。
 *
 * @param {object} requestBody generateContent のリクエストボディ
 * @param {string} apiKey
 * @param {string} model 例: "gemini-2.0-flash"
 */
async function postGeminiRequest(requestBody, apiKey, model) {
  if (!apiKey) throw new GeminiError('Gemini APIキーが設定されていません。');

  const url = ENDPOINT_TMPL.replace('{model}', encodeURIComponent(model));
  const body = JSON.stringify(requestBody);

  let lastDetail = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    // 失敗したリクエストもGoogle側の割り当てを消費するため、成功時だけでなく
    // **fetchのたびに**数える(リトライも1回として数える)。
    recordRequest(model);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

    if (res.ok) return res.json();

    lastDetail = await res.text();

    if (res.status === 429) {
      // 上限値はソースに書かず、Googleが429で返してくる quotaValue を学習する
      // (上限は変わることがあるため。詳細は lib/quota.js の冒頭コメント)。
      learnDailyQuotaLimit(model, lastDetail);
      if (isBillingError(lastDetail)) {
        throw new GeminiError(
          'このAPIキーのプロジェクトは前払いクレジットが尽きているため利用できません'
          + '(レート制限ではないので、待っても回復しません)。\n\n'
          + '対処: 課金は必須ではありません。'
          + 'https://aistudio.google.com/apikey で「APIキーを作成」する際に、'
          + '既存のプロジェクトではなく「新しいプロジェクト」を選んでキーを作り直し、'
          + '⚙設定のキーを差し替えてください(2026-07-28にこの方法で解決済み)。\n'
          + '有料のまま使い続ける場合は https://ai.studio/projects で'
          + `クレジットを追加してください。\n\n詳細: ${lastDetail}`,
        );
      }
      if (isDailyQuotaError(lastDetail)) {
        throw new GeminiError(
          `Gemini APIの1日あたりのリクエスト数上限に達しました(${model}: ${usageSummary(model)})。`
          + '時間を置いてもすぐには回復しないため、リトライは行わず打ち切りました。\n'
          + '上限は太平洋時間の深夜にリセットされます。それまで待つか、⚙設定でより上限の'
          + '大きいモデルに切り替えてください(使用状況は⚙設定の「Gemini APIの使用状況」で'
          + `確認できます)。\n詳細: ${lastDetail}`,
        );
      }
      if (attempt < MAX_RETRIES - 1) {
        const delay = extractRetryDelayMs(lastDetail) ?? DEFAULT_RETRY_DELAY_MS;
        await sleep(Math.min(delay, MAX_RETRY_DELAY_MS));
        continue;
      }
      throw new GeminiError(`Gemini APIの利用上限(レート制限)に達しました。\n詳細: ${lastDetail}`);
    }

    if (res.status >= 500) {
      // Google側の一時的な過負荷(503 UNAVAILABLE「currently experiencing high
      // demand」等、2026-07-28に片桐の環境で発生)。429と違い長期の割り当て
      // 超過ではなく数秒〜数十秒待てば解消することが多いため、429と同じ回数
      // だけ短い間隔でリトライする(gemini_client._post_gemini_requestと同じ考え方)。
      if (attempt < MAX_RETRIES - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new GeminiError(
        'Gemini APIが一時的に混雑しています(モデルの需要が高い状態)。'
        + `しばらく時間をおいてから再試行してください。\n詳細: ${lastDetail}`,
      );
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

/** 応答 JSON から生成テキストを取り出す。 */
function textFromResponse(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new GeminiError(`Gemini APIの応答形式が想定と異なります: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return text;
}

/**
 * Gemini にプロンプトを投げ、応答テキストを返す。
 * @param {string} prompt
 * @param {string} apiKey
 * @param {string} model 例: "gemini-2.0-flash"
 */
export async function callGemini(prompt, apiKey, model) {
  return textFromResponse(
    await postGeminiRequest({ contents: [{ parts: [{ text: prompt }] }] }, apiKey, model),
  );
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

// ---------------------------------------------------------------------------
// まとめて生成(バッチ、2026-08-06追加)
//
// 以前は「単語N件 → N回」「添削結果N行 → N回」と1件ずつ直列に呼んでいた。
// 無料枠の1日あたりの上限は**リクエスト数**で数えられるため(2026-08-06に
// gemini-3.5-flash で 20回/日にぶつかった)、1件ずつ呼ぶ方式は上限に
// 極端に当たりやすい。上限値そのものは Google の都合でよく変わるので、
// 「上限がいくつであれ消費を1/N にする」こちらのほうが対策として本質的
// (片桐の指摘: 上限を追いかけるカウンタだけでは無意味になりやすい)。
//
// 添削(correctEnglishText)が既に「複数文を1回で投げ、配列で受け取る」形
// なので、それと同じ考え方を単語・習熟用にも広げたもの。
// ---------------------------------------------------------------------------

/**
 * 1回のリクエストに詰め込む件数の上限。
 *
 * 全件を1回に詰めないのは、件数が増えると応答が出力トークン上限で途中で
 * 切れ、**そのバッチが丸ごと失敗する**ため。10件ずつなら、失敗しても
 * 被害がそのバッチに限定される。
 */
export const BATCH_SIZE = 10;

/** items を BATCH_SIZE ごとの配列に分割する。 */
export function chunkForBatch(items, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * バッチ応答(オブジェクトの配列)を、入力の並び順に対応付け直す。
 *
 * 各要素の `index`(1始まり、プロンプトで必ず含めるよう指示している)を
 * 頼りにする。**配列の位置をそのまま信じない**のは、モデルが1件飛ばす・
 * 順序を入れ替えることがあり、そうなると別の単語の解説が付いたカードが
 * 静かに出来上がってしまうため(内容が入れ替わっても字面だけでは
 * 気づきにくい)。`index` が使えない要素だけ、埋まっていない位置へ
 * 順に詰める。
 *
 * @returns {Array<object|null>} 長さ count。生成されなかった位置は null。
 */
export function alignBatchResults(parsed, count) {
  const out = new Array(count).fill(null);
  const leftovers = [];

  for (const entry of Array.isArray(parsed) ? parsed : []) {
    if (!entry || typeof entry !== 'object') continue;
    const idx = Number(entry.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= count && out[idx - 1] === null) {
      out[idx - 1] = entry;
    } else {
      leftovers.push(entry);
    }
  }

  for (const entry of leftovers) {
    const slot = out.indexOf(null);
    if (slot === -1) break;
    out[slot] = entry;
  }
  return out;
}

/**
 * 単語と文脈から単語カードの item をまとめて生成する。
 * gemini_client.generate_vocab_cards_from_words() に対応。
 * word はAIに生成させず入力値をそのまま使う(表記ゆれ防止)。
 *
 * @param {Array<{word: string, context: string}>} pairs
 * @returns {Promise<Array<object|null>>} pairs と同じ長さ。生成できなかった
 *   件は null(呼び出し側がどの単語が失敗したかを利用者に伝えられるよう、
 *   詰めずに位置を保つ)。
 */
export async function generateVocabCards({ pairs, apiKey, model, promptTemplate, onProgress }) {
  const results = new Array(pairs.length).fill(null);
  const chunks = chunkForBatch(pairs);
  let done = 0;

  for (const chunk of chunks) {
    const offset = done;
    if (onProgress) onProgress(done, pairs.length);

    const lines = chunk.map((p, i) => {
      const context = (p.context || '').trim();
      return `[${i + 1}] 単語: ${p.word}\n    文脈: ${context || '(なし)'}`;
    }).join('\n');

    const prompt = fillPlaceholders(promptTemplate, {
      count: String(chunk.length),
      items: lines,
    });
    const parsed = extractJsonArray(await callGemini(prompt, apiKey, model));

    alignBatchResults(parsed, chunk.length).forEach((entry, i) => {
      if (!entry) return;
      const { word, context } = chunk[i];
      results[offset + i] = {
        word: word.trim(),
        reading: entry.reading || '',
        pos: entry.pos || '',
        meaning: entry.meaning || '',
        example: entry.example || '',
        example_ja: entry.example_ja || '',
        example_blank: entry.example_blank || '',
        note: entry.note || '',
        context_sentence: (context || '').trim(),
      };
    });
    done += chunk.length;
  }

  if (onProgress) onProgress(done, pairs.length);
  return results;
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
// 次の断片の先頭が引用符・英字に加えて「(1)」のような連番ラベルの場合も
// 境界とみなす(2026-07-29追加)。「記述式・書き換え問題」でGeminiが
// 「(1) Good lighting helps. (2) It makes the room look spacious.」のように
// 引用符を使わず連番ラベルだけで文を並べることがあり、そのままだと
// 改行が一切入らず1つの段落になってしまっていたための対応。
const SENTENCE_BOUNDARY_LOOKAHEAD = '(?:["\'“”‘’A-Za-z]|\\(\\d+\\))';
const JA_EN_BOUNDARY_RE = new RegExp(`([。！？])\\s*(?=${SENTENCE_BOUNDARY_LOOKAHEAD})`, 'g');
// 英文側が複数文にわたる場合、文末(.!?)+空白+次の文の頭(引用符/大文字/
// 連番ラベル)の境目でも改行する。
const EN_SENTENCE_BREAK_RE = new RegExp(`(?<=[.!?])\\s+(?=${SENTENCE_BOUNDARY_LOOKAHEAD})`, 'g');

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

// ---------------------------------------------------------------------------
// 習熟用(音読) — DailyConversationタブからの自動生成(2026-07-29追加)
// gemini_client.generate_shuujuku_items_from_rows() と処理内容を一致させて
// ある。デスクトップ版は「①シートから読み込む」でデッキに採用された行を
// まとめてこれに渡す(_generate_shuujuku_candidates_from_rows)。Web版は
// ①「AIに添削させてシートに追加」の成功直後に、追記した行(「誤りなし」を
// 除く)をまとめて渡す(app.jsのgenerateShuujukuCandidatesFromRows()参照)。
// ---------------------------------------------------------------------------

/**
 * DailyConversationのシート行(fetchPendingRows()の要素と同じ形式)から、
 * 習熟用(音読)ストックに追加する item をまとめて生成する
 * (gemini_client.generate_shuujuku_items_from_rows() に対応)。
 * 各要素の形はgenerateShuujukuItem()と同じ(source_kind/source_topicは
 * それぞれ'dailyconv'/シートのID列の値)。
 *
 * @returns {Promise<Array<object|null>>} rows と同じ長さ。生成できなかった
 *   件は null(呼び出し側がどの行が失敗したかを伝えられるよう位置を保つ)。
 */
export async function generateShuujukuItemsFromRows({ rows, apiKey, model, promptTemplate, onProgress }) {
  const results = new Array(rows.length).fill(null);
  const chunks = chunkForBatch(rows);
  let done = 0;

  for (const chunk of chunks) {
    const offset = done;
    if (onProgress) onProgress(done, rows.length);

    const lines = chunk.map((row, i) => (
      `[${i + 1}]\n原文: ${row.original || ''}\n`
      + `添削後: ${row.corrected || ''}\n解説: ${row.explanation || ''}`
    )).join('\n\n');

    const prompt = fillPlaceholders(promptTemplate, {
      count: String(chunk.length),
      items: lines,
    });
    const parsed = extractJsonArray(await callGemini(prompt, apiKey, model));

    alignBatchResults(parsed, chunk.length).forEach((entry, i) => {
      if (!entry) return;
      results[offset + i] = {
        pattern: entry.pattern || '',
        meaning: entry.meaning || null,
        examples: entry.examples || [],
        expl: entry.expl || null,
        source_kind: 'dailyconv',
        source_topic: chunk[i].id || '',
        source_label: '由来: DailyConversation',
      };
    });
    done += chunk.length;
  }

  if (onProgress) onProgress(done, rows.length);
  return results;
}

// ---------------------------------------------------------------------------
// 習熟用(音読) — 入力した英文からの生成(2026-08-06追加、Web版のみ)
//
// 習熟用タブに初めて直接の入力欄を設けたもの。**正しさの判定はこの関数では
// 行わない**——呼び出し側(app.jsのonShuujukuGenerate)が先に
// correctEnglishText()で判定し、「誤りなし」の文だけをここへ渡す。
// 判定を独自に持たせると、DailyConversation(=Googleフォーム経路と同じ
// system_instruction)とは別の3つ目の採点基準が生まれ、同じ文でも入口に
// よって評価が食い違うため(CLAUDE.md参照)。
// ---------------------------------------------------------------------------

/**
 * 文法的に正しい英文1文から、習熟用(音読)ストックに追加する item を1件生成する。
 *
 * examples は「入力された英文そのもの + 生成された別の例文2つ」の3つになる
 * (片桐の指示で、元の文脈もカードに残す)。**入力文はAIの出力から取らず、
 * 渡された文字列をそのまま先頭に置く**——AIに「入力文もそのまま返して」と
 * 頼むと、勝手に言い換えたり大文字小文字を変えたりする余地が残るため。
 * 日本語訳(sentence_ja)だけをAIから受け取って組み合わせる。
 */
/** source_topic の正規化(重複検出・guidのキーになるので両経路で揃えること)。 */
function normalizeShuujukuTopic(text) {
  return (text || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export async function generateShuujukuItemsFromSentences({
  sentences, apiKey, model, promptTemplate, onProgress,
}) {
  const results = new Array(sentences.length).fill(null);
  const chunks = chunkForBatch(sentences);
  let done = 0;

  for (const chunk of chunks) {
    const offset = done;
    if (onProgress) onProgress(done, sentences.length);

    const lines = chunk.map((s, i) => `[${i + 1}] ${s}`).join('\n');
    const prompt = fillPlaceholders(promptTemplate, {
      count: String(chunk.length),
      items: lines,
    });
    const parsed = extractJsonArray(await callGemini(prompt, apiKey, model));

    alignBatchResults(parsed, chunk.length).forEach((entry, i) => {
      if (!entry) return;
      const sentence = chunk[i];
      const generated = Array.isArray(entry.examples) ? entry.examples : [];
      results[offset + i] = {
        pattern: entry.pattern || '',
        meaning: entry.meaning || null,
        // 入力文はAIの出力からではなく、渡した文字列をそのまま先頭に置く
        // (AIに返させると言い換え・大文字小文字の変更の余地が残るため)。
        examples: [[sentence, entry.sentence_ja || ''], ...generated],
        expl: entry.expl || null,
        source_kind: 'sentence',
        source_topic: normalizeShuujukuTopic(sentence),
        source_label: '由来: 入力した英文',
      };
    });
    done += chunk.length;
  }

  if (onProgress) onProgress(done, sentences.length);
  return results;
}

// ---------------------------------------------------------------------------
// 習熟用(音読) — 単語・句動詞など「完全な文ではない表現」からの生成
// (2026-08-06追加、Web版のみ)
//
// 片桐から「習熟タブで単語や句動詞など、完全な文ではないものが入力された
// ときも、その表現を使った同じ文法構成のサンプル英文を作ってほしい。ただし
// 文法構造が同じでも内容は別のものにしてほしい」との要望への対応。
//
// **正誤判定(correctEnglishText)は通さない**。単語・句動詞はそもそも文では
// ないため、添削にかけると必ず「誤り」と判定され、カードにならずに
// DailyConversationタブへ転記されてしまう(この機能を入れる前の挙動)。
// 呼び出し側(app.jsのonShuujukuGenerate)が入力行を「文」と「表現」に振り分け、
// 「表現」だけをここへ渡す。
//
// 入力文をそのまま1つ目の例文にする generateShuujukuItemsFromSentences() と
// 違い、こちらは**入力が文ではないので例文にできない**。代わりに、その表現を
// 含む例文を3つ生成させる(内容がそれぞれ別になるようプロンプトで指示する)。
// ---------------------------------------------------------------------------

/**
 * 表現1件だけを使う例文の数(常にこの数は作る)。
 */
export const BASE_PHRASE_EXAMPLES = 3;

/**
 * 1枚あたりの例文数の上限(2026-08-06、片桐の選択)。
 *
 * 例文数は「3 + (入力した表現の数 - 1)」だが、無制限にすると10件入れたときに
 * 12例文になり、**応答が出力トークン上限で途中で切れてバッチごと失敗する**
 * (chunkForBatch のコメントと同じ理由)。片桐の指示「2語句→4つ、3語句→5つ」が
 * ちょうど上限に一致するので、5で頭打ちにする。
 */
export const MAX_PHRASE_EXAMPLES = 5;

/**
 * 「他の表現も一緒に使う」組み合わせ例文の数を、入力した表現の総数から決める。
 * 1件→0 / 2件→1 / 3件以上→2(上限)。
 *
 * **チャンクの件数ではなく入力全体の件数から決めること**。10件を超えて
 * BATCH_SIZEごとに分かれた場合、チャンクの件数で決めると最後の1件だけ
 * 例文数が減るという分かりにくい差が出る。
 */
export function comboExampleCount(totalPhrases) {
  return Math.max(0, Math.min(totalPhrases - 1, MAX_PHRASE_EXAMPLES - BASE_PHRASE_EXAMPLES));
}

export async function generateShuujukuItemsFromPhrases({
  phrases, apiKey, model, promptTemplate, onProgress,
}) {
  const results = new Array(phrases.length).fill(null);
  const chunks = chunkForBatch(phrases);
  let done = 0;

  // 組み合わせ相手の一覧は入力全体から作る(チャンクをまたいでも同じ内容を
  // 渡すので、どのチャンクの表現も同じ候補から相手を選べる)。
  const comboCount = comboExampleCount(phrases.length);
  const exampleCount = BASE_PHRASE_EXAMPLES + comboCount;
  const allPhrases = phrases.length > 1
    ? phrases.map((p) => `- ${p}`).join('\n')
    : '(今回は1件だけなので、組み合わせる相手はありません)';

  for (const chunk of chunks) {
    const offset = done;
    if (onProgress) onProgress(done, phrases.length);

    const lines = chunk.map((p, i) => `[${i + 1}] ${p}`).join('\n');
    const prompt = fillPlaceholders(promptTemplate, {
      count: String(chunk.length),
      items: lines,
      example_count: String(exampleCount),
      combo_count: String(comboCount),
      all_phrases: allPhrases,
    });
    const parsed = extractJsonArray(await callGemini(prompt, apiKey, model));

    alignBatchResults(parsed, chunk.length).forEach((entry, i) => {
      if (!entry) return;
      results[offset + i] = {
        pattern: entry.pattern || '',
        meaning: entry.meaning || null,
        examples: Array.isArray(entry.examples) ? entry.examples : [],
        expl: entry.expl || null,
        source_kind: 'phrase',
        source_topic: normalizeShuujukuTopic(chunk[i]),
        source_label: '由来: 入力した単語・表現',
      };
    });
    done += chunk.length;
  }

  if (onProgress) onProgress(done, phrases.length);
  return results;
}

// ---------------------------------------------------------------------------
// 英文添削 — 「DailyConversation」タブ
// gemini_client.correct_english_text() / consolidate_no_error_corrections()
// と処理内容を一致させてある。
// ---------------------------------------------------------------------------

/**
 * 英文(複数文・段落もまとめて可)を Gemini に添削・採点させる。
 *
 * 他の生成関数と違い、プロンプトで JSON 出力を「指示」するのではなく、
 * Gemini の構造化出力(responseMimeType + responseSchema / JSON Mode)を使う。
 * responseSchema が ARRAY なので、複数文をまとめて渡しても Gemini 側が
 * 文ごとに分割して配列で返す(Googleフォーム経由の Apps Script と同じ挙動)。
 *
 * **systemInstruction / responseSchema は Apps Script 側の実装と意味的に同一に
 * 保つこと**(採点基準がズレると、「添削結果」シート上でフォーム経由の行と
 * このアプリ経由の行で評価基準が食い違ってしまうため)。両者は
 * docs/shared/correction_system_instruction.txt と
 * docs/shared/correction_response_schema.json に切り出してあり、
 * デスクトップ版(gemini_client.py)も同じファイルを読む。
 *
 * @returns {Promise<object[]>} original/corrected/explanation/category/
 *   similar_expressions/各スコア/score_comment を持つ dict の配列
 */
export async function correctEnglishText({
  text, apiKey, model, systemInstruction, responseSchema,
}) {
  if (!text || !text.trim()) throw new GeminiError('添削する英文が空です。');

  const data = await postGeminiRequest({
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
    },
  }, apiKey, model);

  const resultText = textFromResponse(data);
  let corrections;
  try {
    corrections = JSON.parse(resultText);
  } catch {
    throw new GeminiError(`Gemini応答をJSONとして解析できませんでした: ${resultText.slice(0, 300)}`);
  }
  if (!Array.isArray(corrections)) {
    throw new GeminiError(`Gemini応答が配列ではありません: ${resultText.slice(0, 300)}`);
  }
  return corrections;
}

/**
 * category=="誤りなし" の結果が複数あっても、シートには1行だけ書き込むよう
 * 1件に要約する(gemini_client.consolidate_no_error_corrections() と同一)。
 *
 * 誤りのある行は 1文=1行のまま素通しする(それぞれ個別にカード化するため)。
 * 要約行は複数文の点数を平均する意味付けが無いのでスコアを持たない。
 */
export function consolidateNoErrorCorrections(corrections) {
  const noError = corrections.filter((c) => c.category === '誤りなし');
  if (noError.length <= 1) return corrections;

  const originals = noError.map((c) => c.original || '');
  const merged = {
    original: originals.join('\n'),
    corrected: originals.join('\n'),
    explanation: `${noError.length}文とも誤りなしでした。`,
    category: '誤りなし',
    similar_expressions: [],
    grammar_score: '',
    naturalness_score: '',
    comprehensibility_score: '',
    score_comment: '',
  };

  const result = [];
  let inserted = false;
  for (const c of corrections) {
    if (c.category === '誤りなし') {
      // 誤りのある文と混在していても並び順が大きく崩れないよう、
      // 「誤りなし」の最初の出現位置に要約行を差し込む。
      if (!inserted) {
        result.push(merged);
        inserted = true;
      }
    } else {
      result.push(c);
    }
  }
  return result;
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
