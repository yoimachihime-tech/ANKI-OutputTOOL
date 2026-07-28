// tools/test_tts.mjs
// ---------------------------------------------------------------------------
// docs/lib/tts.js の単体テスト(Node上で直接importして実行、DOM不要)。
//
// splitIntoSentences/stripHtmlForTts は tts_core.py の split_into_sentences() /
// strip_html_for_tts() の移植なので、期待値はPython版の実装(コメントの
// _LABEL_ONLY_RE = re.compile(r"^[A-Za-z]{0,6}\d{1,3}\.$") 等)から手で
// 導出した固定ケースで検証する(pythonコマンドは呼ばない。verify_web_parity.mjs
// 等と違い、このファイルは実行環境にpython3が無くても通ることを意図している)。
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
  splitIntoSentences, stripHtmlForTts, callGoogleTts, synthesizeFieldWithTags,
  synthesizeExampleAudioTags, TtsError,
} = await import(new URL('../docs/lib/tts.js', import.meta.url));

// --- splitIntoSentences ---
console.log('[1] splitIntoSentences');

{
  const got = splitIntoSentences('She doesn\'t like it. He likes it too.');
  const want = ["She doesn't like it.", 'He likes it too.'];
  if (deepEq(got, want)) ok('句点区切りの1行を2文に分割する');
  else fail(`1行2文の分割に失敗: ${JSON.stringify(got)}`);
}

{
  // 「Ex1.」のような見出しラベル単体の断片は、次の断片(実際の文)に結合される
  // (_LABEL_ONLY_RE: 英字0〜6文字+数字1〜3文字+句点)。
  const got = splitIntoSentences('Ex1. She likes coffee.<br>2. He likes tea.');
  const want = ['Ex1. She likes coffee.', '2. He likes tea.'];
  if (deepEq(got, want)) ok('見出しラベル("Ex1." "2.")は次の文に結合される(独立した極小文にならない)');
  else fail(`見出しラベルの結合に失敗: ${JSON.stringify(got)}`);
}

{
  // "Yes." "No." のような正当な短文はラベルと誤認しない(数字を含まないため)。
  const got = splitIntoSentences('Yes. That is correct.');
  const want = ['Yes.', 'That is correct.'];
  if (deepEq(got, want)) ok('"Yes."のような数字を含まない短文はラベルと誤認しない');
  else fail(`短文の誤結合を検出: ${JSON.stringify(got)}`);
}

{
  const got = splitIntoSentences('<div>First sentence.</div><div>Second sentence.</div>');
  const want = ['First sentence.', 'Second sentence.'];
  if (deepEq(got, want)) ok('</div>も改行として扱い文単位に分割する');
  else fail(`</div>区切りの分割に失敗: ${JSON.stringify(got)}`);
}

{
  const got = splitIntoSentences('  ');
  if (deepEq(got, [])) ok('空白のみの入力は空配列を返す');
  else fail(`空白のみの入力で不正な結果: ${JSON.stringify(got)}`);
}

// --- stripHtmlForTts ---
console.log('\n[2] stripHtmlForTts');

{
  const got = stripHtmlForTts('She said &quot;hi&quot;.<br>Bye.');
  const want = 'She said "hi".. Bye.';
  if (got === want) ok('<br>を". "に変換しHTMLエンティティをデコードする');
  else fail(`stripHtmlForTtsの結果が想定と違う: ${JSON.stringify(got)}`);
}

// --- callGoogleTts / エラー分類 ---
console.log('\n[3] callGoogleTts のエラー処理');

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
console.log('\n[4] synthesizeFieldWithTags');

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
    'Ex1. She likes coffee.<br>2. He likes tea.',
    { voiceName: 'v', languageCode: 'en-US', apiKey: 'k', filenamePrefix: 'tts_word_0_example' },
    media,
  );
  const expectedHtml = 'Ex1. She likes coffee.<br>2. He likes tea.<br>'
    + '[sound:tts_word_0_example_1.mp3]<br>[sound:tts_word_0_example_2.mp3]';
  if (calls === 2 && deepEq(seenTexts, ['Ex1. She likes coffee.', '2. He likes tea.'])) {
    ok('見出しラベル結合後の2文に対して2回TTSを呼ぶ');
  } else {
    fail(`TTS呼び出し回数/テキストが想定外: calls=${calls}, texts=${JSON.stringify(seenTexts)}`);
  }
  if (html === expectedHtml) ok('元のフィールドHTMLの末尾に<br>区切りで[sound:...]タグを追記する');
  else fail(`生成HTMLが想定外:\n  got : ${html}\n  want: ${expectedHtml}`);
  if (media.size === 2 && media.has('tts_word_0_example_1.mp3') && media.has('tts_word_0_example_2.mp3')) {
    ok('media Mapに文ごとのファイル名でmp3が2件登録される');
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
console.log('\n[5] synthesizeExampleAudioTags');

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

console.log(`\n${failures === 0 ? '✅ 全テスト成功' : `❌ ${failures} 件失敗`}`);
process.exit(failures === 0 ? 0 : 1);
