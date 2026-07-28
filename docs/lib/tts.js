// tts.js
// ---------------------------------------------------------------------------
// Google Cloud Text-to-Speech をブラウザから直接呼ぶ。
// デスクトップ版の tts_core.py(call_google_tts / split_into_sentences /
// _classify_tts_error 等)に対応する Web 版。
//
// 【音声の分割単位(2026-07-28、片桐の指示で確定)】
// - 単語 / AIに質問タブ … **フィールド全体で1つのMP3・1つの`[sound:]`タグ**
//   (synthesizeFieldWithTags)。文ごとに分けない。
// - 習熟用(音読)タブ   … **例文(ex-en)ごとに1つのMP3・1つのタグ**
//   (synthesizeExampleAudioTags)。音読練習で1文ずつ再生したいため、この
//   タブだけ細かく分ける(デスクトップ版の
//   generate_shuujuku_sentence_tts_for_collectionと同じ考え方)。
//
// 【方式(デスクトップ版との違い)】
// デスクトップ版は複数文を「無音を挟んで結合し1つの音声にする」方式
// (synthesize_with_gaps)を持つが、これはWAVで受け取って結合しlameencで
// mp3へ再エンコードする実装で、ブラウザにはlameenc相当のエンコーダが無い。
// そのためWeb版はデスクトップ版の`gap_seconds <= 0`のときと同じく、
// フィールドの平文をそのまま1回のTTS呼び出しに渡して返ってきたMP3を使う
// (文と文の間隔調整は未対応。実装するならlib側に文分割+無音結合の移植が必要)。
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
// HTML整形(tts_core.strip_html_for_tts の移植)
// ---------------------------------------------------------------------------
//
// tts_core.split_into_sentences() に相当する文分割はWeb版には無い。
// 単語/AIに質問はフィールド全体を1回で読み上げ、習熟用は既にitem側が
// 例文単位に分かれているため、どちらも文分割を必要としないため
// (2026-07-28、音声を文ごとに分けるのは習熟用のみという片桐の指示による)。
// 将来「文と文の間に無音を挟んで1つの音声にする」機能を足す場合は、
// split_into_sentences(「Ex1.」等の見出しラベルを次の文へ結合する処理を含む)
// の移植から必要になる。

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

// ---------------------------------------------------------------------------
// フィールド単位の音声埋め込み(単語・AIに質問タブ用)
// ---------------------------------------------------------------------------

/**
 * フィールドの生HTML値**全体**を1つのMP3にし、末尾に`[sound:...]`タグを1つだけ
 * 追記したHTMLを返す(tts_core.generate_tts_for_collectionの
 * per_sentence=False + gap_seconds<=0 のときと同じ挙動)。
 *
 * **文ごとに分割しないこと**は2026-07-28に片桐が指示した仕様。文ごとに個別の
 * MP3・タグを作るのは習熟用(音読)タブだけで、そちらは例文単位の
 * synthesizeExampleAudioTags()が担当する。
 *
 * @param {string} rawFieldHtml
 * @param {object} opts {voiceName, languageCode, apiKey, volumeGainDb, filenamePrefix}
 * @param {Map<string, Uint8Array>} media 生成したmp3を追加していく(呼び出し側で共有)
 * @returns {Promise<string>} 音声タグを追記したHTML(元のフィールドが空、または
 *   読み上げ対象テキストが空の場合は元のHTMLをそのまま返す = 何もしない)
 */
export async function synthesizeFieldWithTags(rawFieldHtml, opts, media) {
  const text = stripHtmlForTts(rawFieldHtml || '');
  if (!text) return rawFieldHtml;

  const bytes = await callGoogleTts(text, opts);
  const filename = `${opts.filenamePrefix}.mp3`;
  media.set(filename, bytes);
  const tag = `[sound:${filename}]`;
  return rawFieldHtml ? `${rawFieldHtml}<br>${tag}` : tag;
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
