// tools/verify_grammar_multi_parity.mjs
// ---------------------------------------------------------------------------
// docs/lib/gemini.js の generateGrammarMultiItems() が、gemini_client.py の
// generate_grammar_multi_items_from_question() と同じ後処理結果(改行整形・
// 正解記号の付与・choice/whynot/exampleのHTML化)になることを検証する。
//
// Gemini の生の応答は同一の固定 JSON を使い(API は呼ばない)、両者に
// 同じ後処理をかけて item を突き合わせる。

import { execFileSync } from 'node:child_process';
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
    correct_opt: '',
    examples: [],
    why: '逆接の接続詞butで2文を結びます。',
    whynot: [],
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
question = raw['question']
notes = raw['notes']
batch_key = raw['batch_key']
topic_key = " ".join(question.strip().casefold().split())
items = []
for i, note in enumerate(notes):
    choices = note.get('choices') or []
    whynot = note.get('whynot') or []
    examples = [tuple(ex) for ex in note.get('examples', [])]
    items.append({
        'pattern': note.get('pattern', ''),
        'question': gc._format_question_html(note.get('question', '')),
        'choices': ''.join(
            gc._grammar_multi_canon.choice(c.get('opt', ''), c.get('text', '')) for c in choices
        ),
        'answer': gc._prefix_answer_with_correct_opt(
            note.get('answer', ''), choices, note.get('correct_opt', '')
        ),
        'example': gc._grammar_multi_canon.example_en(examples) if examples else '',
        'example_ja': gc._grammar_multi_canon.example_ja(examples) if examples else '',
        'example_blank': gc._grammar_multi_canon.example_blank(examples) if examples else '',
        # 2026-08-29追加。「3. 理由想起」の表に出す正解文。answerと違い
        # **正解の選択肢ラベル「(A) 」を付けない**(1問目のフィクスチャは
        # answer='patience' / correct_opt='B' なので、answer='(B) patience'
        # に対し answer_plain='patience' となり、両者の違いが固定される)。
        'answer_plain': note.get('answer', ''),
        'why': note.get('why', ''),
        'whynot': ''.join(
            gc._grammar_multi_canon.whynot_item(w.get('opt', ''), w.get('reason', '')) for w in whynot
        ),
        'topic_key': topic_key,
        'note_index': i,
        'batch_key': batch_key,
    })
json.dump(items, sys.stdout, ensure_ascii=False)
`],
  {
    input: Buffer.from(JSON.stringify({ question: QUESTION, notes: RAW_NOTES, batch_key: BATCH_KEY }), 'utf8'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    maxBuffer: 8 * 1024 * 1024,
  },
);
const expected = JSON.parse(pyStdout.toString('utf8'));

// --- Web版: 実際に generateGrammarMultiItems() を、fetch をモックして呼ぶ ---
globalThis.window = globalThis;
const { generateGrammarMultiItems } = await import(new URL('../docs/lib/gemini.js', import.meta.url));

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(RAW_NOTES) }] } }],
  }),
});

const promptTemplate = 'ダミープロンプト {{question}}'; // 実プロンプト全文は不要(整形処理だけを検証する)
const actual = await generateGrammarMultiItems({
  question: QUESTION,
  apiKey: 'DUMMY',
  model: 'gemini-2.0-flash',
  promptTemplate,
  batchKey: BATCH_KEY,
});

let failures = 0;
const FIELD_KEYS = ['pattern', 'question', 'choices', 'answer', 'answer_plain', 'example',
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

console.log(failures
  ? `\n❌ ${failures} 件の不一致があります。`
  : '\n✅ Grammar Multiの後処理(改行整形・正解記号・HTML化)はPython版と完全一致です。');
process.exit(failures ? 1 : 0);
