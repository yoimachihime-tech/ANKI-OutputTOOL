// tools/test_tts.mjs
// ---------------------------------------------------------------------------
// docs/lib/tts.js の単体テスト(Node上で直接importして実行、DOM不要)。
//
// stripHtmlForTts は tts_core.py の strip_html_for_tts() の移植なので、期待値は
// Python版の実装から手で導出した固定ケースで検証する(pythonコマンドは呼ばない。
// verify_web_parity.mjs 等と違い、このファイルは実行環境にpython3が無くても
// 通ることを意図している)。
//
// 音声の分割単位(2026-07-28、片桐の指示で確定)もここで固定している:
//   - synthesizeFieldWithTags(単語/AIに質問) … フィールド全体で1つのMP3・タグ
//   - synthesizeExampleAudioTags(習熟用)     … 例文ごとに個別のMP3・タグ
//
// 【使い方】 cd tools && node test_tts.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// stripHtmlForTts/splitIntoSentences は document.createElement('textarea') で
// HTMLエンティティをデコードするため、DOMが必要(ブラウザ実行時と同じ)。
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;

console.log('lib/tts.js の単体テスト\n');

const {
  stripHtmlForTts, splitIntoSentences, stripDisplayOnlyMarkup,
  stripJapaneseSentences, callGoogleTts, synthesizeFieldWithTags,
  synthesizeExampleAudioTags, TtsError,
  computeWaveformMinMax, computePeakAmplitude, isClipped, CLIPPING_THRESHOLD,
} = await import(new URL('../docs/lib/tts.js', import.meta.url));

/** computeWaveformMinMax/computePeakAmplitude が要求する
 * AudioBuffer.getChannelData(0) 相当の最小限のフェイク。実際のWeb Audio APIは
 * Float32Arrayを返すが、テストでは丸め誤差(0.1が0.10000000149...になる等)を
 * 避けるため、ただの配列(倍精度)をそのまま返す(呼び出し側は添字アクセスと
 * .lengthしか使わないため、配列でもFloat32Arrayでも動作は同一)。 */
const fakeAudioBuffer = (samples) => ({ getChannelData: () => samples });

// --- stripHtmlForTts / splitIntoSentences ---
//
// 期待値は tts_core.py の実装から手で導出した固定ケース(このファイルは python
// が無くても通ること)。実データそのままの文字列を使い、Python側の
// check(scratchpadの手動確認)と同じ結果になることを確かめてある。
console.log('[1] stripHtmlForTts / splitIntoSentences');

{
  const got = stripHtmlForTts('She said &quot;hi&quot;.<br>Bye.');
  const want = 'She said "hi". Bye.';
  if (got === want) ok('<br>を文の区切りにし、HTMLエンティティをデコードする');
  else fail(`stripHtmlForTtsの結果が想定と違う: ${JSON.stringify(got)}`);
}

{
  const got = stripHtmlForTts('<div>First.</div><div>Second.</div>');
  const want = 'First. Second.';
  if (got === want) ok('</div>も文の区切りにする');
  else fail(`</div>の変換結果が想定と違う: ${JSON.stringify(got)}`);
}

{
  // 2026-08-21の修正。以前は <br> を無条件に ". " へ置換していたため
  // 「…nothing.. Ex2.」と句点が二重になり、Ex2の直前だけ間が空いていた。
  const got = stripHtmlForTts('Ends with a period.<br>Next line.');
  if (!got.includes('..')) ok('直前が「.」で終わる行の後ろに句点を足さない');
  else fail(`句点が二重になっている: ${JSON.stringify(got)}`);
}

{
  if (stripHtmlForTts('  ') === '') ok('空白のみの入力は空文字になる');
  else fail('空白のみの入力の処理が想定外');
}

// --- 表示のためだけの文字を読み上げから外す(2026-08-21追加) ---
//
// 【何を守っているか】「AIに質問」タブのExampleフィールドには
// `<span class="ex-num">Ex1.</span>` という採番ラベルが焼き込まれており、
// タグだけ落とすと中身の「Ex1.」が読み上げに残る。実測で「Ex1. She avoids
// eating late at night.」の音声は3.98秒(同じ声で読んだ8語の文は2.09秒)で、
// 差の約1.9秒がラベルの読み上げだった。Answer先頭の「(B) 」も同様。
console.log('\n[1b] 表示のためだけの文字を読み上げから外す');

{
  // 実データ(Grammar Multi の Example)そのままの文字列
  const raw = '<span class="ex-num">Ex1.</span> It was so dark as to see nothing.<br>'
    + '<span class="ex-num">Ex2.</span> Hold it gently so as not to break it.';
  const got = stripHtmlForTts(raw);
  const want = 'It was so dark as to see nothing. Hold it gently so as not to break it.';
  if (got === want) ok('ex-numラベル(Ex1./Ex2.)は読み上げに入らない');
  else fail(`ex-numラベルが残っている: ${JSON.stringify(got)}`);
}

{
  const got = stripHtmlForTts('(B) The music was so loud as to wake up the whole neighborhood.');
  const want = 'The music was so loud as to wake up the whole neighborhood.';
  if (got === want) ok('Answer先頭の選択肢記号「(B) 」は読み上げに入らない');
  else fail(`選択肢記号が残っている: ${JSON.stringify(got)}`);
}

{
  const got = stripHtmlForTts('<b>(A) Correct answer.</b>');
  if (got === 'Correct answer.') ok('先頭にタグがあっても選択肢記号だけを落とす');
  else fail(`先頭タグ付きの選択肢記号の処理が想定外: ${JSON.stringify(got)}`);
}

{
  const got = stripHtmlForTts('Ex1. First sentence.<br>2. Second sentence.');
  if (got === 'First sentence. Second sentence.') ok('spanで囲まれていない素の見出しラベルも落とす');
  else fail(`素の見出しラベルが残っている: ${JSON.stringify(got)}`);
}

{
  // 誤検出の防止。数字を1桁以上要求しているので "Yes." "No." は落ちない。
  const got = stripHtmlForTts('Yes.<br>No.<br>He said "hi".');
  if (got === 'Yes. No. He said "hi".') ok('"Yes." "No." のような正当な短文は落とさない');
  else fail(`正当な短文まで落ちている: ${JSON.stringify(got)}`);
}

{
  // 選択肢は(A)〜(D)しか使わないので、"(I)" のような正当な括弧は残す。
  if (stripHtmlForTts('(I) am here.') === '(I) am here.') ok('(A)〜(D)以外の丸括弧は残す');
  else fail('(A)〜(D)以外の丸括弧まで落ちている');
}

{
  // ラベルしか無いフィールドは空になる → analyze側で「空欄」として飛ばせる。
  if (stripHtmlForTts('<span class="ex-num">Ex1.</span>') === '') ok('ラベルだけのフィールドは空文字になる');
  else fail('ラベルだけのフィールドが空にならない');
}

{
  const got = splitIntoSentences('<span class="ex-num">Ex1.</span> One.<br><span class="ex-num">Ex2.</span> Two.');
  if (deepEq(got, ['One.', 'Two.'])) ok('splitIntoSentencesもラベルを除いた文だけを返す');
  else fail(`splitIntoSentencesの結果が想定と違う: ${JSON.stringify(got)}`);
}

{
  // 「ラベルだけの極小mp3」が作られないことの回帰テスト(2026-07-27に結合で
  // 対処していた問題を、2026-08-21に除去で対処し直した)。
  const got = splitIntoSentences('Ex1.<br>Ex2.');
  if (deepEq(got, [])) ok('ラベル単体は文として切り出されない(極小mp3を作らない)');
  else fail(`ラベル単体が文として残っている: ${JSON.stringify(got)}`);
}

{
  // 日本語除外オプションと併用しても、ラベル除去が二重に効いて壊れないこと。
  const raw = '<span class="ex-num">Ex1.</span> This is English.<br>'
    + '<span class="ex-num">Ex2.</span> これは日本語です。<br>'
    + '<span class="ex-num">Ex3.</span> Another English one.';
  const got = stripHtmlForTts(stripJapaneseSentences(raw));
  if (got === 'This is English. Another English one.') ok('日本語除外オプションと併用しても壊れない');
  else fail(`日本語除外との併用結果が想定と違う: ${JSON.stringify(got)}`);
}

{
  if (stripDisplayOnlyMarkup('<span class="ex-num">Ex1.</span> Body.') === ' Body.') {
    ok('stripDisplayOnlyMarkupはタグ除去より前に使う前提でラベルごと落とす');
  } else {
    fail('stripDisplayOnlyMarkupの単体挙動が想定外');
  }
}

// --- callGoogleTts / エラー分類 ---
console.log('\n[2] callGoogleTts のエラー処理');

{
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric PerDay' } }) });
  try {
    await callGoogleTts('hello', { voiceName: 'en-US-Chirp3-HD-Iapetus', languageCode: 'en-US', apiKey: 'k' });
    fail('1日あたりのQuota超過(429/PerDay)でリトライせず即座に例外を投げるべき');
  } catch (e) {
    if (e instanceof TtsError && e.message.includes('割り当て')) ok('1日あたりのQuota超過は即座にTtsErrorとして打ち切る');
    else fail(`想定外のエラー: ${e}`);
  }
}

{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return { ok: false, status: 500, text: async () => 'internal error' };
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('fake-mp3-bytes').toString('base64') }) };
  };
  const bytes = await callGoogleTts('hello', { voiceName: 'en-US-Chirp3-HD-Iapetus', languageCode: 'en-US', apiKey: 'k' });
  if (calls === 3 && Buffer.from(bytes).toString() === 'fake-mp3-bytes') {
    ok('5xxエラーは自動リトライし、最終的に成功すれば音声データを返す');
  } else {
    fail(`5xxリトライの挙動が想定外(calls=${calls})`);
  }
}

{
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'referer restriction' } }) });
  try {
    await callGoogleTts('hello', { voiceName: 'v', languageCode: 'en-US', apiKey: 'k' });
    fail('403(リファラー制限)はリトライせず即座に例外を投げるべき');
  } catch (e) {
    if (e instanceof TtsError && e.message.includes('リファラー')) ok('403(リファラー制限)は分かりやすいメッセージで即座に打ち切る');
    else fail(`想定外のエラー: ${e}`);
  }
}

// --- synthesizeFieldWithTags (単語/AIに質問タブ相当) ---
// 2026-07-28、片桐の指示により「文ごとにMP3・タグを分けるのは習熟用タブのみ、
// 他のタブはフィールド全体で1つ」に変更した。その仕様を固定するテスト。
console.log('\n[3] synthesizeFieldWithTags(フィールド全体で1つのMP3・1つのタグ)');

{
  let calls = 0;
  const seenTexts = [];
  globalThis.fetch = async (url, init) => {
    calls += 1;
    seenTexts.push(JSON.parse(init.body).input.text);
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from(`audio-${calls}`).toString('base64') }) };
  };
  const media = new Map();
  const html = await synthesizeFieldWithTags(
    'She likes coffee.<br>He likes tea.',
    { voiceName: 'v', languageCode: 'en-US', apiKey: 'k', filenamePrefix: 'tts_word_0_example' },
    media,
  );
  const expectedHtml = 'She likes coffee.<br>He likes tea.<br>[sound:tts_word_0_example.mp3]';
  if (calls === 1 && deepEq(seenTexts, ['She likes coffee. He likes tea.'])) {
    ok('複数文を含むフィールドでもTTS呼び出しは1回だけ(文ごとに分割しない)');
  } else {
    fail(`TTS呼び出し回数/テキストが想定外: calls=${calls}, texts=${JSON.stringify(seenTexts)}`);
  }
  if (html === expectedHtml) ok('元のフィールドHTMLの末尾に[sound:...]タグを1つだけ追記する');
  else fail(`生成HTMLが想定外:\n  got : ${html}\n  want: ${expectedHtml}`);
  if (media.size === 1 && media.has('tts_word_0_example.mp3')) {
    ok('media Mapに登録されるmp3は1件だけ(連番サフィックスは付かない)');
  } else {
    fail(`mediaの内容が想定外: ${[...media.keys()]}`);
  }
}

{
  // 空フィールドは何もしない(TTSを呼ばず元のHTMLをそのまま返す)。
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ audioContent: '' }) }; };
  const media = new Map();
  const html = await synthesizeFieldWithTags('', { voiceName: 'v', languageCode: 'en-US', apiKey: 'k', filenamePrefix: 'p' }, media);
  if (calls === 0 && html === '' && media.size === 0) ok('空フィールドはTTSを呼ばずそのまま返す');
  else fail('空フィールドの処理が想定外');
}

// --- synthesizeExampleAudioTags (習熟用タブ相当) ---
// こちらは逆に「例文ごとに分ける」のが仕様(音読練習で1文ずつ再生するため)。
console.log('\n[4] synthesizeExampleAudioTags(例文ごとに個別のMP3・タグ)');

{
  let calls = 0;
  const seenTexts = [];
  globalThis.fetch = async (url, init) => {
    calls += 1;
    seenTexts.push(JSON.parse(init.body).input.text);
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from(`audio-${calls}`).toString('base64') }) };
  };
  const media = new Map();
  const examples = [
    ["She doesn't like coffee.", '彼女はコーヒーが好きではない。'],
    ['', '(和訳のみ、英文なし)'],
    ['He doesn\'t like tea. Really.', '彼はお茶が好きではない。'],
  ];
  const tags = await synthesizeExampleAudioTags(examples, { voiceName: 'v', languageCode: 'en-US', apiKey: 'k' }, media, 'tts_shuujuku_0');
  const want = ['[sound:tts_shuujuku_0_1.mp3]', '', '[sound:tts_shuujuku_0_3.mp3]'];
  if (deepEq(tags, want)) ok('例文ごとに1つのタグを返し、空の例文には空文字を返す(インデックスはexamples全体基準)');
  else fail(`tagsが想定外: ${JSON.stringify(tags)}`);
  if (calls === 2 && deepEq(seenTexts, ["She doesn't like coffee.", "He doesn't like tea. Really."])) {
    ok('1例文=1回のTTS呼び出し(例文内をさらに文分割しない)');
  } else {
    fail(`TTS呼び出しが想定外: calls=${calls}, texts=${JSON.stringify(seenTexts)}`);
  }
  if (media.size === 2) ok('空でない例文の分だけmediaに登録される');
  else fail(`mediaサイズが想定外: ${media.size}`);
}

// --- computeWaveformMinMax / computePeakAmplitude / isClipped ---
// tts_core.compute_waveform_minmax / compute_peak_amplitude / is_clipped の
// Web版。2026-10-05からは parseWav() の戻り値(WAV を読んだもの)を受け取る
// (getChannelData(0) が -1.0〜+1.0 を返す形なので、ここでは配列のフェイクで足りる)。
console.log('\n[5] computeWaveformMinMax / computePeakAmplitude / isClipped');

{
  // 8サンプルを4バケットに分割(1バケット=2サンプル)。各バケットの[min, max]を検証する。
  const buffer = fakeAudioBuffer([0.1, -0.2, 0.5, -0.5, 0.0, 0.0, -0.9, 0.3]);
  const buckets = computeWaveformMinMax(buffer, 4);
  const want = [[-0.2, 0.1], [-0.5, 0.5], [0, 0], [-0.9, 0.3]];
  if (buckets.length === 4 && deepEq(buckets, want)) {
    ok('バケットごとの[min, max]を正しく計算する(既に-1.0〜1.0範囲なので正規化不要)');
  } else {
    fail(`computeWaveformMinMaxの結果が想定外: ${JSON.stringify(buckets)}`);
  }
}

{
  // サンプル数(2)がbucket数(4)より少ない場合、bucketSizeは1になり
  // (Math.max(1, Math.floor(2/4)))、各バケットに1サンプルずつ割り当てられ、
  // 余ったバケットは[0, 0]になる。
  const buckets = computeWaveformMinMax(fakeAudioBuffer([0.4, -0.6]), 4);
  if (deepEq(buckets, [[0, 0.4], [-0.6, 0], [0, 0], [0, 0]])) {
    ok('サンプル数がバケット数に満たない場合、余ったバケットは[0, 0]になる');
  } else {
    fail(`短い入力での結果が想定外: ${JSON.stringify(buckets)}`);
  }
}

{
  if (computePeakAmplitude(fakeAudioBuffer([0.1, -0.7, 0.3])) === 0.7) {
    ok('最大絶対振幅を返す(符号を無視)');
  } else {
    fail('computePeakAmplitudeの結果が想定外');
  }
}

{
  // 1.0を超える値が来ても(理論上は起きないはずだが)1.0にクランプする。
  if (computePeakAmplitude(fakeAudioBuffer([1.5, -0.2])) === 1) {
    ok('振幅は1.0を上限にクランプされる');
  } else {
    fail('computePeakAmplitudeのクランプが想定外');
  }
}

{
  if (isClipped(CLIPPING_THRESHOLD) && isClipped(1) && !isClipped(CLIPPING_THRESHOLD - 0.001)) {
    ok('isClippedは閾値(0.999)以上でtrueを返す');
  } else {
    fail('isClippedの閾値判定が想定外');
  }
}

// --- WAV の読み書き・音量ゲイン(2026-10-05追加) ---
// テスト再生の波形は、Web Audio API を使わずに WAV の PCM を直接読むように
// なった(iOS で AudioContext が <audio> の再生と干渉するのを避けるため)。
console.log('\n[6] parseWav / pcmToWav / toWavBytes / applyGainToWav');

const {
  parseWav, pcmToWav, toWavBytes, applyGainToWav, encodeWavToMp3,
  synthesizeSpeech, synthesizeTestSampleWav, findSafeVolumeGainDb, listCloudVoices,
  languageCodeFromVoiceName, PREBUILT_VOICES, GEMINI_TTS_MODELS, geminiTtsSupportsStyle,
} = await import(new URL('../docs/lib/tts.js', import.meta.url));

/** -1.0〜+1.0 のサンプル列から 16bit PCM のバイト列を作る。 */
function pcm16(samples) {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  samples.forEach((v, i) => dv.setInt16(i * 2, Math.round(v * 32767), true));
  return out;
}

{
  const wav = pcmToWav(pcm16([0, 0.5, -0.5, 0.25]), 24000);
  const parsed = parseWav(wav);
  const ch = parsed.getChannelData(0);
  if (parsed.sampleRate === 24000 && parsed.length === 4 && Math.abs(ch[1] - 0.5) < 0.001
      && Math.abs(ch[2] + 0.5) < 0.001 && Math.abs(parsed.duration - 4 / 24000) < 1e-9) {
    ok('pcmToWav で作った WAV を parseWav で読み戻せる(サンプル値・長さ・秒数)');
  } else {
    fail(`parseWav の結果が想定外: ${JSON.stringify({ sr: parsed.sampleRate, len: parsed.length })}`);
  }
}

{
  // fmt と data の間に別のチャンク(LIST)が挟まっていても読める
  const base = pcmToWav(pcm16([0.1, 0.2]), 16000);
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
  const withList = new Uint8Array(base.length + list.length);
  withList.set(base.subarray(0, 36), 0);
  withList.set(list, 36);
  withList.set(base.subarray(36), 36 + list.length);
  const parsed = parseWav(withList);
  if (parsed.length === 2 && parsed.sampleRate === 16000) ok('余分なチャンクがあっても data チャンクを探して読む');
  else fail('LIST チャンク入りの WAV を読めない');
}

{
  // 古いプレビュー版の Gemini TTS はヘッダー無しの PCM を返す
  const wav = toWavBytes(pcm16([0.1, 0.2, 0.3]), 'audio/L16;codec=pcm;rate=24000');
  const parsed = parseWav(wav);
  if (parsed.sampleRate === 24000 && parsed.length === 3) ok('ヘッダー無しの PCM(audio/L16)を WAV に包み直す');
  else fail('PCM から WAV への包み直しが想定外');
  const already = pcmToWav(pcm16([0.1]), 24000);
  if (toWavBytes(already, 'audio/wav') === already) ok('すでに WAV ならそのまま返す');
  else fail('WAV をさらに包み直している');
}

{
  const wav = pcmToWav(pcm16([0.1, -0.2]), 24000);
  const { bytes, limited } = applyGainToWav(wav, 6);
  const ch = parseWav(bytes).getChannelData(0);
  if (!limited && Math.abs(ch[1] - (-0.2 * 10 ** (6 / 20))) < 0.002) ok('+6dB で振幅が約2倍になる');
  else fail(`ゲインの掛かり方が想定外: ${ch[1]}`);
  if (parseWav(wav).getChannelData(0)[1] < -0.19 && parseWav(wav).getChannelData(0)[1] > -0.21) {
    ok('元の WAV は書き換えない(コピーに掛ける)');
  } else {
    fail('applyGainToWav が元の WAV を書き換えている');
  }
}

{
  // 上げすぎて音割れする分は自動で抑える(Gemini は呼ぶたびに音量が少し変わるため)
  const wav = pcmToWav(pcm16([0.5, -0.5]), 24000);
  const { bytes, limited } = applyGainToWav(wav, 16);
  const peak = computePeakAmplitude(parseWav(bytes));
  if (limited && peak < CLIPPING_THRESHOLD && peak > 0.9) ok(`音割れしないところで止める(ピーク ${peak.toFixed(3)})`);
  else fail(`リミッターが効いていない: peak=${peak} limited=${limited}`);
}

{
  globalThis.lamejs = {
    Mp3Encoder: class {
      constructor(ch, rate, kbps) { this.args = [ch, rate, kbps]; globalThis.__lameArgs = this.args; }
      encodeBuffer(l) { return new Int8Array([l.length % 7]); }
      flush() { return new Int8Array([9]); }
    },
  };
  const mp3 = await encodeWavToMp3(pcmToWav(pcm16(new Array(3000).fill(0.1)), 24000), 64);
  if (mp3 instanceof Uint8Array && mp3.length === 4 && deepEq(globalThis.__lameArgs, [1, 24000, 64])) {
    ok('lamejs があれば WAV を 1152 サンプルずつ MP3 に圧縮する(モノラル・元のサンプルレート)');
  } else {
    fail(`MP3 圧縮の呼び方が想定外: len=${mp3 && mp3.length} args=${globalThis.__lameArgs}`);
  }
  globalThis.lamejs = null;
  if (await encodeWavToMp3(pcmToWav(pcm16([0.1]), 24000)) === null) ok('lamejs が使えなければ null(WAV のまま使う)');
  else fail('lamejs が無いのに MP3 を返した');
}

// --- 音声エンジン(2026-10-05追加) ---
console.log('\n[7] synthesizeSpeech(Cloud / Gemini TTS の切り替え)');

{
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('mp3').toString('base64') }) };
  };
  // 音声名と言語コードが食い違っていても、音声名の言語を使う(以前は400になっていた)
  await callGoogleTts('hi', { voiceName: 'en-GB-Chirp3-HD-Kore', languageCode: 'en-US', apiKey: 'k' });
  if (body.voice.languageCode === 'en-GB') ok('言語コードは音声名の先頭(en-GB-…)に合わせる');
  else fail(`languageCode: ${body.voice.languageCode}`);
  const res = await synthesizeSpeech('hi', { voiceName: 'en-US-Chirp3-HD-Kore', apiKey: 'k' }, { purpose: 'apkg' });
  if (res.ext === 'mp3' && body.audioConfig.audioEncoding === 'MP3') ok('Cloud(既定)は従来どおり MP3 を受け取る');
  else fail(`Cloud の合成結果: ${res.ext} / ${body.audioConfig.audioEncoding}`);

  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from(pcmToWav(pcm16([0.1]), 24000)).toString('base64') }) };
  };
  const wav = await synthesizeSpeech('hi', { voiceName: 'en-US-Chirp3-HD-Kore', apiKey: 'k' }, { purpose: 'wav' });
  if (wav.ext === 'wav' && body.audioConfig.audioEncoding === 'LINEAR16') ok('テスト再生用は Cloud でも WAV(LINEAR16)で受け取る');
  else fail(`テスト再生用の形式: ${wav.ext} / ${body.audioConfig.audioEncoding}`);
}

{
  const requests = [];
  const geminiWav = pcmToWav(pcm16([0.25, -0.25, 0.1]), 24000);
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from(geminiWav).toString('base64') } }] } }] }),
    };
  };
  globalThis.lamejs = null;
  const opts = {
    engine: 'gemini', geminiApiKey: 'gk', model: 'gemini-3.8-flash-lite-tts', voiceName: 'Puck', style: 'calm', volumeGainDb: 6,
  };
  const res = await synthesizeSpeech('Hello there.', opts, { purpose: 'apkg' });
  const req = requests[0];
  if (req.url.endsWith('/models/gemini-3.8-flash-lite-tts:generateContent') && req.headers['x-goog-api-key'] === 'gk') {
    ok('Gemini TTS は Gemini API(generateContent)を Gemini のキーで呼ぶ');
  } else {
    fail(`Gemini TTS の呼び先: ${req.url}`);
  }
  const cfg = req.body.generationConfig;
  if (deepEq(cfg.responseModalities, ['AUDIO']) && cfg.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Puck'
      && req.body.contents[0].parts[0].speechMetadata?.style === 'calm') {
    ok('音声・読み方の指示(3.8以降)をリクエストに入れる');
  } else {
    fail(`Gemini TTS のリクエスト: ${JSON.stringify(req.body)}`);
  }
  const peak = computePeakAmplitude(parseWav(res.bytes));
  if (res.ext === 'wav' && Math.abs(peak - 0.25 * 10 ** (6 / 20)) < 0.005) {
    ok('音量ゲインはローカルで掛ける(Gemini TTS に音量の指定が無いため)');
  } else {
    fail(`ゲイン適用後のピーク: ${peak} ext=${res.ext}`);
  }

  requests.length = 0;
  await synthesizeSpeech('Hi.', { ...opts, model: 'gemini-2.5-pro-preview-tts' });
  if (!('speechMetadata' in requests[0].body.contents[0].parts[0])) {
    ok('読み方の指示は対応していない古いモデルには送らない(400を避ける)');
  } else {
    fail('古いモデルにも speechMetadata を送っている');
  }

  // 自動調整: Gemini はゲインを自分で掛けるので、1回合成すれば計算だけで決まる
  requests.length = 0;
  const gain = await findSafeVolumeGainDb(opts);
  const expected = 20 * Math.log10(10 ** (-1 / 20) / 0.25);
  if (requests.length === 1 && Math.abs(gain - expected) < 0.05) {
    ok(`Gemini の自動調整は1回の呼び出しで済む(${gain.toFixed(1)}dB)`);
  } else {
    fail(`Gemini の自動調整: ${requests.length} 回 / ${gain}`);
  }

  requests.length = 0;
  await synthesizeTestSampleWav(opts, '  ');
  if (requests[0].body.contents[0].parts[0].text.startsWith('This is a short test sentence.')) {
    ok('テスト再生の文が空なら既定のサンプル文を読む');
  } else {
    fail('テスト再生の既定の文が使われていない');
  }

  // 音声が返ってこない応答(テキストだけ・ブロック等)は分かりやすいエラーにする
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'OTHER', content: { parts: [{ text: 'hmm' }] } }] }) });
  try {
    await synthesizeSpeech('Hi.', opts);
    fail('音声の無い応答で例外にならなかった');
  } catch (e) {
    if (e.message.includes('音声が返ってきませんでした')) ok('音声の無い応答は理由付きのエラーにする');
    else fail(`想定外のエラー: ${e.message}`);
  }

  try {
    await synthesizeSpeech('Hi.', { ...opts, geminiApiKey: '' });
    fail('Gemini のキーが無いのに例外にならなかった');
  } catch (e) {
    if (e instanceof TtsError && e.message.includes('Gemini APIキー')) ok('Gemini のキーが無ければ分かりやすいエラーにする');
    else fail(`想定外のエラー: ${e}`);
  }
}

{
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      voices: [
        { name: 'Kore', languageCodes: ['en-US'], ssmlGender: 'FEMALE' },
        { name: 'en-US-Chirp3-HD-Kore', languageCodes: ['en-US'], ssmlGender: 'FEMALE' },
        { name: 'en-US-Neural2-A', languageCodes: ['en-US'], ssmlGender: 'MALE' },
      ],
    }),
  });
  const voices = await listCloudVoices('en-US', 'k');
  if (deepEq(voices.map((v) => v.name), ['en-US-Chirp3-HD-Kore', 'en-US-Neural2-A'])
      && voices[1].family === 'Neural2' && voices[1].gender === 'M') {
    ok('音声一覧から言語コードの無い名前(Cloud経由の Gemini 用。APIキーでは使えない)を除く');
  } else {
    fail(`音声一覧: ${JSON.stringify(voices)}`);
  }
}

{
  if (PREBUILT_VOICES.length === 30 && GEMINI_TTS_MODELS[0].id === 'gemini-3.8-flash-tts'
      && geminiTtsSupportsStyle('gemini-3.8-flash-tts') && geminiTtsSupportsStyle('gemini-4-flash-tts')
      && !geminiTtsSupportsStyle('gemini-3.1-flash-tts-preview')
      && languageCodeFromVoiceName('en-AU-Chirp3-HD-Leda') === 'en-AU' && languageCodeFromVoiceName('Kore') === null) {
    ok('音声30種・新しいモデル一覧・読み方の指示の対応判定・音声名からの言語の取り出し');
  } else {
    fail('音声・モデルの定義が想定外');
  }
}

console.log(`\n${failures === 0 ? '✅ 全テスト成功' : `❌ ${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
