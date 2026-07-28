// tts.js
// ---------------------------------------------------------------------------
// Google Cloud Text-to-Speech をブラウザから直接呼ぶ。
// デスクトップ版の tts_core.py(call_google_tts / split_into_sentences /
// _classify_tts_error 等)に対応する Web 版。
//
// 【方式(デスクトップ版との違い)】
// デスクトップ版は「文ごとに個別TTS」(per_sentence)と「文を無音で結合して
// 1つの音声にする」(synthesize_with_gaps、lameencでmp3再エンコードが必要)の
// 2方式を持つが、ブラウザにはlameenc相当のMP3エンコーダが無い。Google Cloud
// TTSはaudioEncoding: "MP3"を指定すればサーバー側でMP3を返してくれるため、
// Web版は常に「文ごとに個別TTS(per_sentence方式)」のみを実装する
// (音声の結合・無音挿入は行わない。文と文の間の間隔調整機能は今後の課題)。
//
// 【APIキーについて】
// lib/gemini.js と同じ方針(利用者がページ上で入力しlocalStorageに保存、
// リポジトリ・ソースには絶対に書かない)。
//
// 【CORS】
// texttospeech.googleapis.com も X-Goog-Api-Key ヘッダでのクロスオリジン
// 要求を許可している(2026-07-28に実測して確認済み、gemini.jsのCORS注記と同じ)。

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// tts_core.TTS_MAX_RETRIES と同じ考え方(短期のレート制限・5xxのみリトライ)。
const MAX_RETRIES = 3;

export class TtsError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTPステータスとレスポンス本文から、(利用者向けメッセージ, リトライすべきか)
 * を判定する。tts_core._classify_tts_error() と同一の判定基準。
 */
function classifyTtsError(status, detail) {
  const n = (detail || '').replace(/[\s_-]/g, '').toLowerCase();

  if (status === 429) {
    if (n.includes('perday') || n.includes('perproject')) {
      return [
        'Cloud Text-to-Speechの割り当て(Quota)の上限に達しました。'
        + 'リトライしても回復しないため打ち切りました。\n'
        + 'Google Cloud Consoleの「IAMと管理 → 割り当てとシステム上限」で'
        + '現在の上限を確認してください。',
        false,
      ];
    }
    return [
      'Cloud Text-to-Speechのレート制限に達しました(短時間に送りすぎです)。'
      + 'しばらく待ってから再実行してください。',
      true,
    ];
  }

  if (status === 403) {
    if (n.includes('billing')) {
      return [
        'このプロジェクトの課金が無効になっているため、Cloud Text-to-Speechを'
        + '利用できません。\nGoogle Cloud Consoleの「お支払い」で課金アカウントが'
        + '有効か確認してください。',
        false,
      ];
    }
    if (n.includes('referer') || n.includes('referrer')) {
      return [
        'APIキーの「ウェブサイト(HTTPリファラー)」制限に弾かれました。\n'
        + '今開いているアドレスをキーの制限に登録するか、制限のないキーを使ってください。',
        false,
      ];
    }
    if (n.includes('servicedisabled') || n.includes('hasnotbeenused')) {
      return [
        'このプロジェクトでCloud Text-to-Speech APIが有効化されていません。\n'
        + 'Google Cloud Consoleの「APIとサービス → ライブラリ」で'
        + '「Cloud Text-to-Speech API」を有効にしてください。',
        false,
      ];
    }
    if (n.includes('apikeyserviceblocked')) {
      return [
        'APIキーの「APIの制限」でCloud Text-to-Speech APIが許可されていません。\n'
        + 'キーの設定で対象APIに Cloud Text-to-Speech API を含めてください。',
        false,
      ];
    }
    return ['Cloud Text-to-Speechへのアクセスが拒否されました(403)。', false];
  }

  if (status === 400 || status === 401 || n.includes('apikeyinvalid')) {
    return [
      'APIキーが無効か、リクエスト内容に誤りがあります。'
      + '⚙設定のTTS APIキー・言語コード・音声名を確認してください。',
      false,
    ];
  }

  if (status >= 500) {
    return ['Google側で一時的なエラーが発生しました。', true];
  }

  return [`Cloud Text-to-Speech API呼び出しに失敗しました(HTTP ${status})。`, false];
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function callTtsApi(body, apiKey) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const res = await fetch(TTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = await res.json();
      return base64ToBytes(data.audioContent);
    }

    const detail = await res.text();
    const [message, retryable] = classifyTtsError(res.status, detail);
    lastError = new TtsError(detail ? `${message}\n\n詳細: ${detail}` : message);
    if (!retryable) throw lastError;
    if (attempt < MAX_RETRIES - 1) await sleep(1500 * (attempt + 1));
  }
  throw lastError;
}

/**
 * 1文をMP3で合成する。tts_core.call_google_tts() に対応。
 * @returns {Promise<Uint8Array>}
 */
export async function callGoogleTts(text, { voiceName, languageCode, apiKey, volumeGainDb = 0.0 }) {
  if (!apiKey) throw new TtsError('Cloud Text-to-SpeechのAPIキーが設定されていません。');
  return callTtsApi(
    {
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: 'MP3', volumeGainDb },
    },
    apiKey,
  );
}

// ---------------------------------------------------------------------------
// 文分割・HTML整形(tts_core.strip_html_for_tts / split_into_sentences の移植)
// ---------------------------------------------------------------------------

// 「Ex1.」「2.」のような短い見出しラベル1つだけの断片を検出する
// (tts_core._LABEL_ONLY_RE と同一)。
const LABEL_ONLY_RE = /^[A-Za-z]{0,6}\d{1,3}\.$/;

/** HTMLエンティティをデコードする(&amp; 等)。 */
function htmlUnescape(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

/** tts_core.strip_html_for_tts() と同一。TTSに渡す平文を作る。 */
export function stripHtmlForTts(raw) {
  let text = raw;
  text = text.replace(/<br\s*\/?>/gi, '. ');
  text = text.replace(/<\/div>/gi, '. ');
  text = text.replace(/<[^>]+>/g, '');
  text = htmlUnescape(text);
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** tts_core.split_into_sentences() と同一。フィールドのHTMLを文単位に分割する。 */
export function splitIntoSentences(htmlText) {
  let normalized = htmlText.replace(/<br\s*\/?>/gi, '\n');
  normalized = normalized.replace(/<\/div>/gi, '\n');
  normalized = normalized.replace(/<[^>]+>/g, '');
  normalized = htmlUnescape(normalized);

  const sentences = [];
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const rawParts = line.split(/(?<=[.!?])\s+/);
    const parts = rawParts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

    const merged = [];
    for (const p of parts) {
      if (merged.length > 0 && LABEL_ONLY_RE.test(merged[merged.length - 1])) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`;
      } else {
        merged.push(p);
      }
    }
    sentences.push(...merged);
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// フィールド単位の音声埋め込み(単語・AIに質問タブ用)
// ---------------------------------------------------------------------------

/**
 * フィールドの生HTML値を文ごとに個別MP3化し、末尾に[sound:...]タグを追記した
 * HTMLを返す(tts_core.generate_tts_for_collectionのper_sentence=True相当。
 * デスクトップ版と同じく、タグはフィールド末尾に<br>区切りでまとめて追記する
 * 方式で、文の途中には挿入しない)。
 *
 * @param {string} rawFieldHtml
 * @param {object} opts {voiceName, languageCode, apiKey, volumeGainDb, filenamePrefix}
 * @param {Map<string, Uint8Array>} media 生成したmp3を追加していく(呼び出し側で共有)
 * @returns {Promise<string>} 音声タグを追記したHTML(元のフィールドが空、または
 *   読み上げ対象テキストが空の場合は元のHTMLをそのまま返す = 何もしない)
 */
export async function synthesizeFieldWithTags(rawFieldHtml, opts, media) {
  const sentences = splitIntoSentences(rawFieldHtml || '').filter((s) => s.trim());
  if (sentences.length === 0) return rawFieldHtml;

  const tags = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const bytes = await callGoogleTts(sentences[i], opts);
    const filename = `${opts.filenamePrefix}_${i + 1}.mp3`;
    media.set(filename, bytes);
    tags.push(`[sound:${filename}]`);
  }
  const combinedTags = tags.join('<br>');
  return rawFieldHtml ? `${rawFieldHtml}<br>${combinedTags}` : combinedTags;
}

// ---------------------------------------------------------------------------
// 習熟用(音読)タブ用: 例文ごとに個別の音声タグを作る
// ---------------------------------------------------------------------------

/**
 * 習熟用ストックの1itemが持つexamples([英文, 和訳, ハイライト語...]の配列)から、
 * 例文ごとに1つのMP3を合成し、`[sound:...]`タグの配列を返す(例文の順序と
 * 対応する)。tts_core.generate_shuujuku_sentence_tts_for_collection()の
 * `synthesize_with_gaps(text, ..., gap_seconds=0, ...)`と同じく、1例文=1回の
 * TTS呼び出し(例文内をさらに文分割することはしない)。空の例文には空文字を
 * 入れる(呼び出し元はrenderItemにそのまま渡せる)。
 *
 * @param {Array} examples [[en, ja, hlWords?], ...]
 * @param {object} opts {voiceName, languageCode, apiKey, volumeGainDb}
 * @param {Map<string, Uint8Array>} media
 * @param {string} filenamePrefix 例: `tts_shuujuku_${itemIndex}`
 * @returns {Promise<string[]>}
 */
export async function synthesizeExampleAudioTags(examples, opts, media, filenamePrefix) {
  const tags = [];
  for (let i = 0; i < examples.length; i += 1) {
    const text = stripHtmlForTts(String(examples[i][0] || ''));
    if (!text) {
      tags.push('');
      continue;
    }
    const bytes = await callGoogleTts(text, opts);
    const filename = `${filenamePrefix}_${i + 1}.mp3`;
    media.set(filename, bytes);
    tags.push(`[sound:${filename}]`);
  }
  return tags;
}
