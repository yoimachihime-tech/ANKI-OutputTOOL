// tools/verify_grammar_multi_parity.mjs
// ---------------------------------------------------------------------------
// docs/lib/gemini.js の generateGrammarMultiItems() が、gemini_client.py の
// generate_grammar_multi_items_from_question() と同じ後処理結果(改行整形・
// 正解記号の付与・choice/whynot/exampleのHTML化)になることを検証する。
//
// Gemini の生の応答は同一の固定 JSON を使い(API は呼ばない)、両者に
// 同じ後処理をかけて item を突き合わせる。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Gemini が返す想定の生JSON配列(3問: 選択/誤り訂正/記述式)。
// 日本語→英文の境目、複数文の答え、correct_optの不一致(フォールバック検証)
// をそれぞれ含めてある。
const RAW_NOTES = [
  {
    pattern: '選択問題',
    question: "空所に入る最も適切な語を選択肢から選びなさい。'She showed great ___ when dealing with the difficult customers.'",
    choices: [{ opt: 'A', text: 'patient' }, { opt: 'B', text: 'patience' }, { opt: 'C', text: 'patiently' }],
    answer: 'patience',
    answer_ja: '彼女はとても辛抱強かった。',
    correct_opt: 'B',
    // 2026-08-21: 学習対象語を <b> で囲む形式(穴埋めカードの空所になる)。
    examples: [['She has a lot of <b>patience</b>.', '彼女は忍耐力がある。']],
    why: '空所は名詞が入る位置です。',
    whynot: [{ opt: 'A', reason: 'patient は形容詞または名詞(患者)。' }, { opt: 'C', reason: 'patiently は副詞。' }],
  },
  {
    pattern: '誤り訂正問題',
    question: "次の英文を訂正してください。'I go to school yesterday. I very like it.'",
    choices: [],
    answer: 'I went to school yesterday. I liked it very much.',
    answer_ja: '私は昨日学校へ行きました。とても気に入りました。',
    correct_opt: '',
    examples: [],
    why: '過去の出来事なので過去形にする必要があります。',
    whynot: [],
  },
  {
    pattern: '記述式・書き換え問題',
    // 2026-07-29に報告された実例: 引用符を使わず「(1)」「(2)」の連番ラベルで
    // 文を並べる形式。修正前は日本語の指示文・(1)・(2)がすべて改行なしの
    // 1段落になってしまっていた(_JA_EN_BOUNDARY_RE / _EN_SENTENCE_BREAK_RE
    // が引用符・大文字始まりしか境界と認識していなかったため)。
    question: '以下の2つの文を1文にまとめ、「良い照明は部屋を広く見せるのに役立つ」'
      + 'という意味の文を作りなさい。 (1) Good lighting helps. (2) It makes the room look spacious.',
    choices: [],
    // correct_opt無しでも choices が空ならそのまま answer が使われることを確認
    answer: 'It was raining, but we went out anyway.',
    answer_ja: '雨が降っていたが、私たちはとにかく出かけた。',
    correct_opt: '',
    examples: [],
    why: '逆接の接続詞butで2文を結びます。',
    whynot: [],
  },
];

// 意味・本質問題(2026-10-07追加)として Gemini が返す想定の生JSON。
// 採用されるもの・捨てられるものを混ぜ、どちらの判定も Python 版と一致することを
// 確かめる。期待する結果は各要素のコメントのとおり(最大3問なので最後の1件は落ちる)。
const RAW_MEANING = [
  { // 採用: 例文に問題文の英語がそのまま入っている
    target: 'otherwise',
    question: '「unless otherwise instructed(別段の指示がない限り)」における otherwise の本質的な意味として、最も適切なものを1つ選びなさい。',
    choices: [
      { opt: 'A', text: 'そうではない状況では(さもないと)' },
      { opt: 'B', text: 'その指示された内容とは別の方法・方向で' },
      { opt: 'C', text: 'これまでのすべての手順に従って忠実に' },
    ],
    correct_opt: 'B',
    core_image: 'other(別の)+ wise(方向・様態)が原義。',
    whynot: [{ opt: 'A', reason: '「さもないと」は別の用法。' }, { opt: 'C', reason: '指示に従う意味ではない。' }],
    example_en: 'You must wear a helmet unless <b>otherwise</b> instructed.',
    example_ja: '別段の指示がない限り、ヘルメットを着用しなければならない。',
  },
  { // 捨てる: 接尾辞が対象(語源の説明が作り話になる)
    target: '-ce と -t',
    question: '「difference(違い)」の語尾 -ce の本質的な働きとして、最も適切なものを1つ選びなさい。',
    choices: [{ opt: 'A', text: 'あ' }, { opt: 'B', text: 'い' }, { opt: 'C', text: 'う' }],
    correct_opt: 'A',
    core_image: '...',
    whynot: [],
    example_en: 'It makes a <b>difference</b>.',
    example_ja: '違いを生む。',
  },
  { // 採用(例文は捨てる): 例文が問題文の英語を含まない。
    // 誤答の理由のキー名が "text" になっている取り違えも読み替える。
    target: 'deny',
    question: '「He denied stealing the money(彼はお金を盗んだことを否定した)」における deny の本質的な働きとして、最も適切なものを1つ選びなさい。',
    choices: [
      { opt: 'A', text: 'すでに起きた事実を打ち消す' },
      { opt: 'B', text: 'これからの計画を断る' },
      { opt: 'C', text: '相手に意志を押し付ける' },
    ],
    correct_opt: 'A',
    core_image: '動名詞は「すでにある現実」を表し、deny はそれを打ち消す。',
    whynot: [{ opt: 'B', text: '未来の計画を断るのは refuse。' }, { opt: 'C', reason: '意志の押し付けではない。' }],
    example_en: 'She <b>denied</b> taking the car.',
    example_ja: '彼女は車を持ち出したことを否定した。',
  },
  { // 捨てる: 「」の中に英語の語句が無い
    target: 'deny',
    question: '動詞 deny の後ろに「動名詞(-ing)」が来る本質的な理由として、最も適切なものを1つ選びなさい。',
    choices: [{ opt: 'A', text: 'あ' }, { opt: 'B', text: 'い' }, { opt: 'C', text: 'う' }],
    correct_opt: 'A',
    core_image: '...',
    whynot: [],
    example_en: '',
    example_ja: '',
  },
  { // 捨てる: 正解の記号が選択肢に無い
    target: 'used to',
    question: '「I used to swim(以前は泳いでいた)」における used to の本質的な意味として、最も適切なものを1つ選びなさい。',
    choices: [{ opt: 'A', text: 'あ' }, { opt: 'B', text: 'い' }, { opt: 'C', text: 'う' }],
    correct_opt: 'D',
    core_image: '...',
    whynot: [],
    example_en: 'I <b>used to</b> swim every day.',
    example_ja: '以前は毎日泳いでいた。',
  },
  { // 捨てる: 正解だけが長く詳しく、読まずに当てられる
    // (2026-10-07に実際に出た形: 26字/34字/45字(正解) = 誤答の平均の1.5倍)
    target: 'said',
    question: '「Tom said that he was tired(トムは疲れていると言った)」における said の本質的な働きとして、最も適切なものを1つ選びなさい。',
    choices: [
      { opt: 'A', text: '未来に起こる不確実な出来事を予想して相手に注意を促す' },
      { opt: 'B', text: '相手に対して命令や強い要求を伝達し、その場の状況を強制的に変化させる' },
      { opt: 'C', text: '過去に発せられた発言の事実を伝えるとともに、その後の従属節全体の時制を過去の基準に引き込む' },
    ],
    correct_opt: 'C',
    core_image: '...',
    whynot: [],
    example_en: 'Tom <b>said</b> that he was tired.',
    example_ja: 'トムは疲れていると言った。',
  },
  { // 採用
    target: 'would',
    question: '「I would rather stay home(むしろ家にいたい)」における would の本質的な働きとして、最も適切なものを1つ選びなさい。',
    choices: [
      { opt: 'A', text: '過去の習慣を表す' },
      { opt: 'B', text: '控えめな意向を表す' },
      { opt: 'C', text: '未来の予定を断定する' },
    ],
    correct_opt: 'B',
    core_image: '仮定の距離を置いて、意向を控えめに示す。',
    whynot: [{ opt: 'A', reason: '習慣の would とは別。' }, { opt: 'C', reason: '断定ではない。' }],
    example_en: 'I would rather stay home tonight.',
    example_ja: '今夜はむしろ家にいたい。',
  },
  { // 捨てる: 上限(3問)を超える4問目
    target: 'rather',
    question: '「I would rather stay home(むしろ家にいたい)」における rather の本質的な働きとして、最も適切なものを1つ選びなさい。',
    choices: [{ opt: 'A', text: 'あ' }, { opt: 'B', text: 'い' }, { opt: 'C', text: 'う' }],
    correct_opt: 'A',
    core_image: '...',
    whynot: [],
    example_en: 'I would <b>rather</b> stay home.',
    example_ja: 'むしろ家にいたい。',
  },
];

// 実行するPythonコマンド。既定は `python3` だが、その名前で起動できる
// Pythonが無い環境(片桐のWindows実機ではWindowsAppsのスタブが先に見つかり、
// genankiの入った C:\Python314\python.exe とは別物になる)では、環境変数
// ANKI_TOOL_PYTHON で実際に使えるコマンド・フルパスを指定できる。
//   例: ANKI_TOOL_PYTHON=/c/Python314/python.exe npm test
const PYTHON = process.env.ANKI_TOOL_PYTHON || 'python3';

const QUESTION = 'patience と patient の使い分けを教えて';
// 生成1回ぶんを識別する値。通常は実装側が採番するが、Python版とWeb版で同じ値に
// ならないと突き合わせられないので、テストからは固定値を渡す(2026-08-29追加)。
const BATCH_KEY = 'testbatch001';

console.log('Grammar Multi 後処理の一致検証(gemini_client.py ⇔ docs/lib/gemini.js)\n');

// --- Python 側: gemini_client.py の内部処理をそのまま流用して期待値を作る ---
const pyStdout = execFileSync(
  PYTHON,
  ['-c', `
import sys, json
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, r'${dirname(HERE)}')
import gemini_client as gc

raw = json.load(sys.stdin)
# 後処理は実装そのもの(gemini_client.build_grammar_multi_items)を呼ぶ
# (2026-10-07に変更。以前はここに後処理を書き写しており、実装側だけ
#  直してもテストが気づけない形だった)。
items = gc.build_grammar_multi_items(raw['notes'], raw['meaning'], raw['question'], raw['batch_key'])
for it in items:
    it.pop('source_key', None)
    it.pop('source_label', None)

# 応答の形の読み取り: 新しい形({problems, meaning})も、以前の形(3問の配列だけ)も読める。
new_shape = gc._parse_grammar_multi_response(json.dumps({'problems': raw['notes'], 'meaning': raw['meaning']}))
# (このPythonはJSのテンプレート文字列の中にあるので、バッククォートと改行は
#  chr() で組み立てる)
fence, nl = chr(96) * 3, chr(10)
old_shape = gc._parse_grammar_multi_response(fence + 'json' + nl + json.dumps(raw['notes']) + nl + fence)
assert new_shape == (raw['notes'], raw['meaning']), 'new shape'
assert old_shape == (raw['notes'], []), 'old shape'
json.dump(items, sys.stdout, ensure_ascii=False)
`],
  {
    input: Buffer.from(JSON.stringify({
      question: QUESTION, notes: RAW_NOTES, meaning: RAW_MEANING, batch_key: BATCH_KEY,
    }), 'utf8'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    maxBuffer: 8 * 1024 * 1024,
  },
);
const expected = JSON.parse(pyStdout.toString('utf8'));

// --- Web版: 実際に generateGrammarMultiItems() を、fetch をモックして呼ぶ ---
globalThis.window = globalThis;
const { generateGrammarMultiItems } = await import(new URL('../docs/lib/gemini.js', import.meta.url));

let lastRequestBody = null;
globalThis.fetch = async (_url, init = {}) => {
  lastRequestBody = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ problems: RAW_NOTES, meaning: RAW_MEANING }) }] } }],
    }),
  };
};

const promptTemplate = 'ダミープロンプト {{question}}'; // 実プロンプト全文は不要(整形処理だけを検証する)
const RESPONSE_SCHEMA = JSON.parse(readFileSync(
  join(dirname(HERE), 'docs', 'shared', 'grammar_multi_response_schema.json'), 'utf8',
));
const actual = await generateGrammarMultiItems({
  question: QUESTION,
  apiKey: 'DUMMY',
  model: 'gemini-2.0-flash',
  promptTemplate,
  responseSchema: RESPONSE_SCHEMA,
  batchKey: BATCH_KEY,
});

let failures = 0;
const FIELD_KEYS = ['pattern', 'question', 'choices', 'answer', 'answer_plain', 'answer_ja', 'example',
  'example_ja', 'example_blank', 'why', 'whynot', 'topic_key', 'note_index', 'batch_key'];

if (actual.length !== expected.length) {
  console.error(`❌ 件数不一致: web=${actual.length} / python=${expected.length}`);
  failures += 1;
}
for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) {
  const label = `[${i}] ${expected[i].pattern}`;
  let itemOk = true;
  for (const key of FIELD_KEYS) {
    if (JSON.stringify(actual[i][key]) !== JSON.stringify(expected[i][key])) {
      console.error(`❌ ${label} の ${key} が不一致`);
      console.error(`   web   : ${JSON.stringify(actual[i][key])}`);
      console.error(`   python: ${JSON.stringify(expected[i][key])}`);
      failures += 1;
      itemOk = false;
    }
  }
  if (itemOk) console.log(`  ✅ ${label}: 全フィールド一致`);
}

// --- 意味・本質問題の判定そのもの(Python版と一致するだけでなく、狙いどおりか) ---
const check = (cond, okMsg, ngMsg) => {
  if (cond) console.log(`  ✅ ${okMsg}`);
  else { console.error(`❌ ${ngMsg}`); failures += 1; }
};
const meaningItems = actual.filter((it) => it.pattern === '意味・本質問題');
check(actual.length === 6 && meaningItems.length === 3,
  '意味・本質問題は使えるものだけ・最大3問が残る(3問+3問=6件)',
  `件数が想定外: 全${actual.length}件 / 意味・本質問題${meaningItems.length}件`);
check(meaningItems.map((it) => it.note_index).join(',') === '3,4,5',
  '意味・本質問題は3問の後ろに続き番号で並ぶ',
  `note_index: ${meaningItems.map((it) => it.note_index)}`);
check(lastRequestBody?.generationConfig?.responseMimeType === 'application/json'
  && JSON.stringify(lastRequestBody?.generationConfig?.responseSchema) === JSON.stringify(RESPONSE_SCHEMA),
  '応答の構造を共有スキーマで指定している(長い応答でJSONが壊れないように)',
  `generationConfig: ${JSON.stringify(lastRequestBody?.generationConfig).slice(0, 200)}`);
{
  const [otherwise, deny, would] = meaningItems;
  // 正解の文はどこに並べ替えられても、解答の記号と選択肢の記号が一致する。
  const labelOf = (item, text) => {
    const m = item.choices.match(/<div class="choice">\((\w)\) ([^<]*)<\/div>/g) || [];
    for (const div of m) {
      const [, label, body] = div.match(/\((\w)\) ([^<]*)</);
      if (body === text) return label;
    }
    return '';
  };
  const otherwiseLabel = labelOf(otherwise, 'その指示された内容とは別の方法・方向で');
  check(otherwiseLabel && otherwise.answer === `(${otherwiseLabel}) その指示された内容とは別の方法・方向で`,
    `並べ替え後も解答の記号が正解の選択肢と一致する(${otherwiseLabel})`,
    `解答と選択肢が食い違う: ${otherwise.answer} / ${otherwise.choices}`);
  check(!otherwise.whynot.includes(`(${otherwiseLabel})`),
    '誤答の理由に正解の記号が混ざらない',
    `whynot: ${otherwise.whynot}`);
  check(otherwise.example.includes('unless <b>otherwise</b> instructed') && otherwise.example_blank.includes('class="blank"'),
    '例文が問題文の英語を含めば採用され、穴埋めカードも作られる',
    `example: ${otherwise.example}`);
  check(deny.example === '' && deny.example_blank === '',
    '問題文の英語を含まない例文は捨てる(誤った英文を覚えないように)',
    `example: ${deny.example}`);
  check(deny.whynot.includes('未来の計画を断るのは refuse。'),
    '誤答の理由のキー名が "text" でも読み替える',
    `whynot: ${deny.whynot}`);
  check(would.answer_ja === '' && would.why.includes('控えめ'),
    '日本語訳は空(解答が日本語のため)、Whyにはコアイメージが入る',
    `answer_ja: ${would.answer_ja} / why: ${would.why}`);
}

console.log(failures
  ? `\n❌ ${failures} 件の不一致があります。`
  : '\n✅ Grammar Multiの後処理(改行整形・正解記号・HTML化)はPython版と完全一致です。');
process.exit(failures ? 1 : 0);
