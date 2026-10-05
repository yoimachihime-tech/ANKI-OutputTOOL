// tts.js
// ---------------------------------------------------------------------------
// TTS(音声合成)をブラウザから直接呼ぶ。デスクトップ版の tts_core.py
// (call_google_tts / split_into_sentences / _classify_tts_error 等)に対応する
// Web 版。
//
// 【音声エンジン(2026-10-05に2種類になった)】
// - cloud  … Google Cloud Text-to-Speech(Chirp 3: HD など)。従来どおり
//            「Cloud Text-to-Speech APIキー」で呼び、MP3 を直接受け取る。
// - gemini … Gemini TTS(Gemini 3.8 Flash TTS など、2026年9月公開の新しい音声)。
//            Gemini API から呼ぶので、カード生成と同じ「Gemini APIキー」を使う。
//            応答は WAV(24kHz・モノラル・16bit)なので、.apkg に入れる前に
//            lamejs(cdnjs)で MP3 に圧縮する(読み込めなければ WAV のまま入れる)。
// 呼び出し側は synthesizeSpeech() だけを使えばよく、エンジンの違いはここで吸収する。
//
// 【音声の分割単位(2026-07-28、片桐の指示で確定)】
// - 単語 / AIに質問タブ … **フィールド全体で1つの音声・1つの`[sound:]`タグ**
//   (synthesizeFieldWithTags)。文ごとに分けない。
// - 習熟用(音読)タブ   … **例文(ex-en)ごとに1つの音声・1つのタグ**
//   (synthesizeExampleAudioTags)。音読練習で1文ずつ再生したいため、この
//   タブだけ細かく分ける。
//
// 【文と文の間隔】
// デスクトップ版は複数文を「無音を挟んで結合し1つの音声にする」方式
// (synthesize_with_gaps)を持つが、Web版は従来どおりフィールドの平文を
// そのまま1回のTTS呼び出しに渡す(文と文の間隔調整は未対応)。
//
// 【テスト再生・波形について(2026-10-05に作り直し)】
// 以前はテスト音声を MP3 で受け取り、Web Audio API(AudioContext)でデコード
// して波形を求めていた。AudioContext は iOS で音声セッションの扱いが変わり、
// <audio> 要素の再生と干渉しうる(「波形は出るが音が鳴らない」の候補)。
// 現在はテスト用の音声を最初から WAV(Cloud TTS は LINEAR16)で受け取り、
// このファイルの parseWav() で PCM を直接読む。**Web Audio API は一切使わない**。
//
// 【APIキーについて】
// lib/gemini.js と同じ方針(利用者がページ上で入力しlocalStorageに保存、
// リポジトリ・ソースには絶対に書かない)。
//
// 【CORS】
// texttospeech.googleapis.com も X-Goog-Api-Key ヘッダでのクロスオリジン
// 要求を許可している(2026-07-28に実測して確認済み、gemini.jsのCORS注記と同じ)。

// `?v=` は app.js が gemini.js を読むときと**必ず同じ値**にすること
// (URLが違うと同じモジュールが2つ読み込まれる。gemini.js 自体は状態を
// 持たないので実害は小さいが、無駄なので揃えておく)。
import { generateSpeech, geminiTtsSupportsStyle } from './gemini.js?v=20261005a';

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_ENDPOINT = 'https://texttospeech.googleapis.com/v1/voices';

// tts_core.TTS_MAX_RETRIES と同じ考え方(短期のレート制限・5xxのみリトライ)。
const MAX_RETRIES = 3;

export class TtsError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 音声の一覧(2026-10-05追加)
// ---------------------------------------------------------------------------

export const TTS_ENGINE_CLOUD = 'cloud';
export const TTS_ENGINE_GEMINI = 'gemini';

/**
 * Chirp 3: HD と Gemini TTS が共通で持つ30種のプリセット音声。
 * 性別は Cloud TTS の voices.list(en-US)の ssmlGender、特徴は Gemini API の
 * ドキュメントにある説明(Bright, Firm …)を日本語にしたもの
 * (どちらも2026-10-05に確認)。
 */
export const PREBUILT_VOICES = [
  { name: 'Achernar', gender: 'F', trait: 'やわらか' },
  { name: 'Achird', gender: 'M', trait: '親しみやすい' },
  { name: 'Algenib', gender: 'M', trait: 'しゃがれ声' },
  { name: 'Algieba', gender: 'M', trait: 'なめらか' },
  { name: 'Alnilam', gender: 'M', trait: 'しっかり' },
  { name: 'Aoede', gender: 'F', trait: '軽やか' },
  { name: 'Autonoe', gender: 'F', trait: '明るい' },
  { name: 'Callirrhoe', gender: 'F', trait: 'おおらか' },
  { name: 'Charon', gender: 'M', trait: '説明的' },
  { name: 'Despina', gender: 'F', trait: 'なめらか' },
  { name: 'Enceladus', gender: 'M', trait: '息まじり' },
  { name: 'Erinome', gender: 'F', trait: '明瞭' },
  { name: 'Fenrir', gender: 'M', trait: '興奮気味' },
  { name: 'Gacrux', gender: 'F', trait: '落ち着いた大人' },
  { name: 'Iapetus', gender: 'M', trait: '明瞭' },
  { name: 'Kore', gender: 'F', trait: 'しっかり' },
  { name: 'Laomedeia', gender: 'F', trait: '元気' },
  { name: 'Leda', gender: 'F', trait: '若々しい' },
  { name: 'Orus', gender: 'M', trait: 'しっかり' },
  { name: 'Puck', gender: 'M', trait: '元気' },
  { name: 'Pulcherrima', gender: 'F', trait: '前向き' },
  { name: 'Rasalgethi', gender: 'M', trait: '説明的' },
  { name: 'Sadachbia', gender: 'M', trait: '活発' },
  { name: 'Sadaltager', gender: 'M', trait: '知的' },
  { name: 'Schedar', gender: 'M', trait: '平坦で安定' },
  { name: 'Sulafat', gender: 'F', trait: '温かい' },
  { name: 'Umbriel', gender: 'M', trait: 'おおらか' },
  { name: 'Vindemiatrix', gender: 'F', trait: '穏やか' },
  { name: 'Zephyr', gender: 'F', trait: '明るい' },
  { name: 'Zubenelgenubi', gender: 'M', trait: 'くだけた' },
];

/** 一覧に出す表示名(例: "Iapetus — 男性・明瞭")。 */
export function prebuiltVoiceLabel(voice) {
  const gender = voice.gender === 'F' ? '女性' : voice.gender === 'M' ? '男性' : '';
  return `${voice.name} — ${[gender, voice.trait].filter(Boolean).join('・')}`;
}

/**
 * Gemini API で使える TTS モデル(新しい順)。「一覧を取得」を押さなくても
 * 選べるよう既知のものを持っておく(取得した一覧に新しいモデルがあれば、
 * app.js 側で追加される)。
 */
export const GEMINI_TTS_MODELS = [
  { id: 'gemini-3.8-flash-tts', label: 'Gemini 3.8 Flash TTS(最新・高品質)' },
  { id: 'gemini-3.8-flash-lite-tts', label: 'Gemini 3.8 Flash-Lite TTS(最新・高速/低コスト)' },
  { id: 'gemini-3.1-flash-tts-preview', label: 'Gemini 3.1 Flash TTS(プレビュー)' },
  { id: 'gemini-2.5-pro-preview-tts', label: 'Gemini 2.5 Pro TTS(プレビュー)' },
  { id: 'gemini-2.5-flash-preview-tts', label: 'Gemini 2.5 Flash TTS(プレビュー)' },
];
export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_GEMINI_TTS_VOICE = 'Iapetus';
export const DEFAULT_CLOUD_VOICE = 'en-US-Chirp3-HD-Iapetus';

export { geminiTtsSupportsStyle };

/** Chirp 3: HD の音声名(例: en-US-Chirp3-HD-Iapetus)。 */
export function chirp3VoiceName(languageCode, name) {
  return `${languageCode}-Chirp3-HD-${name}`;
}

/** 音声名の先頭にある言語コード(en-US-... → en-US)。無ければ null。 */
export function languageCodeFromVoiceName(voiceName) {
  const m = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voiceName || '');
  return m ? m[1] : null;
}

/** 音声名から系統(Chirp3-HD / Neural2 …)を取り出す(一覧のグループ分け用)。 */
export function voiceFamily(voiceName) {
  const rest = (voiceName || '').replace(/^[a-z]{2,3}-[A-Z]{2}-/, '');
  const idx = rest.lastIndexOf('-');
  return idx > 0 ? rest.slice(0, idx) : 'その他';
}

/**
 * Cloud Text-to-Speech の音声一覧を取得する(無料の呼び出し)。
 *
 * **言語コードの付いていない音声名("Kore" など)は除く。** voices.list には
 * Cloud 経由の Gemini TTS 用の名前も混ざっているが、これらは Vertex AI の
 * 権限が別途必要で、APIキーだけでは合成できない(選ぶと分かりにくい 400/403 に
 * なる)。Gemini の音声はエンジンで「Gemini TTS」を選んで使う。
 *
 * @returns {Promise<Array<{name: string, gender: string, family: string}>>}
 */
export async function listCloudVoices(languageCode, apiKey) {
  if (!apiKey) throw new TtsError('Cloud Text-to-SpeechのAPIキーが設定されていません。');
  const url = new URL(VOICES_ENDPOINT);
  if (languageCode) url.searchParams.set('languageCode', languageCode);
  const res = await fetch(url.toString(), { headers: { 'X-Goog-Api-Key': apiKey } });
  if (!res.ok) {
    const detail = await res.text();
    const [message] = classifyTtsError(res.status, detail);
    throw new TtsError(detail ? `${message}\n\n詳細: ${detail}` : message);
  }
  const data = await res.json();
  return (data.voices || [])
    .filter((v) => languageCodeFromVoiceName(v.name))
    .filter((v) => !languageCode || (v.languageCodes || []).includes(languageCode)
      || v.name.startsWith(`${languageCode}-`))
    .map((v) => ({
      name: v.name,
      gender: v.ssmlGender === 'FEMALE' ? 'F' : v.ssmlGender === 'MALE' ? 'M' : '',
      family: voiceFamily(v.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

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
      + '⚙設定のTTS APIキー・言語・音声を確認してください。',
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
 * Cloud Text-to-Speech で1回合成する。tts_core.call_google_tts() に対応。
 *
 * **言語コードは音声名の先頭を優先する(2026-10-05)。** 音声名
 * (en-GB-Chirp3-HD-…)と言語コード(en-US)が食い違っているとAPIが400を返し、
 * 「リクエスト内容に誤りがあります」としか分からない状態になっていた。
 * 音声名に言語が書いてあるならそれが正しいので、そちらに合わせる。
 *
 * @param {string} [audioEncoding] 'MP3'(既定、.apkg 用)/ 'LINEAR16'(WAV、テスト再生用)
 * @returns {Promise<Uint8Array>}
 */
export async function callGoogleTts(text, {
  voiceName, languageCode, apiKey, volumeGainDb = 0.0, audioEncoding = 'MP3',
}) {
  if (!apiKey) throw new TtsError('Cloud Text-to-SpeechのAPIキーが設定されていません。');
  return callTtsApi(
    {
      input: { text },
      voice: { languageCode: languageCodeFromVoiceName(voiceName) || languageCode, name: voiceName },
      audioConfig: { audioEncoding, volumeGainDb },
    },
    apiKey,
  );
}

// ---------------------------------------------------------------------------
// WAV の読み書き(2026-10-05追加)
// ---------------------------------------------------------------------------

const ascii = (u8, at, len) => String.fromCharCode(...u8.subarray(at, at + len));

/**
 * 16bit PCM の WAV を読む。tts_core._read_pcm16_samples() に相当。
 *
 * 戻り値は computeWaveformMinMax / computePeakAmplitude がそのまま受け取れる
 * 形(getChannelData(0) が -1.0〜+1.0 の Float32Array を返す)にしてある
 * (以前これらは Web Audio API の AudioBuffer を受け取っていたため)。
 *
 * チャンクは順にたどる(fmt と data の間に LIST などが挟まっていても読める)。
 * data チャンクの長さが実際のバイト数より大きい(ストリーミング由来の
 * 0xFFFFFFFF 等)場合は、実際にあるところまでを使う。
 */
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 12 || ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 4) !== 'WAVE') {
    throw new TtsError('WAVとして読み込めない音声データです。');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  for (let pos = 12; pos + 8 <= u8.length;) {
    const id = ascii(u8, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, u8.length - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new TtsError('WAVのヘッダーが不完全です。');
  if (fmt.bitsPerSample !== 16 || (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe)) {
    throw new TtsError(`対応していないWAV形式です(${fmt.bitsPerSample}bit / format ${fmt.audioFormat})。`);
  }

  const channels = Math.max(1, fmt.channels);
  const length = Math.floor(dataSize / (2 * channels));
  const cache = new Map();
  return {
    sampleRate: fmt.sampleRate,
    numberOfChannels: channels,
    length,
    duration: fmt.sampleRate ? length / fmt.sampleRate : 0,
    dataOffset,
    dataSize: length * 2 * channels,
    /** 1チャンネル分を -1.0〜+1.0 の Float32Array で返す(結果はキャッシュ)。 */
    getChannelData(ch = 0) {
      if (!cache.has(ch)) {
        const out = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          out[i] = dv.getInt16(dataOffset + (i * channels + ch) * 2, true) / 32768;
        }
        cache.set(ch, out);
      }
      return cache.get(ch);
    },
  };
}

/** 生の 16bit リトルエンディアン PCM に WAV ヘッダーを付ける。 */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const put = (at, s) => { for (let i = 0; i < s.length; i += 1) out[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + data.length, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/**
 * Gemini TTS の応答を WAV にそろえる。3.8 系は WAV をそのまま返すが、
 * 古いプレビュー版はヘッダー無しの PCM('audio/L16;codec=pcm;rate=24000')を返す。
 * (Gemini のドキュメントどおりリトルエンディアンとして扱う)
 */
export function toWavBytes(bytes, mimeType = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 4 && ascii(u8, 0, 4) === 'RIFF') return u8;
  if (/l16|pcm/i.test(mimeType) || !mimeType) {
    const rate = Number((/rate=(\d+)/i.exec(mimeType) || [])[1]) || 24000;
    return pcmToWav(u8, rate, 1);
  }
  throw new TtsError(`想定していない音声形式が返ってきました: ${mimeType}`);
}

// ローカルで音量を上げるときに、ピークをここまでに抑える(約 -0.3dBFS)。
const LIMITER_PEAK = 0.965;

/**
 * WAV に音量ゲインを掛けた新しい WAV を返す(Gemini TTS 用)。
 *
 * Cloud TTS は合成時に Google 側でゲインを掛けられる(volumeGainDb)が、
 * Gemini TTS にはその指定が無いため、ここで PCM を直接増幅する。
 * **音割れしないよう、ピークが LIMITER_PEAK を超える分は自動で抑える**
 * (Gemini は同じ文でも呼ぶたびに音量が少し変わるので、テスト再生で決めた
 *  ゲインが本番の別の文で音割れする、ということを防ぐため)。
 *
 * @returns {{bytes: Uint8Array, appliedDb: number, limited: boolean}}
 */
export function applyGainToWav(wavBytes, gainDb) {
  const wav = parseWav(wavBytes);
  const requested = Number(gainDb) || 0;
  let factor = 10 ** (requested / 20);
  const peak = computePeakAmplitude(wav);
  let limited = false;
  if (peak > 0 && peak * factor > LIMITER_PEAK && factor > 1) {
    factor = Math.max(1, LIMITER_PEAK / peak);
    limited = true;
  }
  if (factor === 1 && !limited) {
    return { bytes: wavBytes instanceof Uint8Array ? wavBytes : new Uint8Array(wavBytes), appliedDb: 0, limited };
  }
  const out = new Uint8Array(wavBytes);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const end = wav.dataOffset + wav.dataSize;
  for (let at = wav.dataOffset; at + 1 < end; at += 2) {
    const v = Math.round(dv.getInt16(at, true) * factor);
    dv.setInt16(at, Math.max(-32768, Math.min(32767, v)), true);
  }
  return { bytes: out, appliedDb: 20 * Math.log10(factor), limited };
}

// ---------------------------------------------------------------------------
// MP3 への圧縮(Gemini TTS 用、2026-10-05追加)
//
// WAV のままだと 1秒あたり約48KB になり、例文の多いデッキでは .apkg が
// 数十MBに膨らむ(スマホでの取り込みが重くなる)。lamejs(LAME の JavaScript 版)
// で 64kbps の MP3 にすると約1/6になる。使うときだけ cdnjs から読み込む。
// 読み込めなかった場合(オフライン等)は WAV のまま入れる(Anki はどちらも再生できる)。
//
// テスト用の差し替え: globalThis.lamejs に偽物を入れればそれを使い、
// **null を入れると「MP3にしない」扱いになる**(読み込みを試さない)。
// ---------------------------------------------------------------------------

const LAMEJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
const LAMEJS_SRI = 'sha512-xT0S/xXvkrfkRXGBPlzZPCAncnMK5c1N7slRkToUbv8Z901aUEuKO84tLy8dWU+3ew4InFEN7TebPaVMy2npZw==';
const LAMEJS_TIMEOUT_MS = 15000;
let lamePromise = null;

export function loadLameJs() {
  if (globalThis.lamejs === null) return Promise.resolve(null);
  if (globalThis.lamejs?.Mp3Encoder) return Promise.resolve(globalThis.lamejs);
  if (typeof document === 'undefined' || !document.head) return Promise.resolve(null);
  if (!lamePromise) {
    lamePromise = new Promise((resolve) => {
      const done = (value) => { clearTimeout(timer); resolve(value); };
      // 読み込みが返ってこない環境(オフライン・ブロック)でも出力を止めない。
      const timer = setTimeout(() => done(null), LAMEJS_TIMEOUT_MS);
      const s = document.createElement('script');
      s.src = LAMEJS_URL;
      s.integrity = LAMEJS_SRI;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = () => done(globalThis.lamejs?.Mp3Encoder ? globalThis.lamejs : null);
      s.onerror = () => done(null);
      document.head.appendChild(s);
    }).then((lame) => {
      if (!lame) lamePromise = null; // 失敗したら次回また試す
      return lame;
    });
  }
  return lamePromise;
}

/**
 * WAV(16bit)を MP3 に圧縮する。lamejs が使えなければ null を返す。
 * @returns {Promise<Uint8Array|null>}
 */
export async function encodeWavToMp3(wavBytes, kbps = 64) {
  const lame = await loadLameJs();
  if (!lame) return null;
  const wav = parseWav(wavBytes);
  const channels = Math.min(2, wav.numberOfChannels);
  const dv = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const toInt16 = (ch) => {
    const out = new Int16Array(wav.length);
    for (let i = 0; i < wav.length; i += 1) {
      out[i] = dv.getInt16(wav.dataOffset + (i * wav.numberOfChannels + ch) * 2, true);
    }
    return out;
  };
  const left = toInt16(0);
  const right = channels > 1 ? toInt16(1) : null;
  const encoder = new lame.Mp3Encoder(channels, wav.sampleRate, kbps);
  const chunks = [];
  const BLOCK = 1152;
  for (let i = 0; i < left.length; i += BLOCK) {
    const l = left.subarray(i, i + BLOCK);
    const buf = right ? encoder.encodeBuffer(l, right.subarray(i, i + BLOCK)) : encoder.encodeBuffer(l);
    if (buf.length) chunks.push(new Uint8Array(buf));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------------------------------------------------------------------------
// 合成の入口(エンジンの違いをここで吸収する、2026-10-05追加)
// ---------------------------------------------------------------------------

/** エンジンの指定(未指定・不明な値は従来どおり cloud)。 */
export function engineOf(opts) {
  return opts?.engine === TTS_ENGINE_GEMINI ? TTS_ENGINE_GEMINI : TTS_ENGINE_CLOUD;
}

/**
 * text を読み上げた音声を返す。
 *
 * @param {object} opts getTtsOptions()(app.js)の戻り値。
 *   共通: engine, volumeGainDb
 *   cloud: apiKey(Cloud TTS用), voiceName, languageCode
 *   gemini: geminiApiKey, model, voiceName(プリセット名), style
 * @param {{purpose?: 'apkg'|'wav'}} [o] 'apkg' … .apkg に入れる用(できるだけMP3)。
 *   'wav' … テスト再生・音量解析用(必ずWAV)。
 * @returns {Promise<{bytes: Uint8Array, ext: 'mp3'|'wav', mimeType: string, limited?: boolean}>}
 */
export async function synthesizeSpeech(text, opts, { purpose = 'apkg' } = {}) {
  if (engineOf(opts) === TTS_ENGINE_GEMINI) {
    if (!opts.geminiApiKey) throw new TtsError('Gemini APIキーが設定されていません(Gemini TTSに必要です)。');
    const { bytes, mimeType } = await generateSpeech({
      text,
      apiKey: opts.geminiApiKey,
      model: opts.model || DEFAULT_GEMINI_TTS_MODEL,
      voiceName: opts.voiceName || DEFAULT_GEMINI_TTS_VOICE,
      style: opts.style || '',
    });
    const gained = applyGainToWav(toWavBytes(bytes, mimeType), opts.volumeGainDb);
    if (purpose === 'apkg') {
      const mp3 = await encodeWavToMp3(gained.bytes, opts.mp3Kbps || 64);
      if (mp3) return { bytes: mp3, ext: 'mp3', mimeType: 'audio/mpeg', limited: gained.limited };
    }
    return { bytes: gained.bytes, ext: 'wav', mimeType: 'audio/wav', limited: gained.limited };
  }

  if (purpose === 'wav') {
    const bytes = await callGoogleTts(text, { ...opts, audioEncoding: 'LINEAR16' });
    return { bytes: toWavBytes(bytes, 'audio/wav'), ext: 'wav', mimeType: 'audio/wav' };
  }
  const bytes = await callGoogleTts(text, opts);
  return { bytes, ext: 'mp3', mimeType: 'audio/mpeg' };
}

// ---------------------------------------------------------------------------
// テスト再生(⚙設定「テスト再生」用)
// tts_core.TEST_SAMPLE_SENTENCES / synthesize_test_sample_wav のWeb版。
// ---------------------------------------------------------------------------

export const TEST_SAMPLE_SENTENCES = [
  'This is a short test sentence.',
  'Here is a second one to check the voice and volume.',
];

export const DEFAULT_TEST_TEXT = TEST_SAMPLE_SENTENCES.join(' ');

/**
 * テスト用の音声を WAV で合成する(音量ゲインは本番と同じ掛け方をする)。
 * @param {string} [text] 読み上げる文(空なら既定のサンプル文)
 * @returns {Promise<{bytes: Uint8Array, limited?: boolean}>}
 */
export async function synthesizeTestSampleWav(opts, text = '') {
  const result = await synthesizeSpeech((text || '').trim() || DEFAULT_TEST_TEXT, opts, { purpose: 'wav' });
  return { bytes: result.bytes, limited: Boolean(result.limited) };
}

// ---------------------------------------------------------------------------
// 波形表示・音割れの判定・自動音量調整
// tts_core.compute_waveform_minmax / compute_peak_amplitude / is_clipped /
// find_safe_volume_gain_db のWeb版。どれも parseWav() の戻り値
// (getChannelData(0) が -1.0〜+1.0 を返すもの)を受け取る。
// ---------------------------------------------------------------------------

/**
 * tts_core.compute_waveform_minmax() と同じロジック。先頭チャンネルから、
 * バケットごとの[min, max]を返す。
 * @returns {Array<[number, number]>} 長さ=buckets(先頭が音声の先頭に対応)
 */
export function computeWaveformMinMax(audioBuffer, buckets = 40) {
  const channel = audioBuffer.getChannelData(0);
  const total = channel.length;
  if (total === 0) return Array.from({ length: buckets }, () => [0, 0]);

  const bucketSize = Math.max(1, Math.floor(total / buckets));
  const result = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = b * bucketSize;
    if (start >= total) {
      result.push([0, 0]);
      continue;
    }
    const end = Math.min(start + bucketSize, total);
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const v = channel[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    result.push([min, max]);
  }
  return result;
}

/** tts_core.compute_peak_amplitude() と同じ: 最大絶対振幅を0.0〜1.0で返す。 */
export function computePeakAmplitude(audioBuffer) {
  const channel = audioBuffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < channel.length; i += 1) {
    const abs = Math.abs(channel[i]);
    if (abs > peak) peak = abs;
  }
  return Math.min(1, peak);
}

// tts_core.CLIPPING_THRESHOLD と同一。
export const CLIPPING_THRESHOLD = 0.999;

/** tts_core.is_clipped() と同一。 */
export function isClipped(peak) {
  return peak >= CLIPPING_THRESHOLD;
}

/** ピーク(0.0〜1.0)を dBFS にする(表示用。無音は -Infinity)。 */
export function peakToDbfs(peak) {
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * tts_core.find_safe_volume_gain_db() のWeb版。0dBFSを超えない(音割れしない)
 * 範囲で、できるだけ音量を上げた音量ゲイン(dB)を自動計算する。
 *
 * - cloud … ゲインは Google 側で掛かり、エンジン内部の処理で厳密に線形とは
 *   限らないため、デスクトップ版と同じく「計算 → 合成し直して確認 → 1dBずつ
 *   下げる」を最大 maxIterations 回くり返す。
 * - gemini … ゲインはこのファイル(applyGainToWav)で掛けるので完全に線形。
 *   1回合成してピークを測れば計算だけで決まる(呼び出し回数を節約できる)。
 *
 * @param {object} opts getTtsOptions() の戻り値(volumeGainDb は内部で上書きする)
 * @returns {Promise<number>} 音割れしないと判断された音量ゲイン(dB)
 */
export async function findSafeVolumeGainDb(opts, {
  headroomDb = 1.0, minGainDb = -20.0, maxGainDb = 16.0, maxIterations = 4, text = '',
} = {}) {
  const measure = async (gainDb) => {
    const { bytes } = await synthesizeTestSampleWav({ ...opts, volumeGainDb: gainDb }, text);
    return computePeakAmplitude(parseWav(bytes));
  };

  const baselinePeak = await measure(0.0);
  if (baselinePeak <= 0.0001) return 0.0;

  const targetPeak = 10 ** (-headroomDb / 20.0);
  let gainDb = 20.0 * Math.log10(targetPeak / baselinePeak);
  gainDb = Math.max(minGainDb, Math.min(maxGainDb, gainDb));
  if (engineOf(opts) === TTS_ENGINE_GEMINI) return gainDb;

  for (let i = 0; i < maxIterations; i += 1) {
    if (!isClipped(await measure(gainDb))) break;
    gainDb = Math.max(minGainDb, gainDb - 1.0);
  }

  return gainDb;
}


// ---------------------------------------------------------------------------
// HTML整形(tts_core.strip_html_for_tts の移植)
// ---------------------------------------------------------------------------
//
// tts_core.split_into_sentences() に相当する文分割自体は音声の分割単位には
// 使わない(単語/AIに質問はフィールド全体を1回で読み上げ、習熟用は既にitem側が
// 例文単位に分かれているため、2026-07-28の片桐の指示どおりどちらも文ごとには
// 分けない)。ただし2026-07-29に「日本語を含む文をTTS対象から除外する」
// オプション(下記stripJapaneseSentences)を追加したため、そちらの用途で
// split_into_sentences相当が必要になり移植した。
// 将来「文と文の間に無音を挟んで1つの音声にする」機能を足す場合もこの関数を
// 流用できる。

/** HTMLエンティティをデコードする(&amp; 等)。 */
function htmlUnescape(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

// --- 「表示のためだけの文字」を読み上げから外す(2026-08-21追加) ------------
//
// tts_core.py の _EX_NUM_SPAN_RE / _LEADING_OPTION_RE / strip_display_only_markup
// と同一。カードの見た目のためにフィールドへ焼き込まれている文字(例文の採番
// ラベル `<span class="ex-num">Ex1.</span>` と、Answer 先頭の選択肢記号
// 「(B) 」)は、そのままTTSに渡すと音声にも入ってしまう。実測で「Ex1. She
// avoids eating late at night.」の音声は3.98秒あり、より語数の多い8語の文
// (2.09秒)より長かった。差の約1.9秒が「Ex1.」の読み上げだった。
//
// **タグを消すだけでは足りない**点が肝で、`<[^>]+>` の除去では `<span>` は
// 消えても中身の「Ex1.」は残る。ラベルの除去はタグ除去より前に行うこと。
const EX_NUM_SPAN_RE = /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bex-num\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi;
// 先頭のタグ(あれば)は温存したまま「(B) 」だけを落とす。選択肢は(A)〜(D)しか
// 使っていないので、"(I) am ..." のような正当な文を巻き込まないよう範囲を絞る。
const LEADING_OPTION_RE = /^(\s*(?:<[^>]+>\s*)*)\(\s*[A-Da-d]\s*\)\s*/;

/** tts_core.strip_display_only_markup() と同一。 */
export function stripDisplayOnlyMarkup(raw) {
  return String(raw).replace(EX_NUM_SPAN_RE, '').replace(LEADING_OPTION_RE, '$1');
}

// tts_core._LABEL_ONLY_RE / _LEADING_LABEL_RE と同一(英字0〜6文字+数字1〜3
// 文字+句点)。少なくとも1桁の数字を要求することで、"Yes." "No." のような
// 正当な短文をラベルと誤認しないようにしている。
//
// 2026-08-21に**結合から除去へ変更**した。以前は「ラベルだけの極小mp3が
// 大量にできるのを防ぐ」ために次の断片へ結合していたが、それだと「Ex1. It
// was so dark...」のようにラベルごと読み上げられてしまう。
const LABEL_ONLY_RE = /^[A-Za-z]{0,6}\d{1,3}\.$/;
const LEADING_LABEL_RE = /^[A-Za-z]{0,6}\d{1,3}\.\s+(?=\S)/;

/**
 * tts_core._tts_sentences_from_html() と同一。フィールドのHTMLを、読み上げ
 * 単位の文リストへ正規化する。stripHtmlForTts と splitIntoSentences の
 * 唯一の実体で、片方だけ直して読み上げ内容と文字数見積もりがずれるのを防ぐ。
 */
function ttsSentencesFromHtml(htmlText) {
  let normalized = stripDisplayOnlyMarkup(htmlText);
  normalized = normalized.replace(/<br\s*\/?>/gi, '\n');
  normalized = normalized.replace(/<\/div>/gi, '\n');
  normalized = normalized.replace(/<[^>]+>/g, '');
  normalized = htmlUnescape(normalized);

  const sentences = [];
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const rawPart of line.split(/(?<=[.!?])\s+/)) {
      const part = rawPart.replace(/\s+/g, ' ').trim();
      if (!part || LABEL_ONLY_RE.test(part)) continue;
      const stripped = part.replace(LEADING_LABEL_RE, '');
      if (stripped) sentences.push(stripped);
    }
  }
  return sentences;
}

/**
 * tts_core.strip_html_for_tts() と同一。TTSに渡す平文を作る。
 *
 * `<br>`・`</div>` は文の区切りとして扱うが、**直前が既に「.」「!」「?」で
 * 終わっている場合は句点を足さない**。以前は無条件に ". " へ置換していたため、
 * 「…best.<br><span class="ex-num">Ex2.</span>…」が「…best.. Ex2.…」となり、
 * Ex2の直前だけ余分な間が空いていた(2026-08-21修正)。
 */
export function stripHtmlForTts(raw) {
  let out = '';
  for (const sentence of ttsSentencesFromHtml(raw)) {
    if (!out) out = sentence;
    else if (/[.!?]$/.test(out)) out += ` ${sentence}`;
    else out += `. ${sentence}`;
  }
  return out;
}

/** tts_core.split_into_sentences() と同一のロジック。 */
export function splitIntoSentences(htmlText) {
  return ttsSentencesFromHtml(htmlText);
}

// tts_core._JAPANESE_CHAR_RE と同一の範囲
// (ひらがな/カタカナ/CJK統合漢字/半角カタカナ)。
const JAPANESE_CHAR_RE = /[぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]/;

/** tts_core.contains_japanese() と同一。 */
export function containsJapanese(text) {
  return JAPANESE_CHAR_RE.test(text);
}

/**
 * tts_core.strip_japanese_sentences() と同一: フィールドの生テキスト(HTML)を
 * 文単位に分割し、日本語を含む文を除外して`<br>`で再結合する。
 * AIがプロンプト指示に反して日本語を混ぜて返してきた場合の保険用オプション
 * (⚙設定の「TTSで日本語を含む文を除外する」、2026-07-29追加)。
 */
export function stripJapaneseSentences(rawFieldText) {
  const sentences = splitIntoSentences(rawFieldText);
  const kept = sentences.filter((s) => !containsJapanese(s));
  return kept.join('<br>');
}

// ---------------------------------------------------------------------------
// フィールド単位の音声埋め込み(単語・AIに質問タブ用)
// ---------------------------------------------------------------------------

/**
 * フィールドの生HTML値**全体**を1つの音声にし、末尾に`[sound:...]`タグを1つだけ
 * 追記したHTMLを返す(tts_core.generate_tts_for_collectionの
 * per_sentence=False + gap_seconds<=0 のときと同じ挙動)。
 *
 * **文ごとに分割しないこと**は2026-07-28に片桐が指示した仕様。文ごとに個別の
 * 音声・タグを作るのは習熟用(音読)タブだけで、そちらは例文単位の
 * synthesizeExampleAudioTags()が担当する。
 *
 * @param {string} rawFieldHtml
 * @param {object} opts synthesizeSpeech() の opts に filenamePrefix と
 *   excludeJapanese? を足したもの。excludeJapaneseがtrueなら、
 *   tts_core.strip_japanese_sentences()と同様に日本語を含む文をTTS対象テキスト
 *   からだけ除外する(タグの追記先である rawFieldHtml 自体は変更しない)。
 * @param {Map<string, Uint8Array>} media 生成した音声を追加していく(呼び出し側で共有)
 * @returns {Promise<string>} 音声タグを追記したHTML(元のフィールドが空、または
 *   読み上げ対象テキストが空の場合は元のHTMLをそのまま返す = 何もしない)
 */
export async function synthesizeFieldWithTags(rawFieldHtml, opts, media) {
  const sourceForTts = opts.excludeJapanese
    ? stripJapaneseSentences(rawFieldHtml || '')
    : (rawFieldHtml || '');
  const text = stripHtmlForTts(sourceForTts);
  if (!text) return rawFieldHtml;

  const { bytes, ext } = await synthesizeSpeech(text, opts);
  const filename = `${opts.filenamePrefix}.${ext}`;
  media.set(filename, bytes);
  const tag = `[sound:${filename}]`;
  return rawFieldHtml ? `${rawFieldHtml}<br>${tag}` : tag;
}

// ---------------------------------------------------------------------------
// 習熟用(音読)タブ用: 例文ごとに個別の音声タグを作る
// ---------------------------------------------------------------------------

/**
 * 習熟用ストックの1itemが持つexamples([英文, 和訳, ハイライト語...]の配列)から、
 * 例文ごとに1つの音声を合成し、`[sound:...]`タグの配列を返す(例文の順序と
 * 対応する)。1例文=1回のTTS呼び出し(例文内をさらに文分割することはしない)。
 * 空の例文には空文字を入れる(呼び出し元はrenderItemにそのまま渡せる)。
 *
 * @param {Array} examples [[en, ja, hlWords?], ...]
 * @param {object} opts synthesizeSpeech() の opts
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
    const { bytes, ext } = await synthesizeSpeech(text, opts);
    const filename = `${filenamePrefix}_${i + 1}.${ext}`;
    media.set(filename, bytes);
    tags.push(`[sound:${filename}]`);
  }
  return tags;
}
