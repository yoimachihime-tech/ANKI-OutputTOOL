// tools/verify_web_parity.mjs
// ---------------------------------------------------------------------------
// Web版(docs/lib/apkg.js)が生成した .apkg が、デスクトップ版(genanki)の
// 出力と一致することを検証する。
//
// 【なぜ必要か】
// Anki は guid が同じノートを「同一ノート」とみなして更新する。Web版と
// デスクトップ版で guid やフィールドの並びが食い違うと、同じカードが
// 二重に作られ、既存カードの学習履歴が失われる。docs/ 側のコードを変更したら
// 必ずこの検証を通すこと。
//
// 【対象】
// word(単語)・grammar_multi(AIに質問)・shuujuku(習熟用/音読)・
// daily(DailyConversation)の4種別。いずれもPython側の生成経路が異なる
// (word: card_defs.json + card_def_builder / grammar_multi:
// grammar_multi_builder.build_deck() / shuujuku: build_shuujuku_v1.build_deck() /
// daily: deck_builder.build_deck_and_row_map())ため、それぞれ別個に突き合わせる。
//
// 【使い方】
//   cd tools && npm install && npm run verify
//
// 内部で python(tools/dump_python_apkg.py --card-def <key>)を呼び、同じ
// items からデスクトップ版が作る apkg の中身を JSON で受け取って突き合わせる。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DOCS = join(ROOT, 'docs');

// docs/lib/*.js はブラウザ用に window.initSqlJs / window.JSZip を参照するため、
// Node で読み込む前に同名のグローバルを用意しておく(本番と同じコードを
// そのまま検証するための最小限のシム)。
globalThis.window = globalThis;
globalThis.initSqlJs = require('sql.js');
globalThis.JSZip = require('jszip');

const { buildApkg } = await import(new URL('../docs/lib/apkg.js', import.meta.url));
const { guidFor } = await import(new URL('../docs/lib/guid.js', import.meta.url));
const { buildFieldsReadyItems } = await import(new URL('../docs/lib/shuujuku.js', import.meta.url));
const dailyconv = await import(new URL('../docs/lib/dailyconv.js', import.meta.url));

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const cardDefsAll = readJson(join(DOCS, 'shared', 'card_defs.json')).defs;
const ankiSchema = readJson(join(DOCS, 'shared', 'anki_schema.json'));

let hadFailure = false;
function fail(message) {
  console.error(`  ❌ 不一致: ${message}`);
  hadFailure = true;
}
function ok(message) {
  console.log(`  ✅ ${message}`);
}

// cards.due(新規カードの位置)の開始番号。**1以外の値**にしてあるのは、
// 「開始番号 + 並び順」という採番式そのものがPython版とWeb版で一致することを
// 確かめるため(1のままだと、片方が0始まりのインデックスに戻っても
// 気づけない場合がある。2026-08-20追加)。
const PARITY_START_DUE = 500;

/** Python側(dump_python_apkg.py --card-def <cardDefKey>)を呼んで正解データを取得する。 */
function dumpPython(cardDefKey, items) {
  // 入出力とも UTF-8 を明示する(日本語Windowsでは既定が cp932 になり、
  // items の日本語が壊れて Python 側が UnicodeEncodeError になるため)。
  const stdout = execFileSync(
    'python3',
    [
      join(HERE, 'dump_python_apkg.py'),
      '--card-def', cardDefKey,
      '--start-num', String(PARITY_START_DUE),
    ],
    {
      input: Buffer.from(JSON.stringify(items), 'utf8'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout.toString('utf8'));
}

/**
 * 1つのカード種別について、Web版とPython版のapkgを突き合わせる。
 *
 * @param {string} cardDefKey
 * @param {object[]} items Python側(dump_python_apkg.py)に渡す形のitems
 * @param {(item: object) => string} labelOf
 * @param {object[]} [webItems] Web版のbuildApkg()に渡すitemsが`items`と異なる
 *   場合に指定する(shuujuku: Content/Numを出力時点で確定させるため、
 *   Python側はsource_key付きの生item、Web側はbuildFieldsReadyItems()済みの
 *   item、と形が異なるため)。省略時は`items`をそのまま両方に使う。
 * @param {object[]} [labelItems] labelOf に渡す配列。**ノートの並び順と1対1で
 *   対応していること**。daily はPython側へ渡すのが除外前の生の行なので、
 *   ノート i と items[i] が一致しない(除外後の行を明示的に渡す必要がある)。
 *   省略時は`items`を使う。
 */
async function verifyCardDef(cardDefKey, items, labelOf, webItems, labelItems) {
  const labelSource = labelItems || items;
  console.log(`\n=== ${cardDefKey} ===`);
  const expected = dumpPython(cardDefKey, items);
  const cardDef = cardDefsAll[cardDefKey];

  const blob = await buildApkg({
    cardDef, ankiSchema, items: webItems || items, startDue: PARITY_START_DUE,
  });
  const zip = await globalThis.JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));

  const entries = Object.keys(zip.files).sort();
  if (JSON.stringify(entries) === JSON.stringify(expected.entries.sort())) {
    ok(`[apkgの構成] エントリ一致: ${entries.join(', ')}`);
  } else {
    fail(`[apkgの構成] web=${entries} / python=${expected.entries}`);
  }

  const dbBytes = await zip.file('collection.anki2').async('nodebuffer');
  const tmpDb = join(HERE, `.verify_tmp_${cardDefKey}.anki2`);
  writeFileSync(tmpDb, dbBytes);

  try {
    const db = new DatabaseSync(tmpDb);

    const notes = db.prepare('SELECT guid, mid, tags, flds, sfld FROM notes ORDER BY id').all();
    if (notes.length !== expected.notes.length) {
      fail(`[notes] 件数: web=${notes.length} / python=${expected.notes.length}`);
    }
    notes.forEach((n, i) => {
      const e = expected.notes[i];
      const label = labelOf(labelSource[i]);
      for (const key of ['guid', 'mid', 'tags', 'flds', 'sfld']) {
        if (String(n[key]) !== String(e[key])) {
          fail(`[notes] [${i}] (${label}) の ${key}: web=${JSON.stringify(n[key])} / python=${JSON.stringify(e[key])}`);
          return;
        }
      }
      ok(`[notes] ${label}: guid=${n.guid} フィールド一致`);
    });

    const cards = db.prepare('SELECT nid, did, ord, due FROM cards ORDER BY id').all();
    if (cards.length !== expected.cards.length) {
      fail(`[cards] 件数: web=${cards.length} / python=${expected.cards.length}`);
    } else {
      const webShape = cards.map((c) => `${c.ord}/${c.did}/${c.due}`).join(' ');
      const pyShape = expected.cards.map((c) => `${c.ord}/${c.did}/${c.due}`).join(' ');
      if (webShape === pyShape) {
        ok(`[cards] ${cards.length} 枚のカードが一致 (ord/デッキ/due)`);
      } else {
        fail(`[cards] web=[${webShape}] / python=[${pyShape}]`);
      }
    }

    const col = db.prepare('SELECT models, decks FROM col').get();
    const webModel = JSON.parse(col.models)[String(cardDef.model_id)];
    const pyModel = expected.model;

    // mod は「書き出した時刻」なので、Python 実行時と JS 実行時で必ず数秒ずれる。
    // 一致を求めるのは無意味なため比較対象から外し、代わりに「妥当な時刻が
    // 入っているか」だけを確認する(0 や undefined のまま出荷されるのを防ぐ)。
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(webModel.mod) || Math.abs(nowSec - webModel.mod) > 600) {
      fail(`[model] models.mod に書き出し時刻が入っていません: ${webModel.mod}`);
    }
    const stripMod = (m) => JSON.stringify({ ...m, mod: null });
    if (stripMod(webModel) === stripMod(pyModel)) {
      ok(`[model] ノートタイプ「${webModel.name}」が一致 (CSS・テンプレート・req 含む / modは時刻のため除外)`);
    } else {
      for (const key of new Set([...Object.keys(webModel), ...Object.keys(pyModel)])) {
        if (key === 'mod') continue;
        if (JSON.stringify(webModel[key]) !== JSON.stringify(pyModel[key])) {
          fail(`[model] models.${key} が不一致`);
        }
      }
    }

    const webDeck = JSON.parse(col.decks)[String(cardDef.deck_id)];
    if (JSON.stringify(webDeck) === JSON.stringify(expected.deck)) {
      ok(`[deck] 「${webDeck.name}」が完全一致`);
    } else {
      fail(`[deck] web=${JSON.stringify(webDeck)} / python=${JSON.stringify(expected.deck)}`);
    }

    db.close();
  } finally {
    try { unlinkSync(tmpDb); } catch { /* 消せなくても検証結果には影響しない */ }
  }

  return expected.guid_cases;
}

// ---------------------------------------------------------------------------

console.log('Web版とデスクトップ版(genanki)のapkg一致検証');

// 検証に使う item。日本語・HTML タグ・空フィールド・記号を含め、
// エンコード周りのズレを検出できるようにしてある。
const WORD_ITEMS = [
  {
    word: 'slated',
    reading: '/<b>ˈsleɪ</b>tɪd/',
    pos: 'adj. (Past Participle)',
    meaning: '予定されている',
    example: 'The update is <b>slated</b> for release.',
    example_ja: 'その更新は公開が予定されている。',
    example_blank: 'The update is ------- for release.',
    note: '【語源】slate に由来する。<br>丁寧な語感。',
  },
  {
    word: 'Resilient',   // 大文字混じり: guid は小文字化されるはず
    reading: '/rɪˈzɪliənt/',
    pos: 'adj.',
    meaning: '回復力のある',
    example: 'She is <b>resilient</b>.',
    example_ja: '彼女は打たれ強い。',
    example_blank: 'She is -------.',
    note: '',                       // 空フィールド
  },
  {
    word: 'give up',                // 空白入りの句動詞
    reading: '/ɡɪv ʌp/',
    pos: 'phrasal verb',
    meaning: '諦める',
    example: "Don't <b>give up</b>.",
    example_ja: '諦めるな。',
    example_blank: "Don't -------.",
    note: '分離可能な句動詞。',
  },
];

// choices/whynot が空の問題(誤り訂正/記述式)と、非空の問題(選択問題)を
// 両方含める(cardOrdsForのreq判定・guidの複合キー・空フィールドの扱いを
// 一通り確認するため)。
const GRAMMAR_MULTI_ITEMS = [
  {
    pattern: '選択問題',
    question: '空所に最も適切な語を選びなさい。<br><br>\'She showed great ___.\'',
    choices: '<div class="choice">(A) patient</div><div class="choice">(B) patience</div>',
    answer: '(B) patience',
    example: '<span class="ex-num">Ex1.</span> She has patience.',
    example_ja: '└ 彼女には忍耐力がある。',
    why: '空所には名詞が入ります。',
    whynot: '<div class="whynot-item"><span class="opt">(A)</span> patient は形容詞。</div>',
    topic_key: 'patience と patient の使い分け',
    note_index: 0,
  },
  {
    pattern: '誤り訂正問題',
    question: "次の英文を訂正してください。<br><br>'I go to school yesterday.'",
    choices: '',
    answer: 'I went to school yesterday.',
    example: '',
    example_ja: '',
    why: '過去の出来事なので過去形にします。',
    whynot: '',
    topic_key: 'patience と patient の使い分け',
    note_index: 1,
  },
];

const wordGuidCases = await verifyCardDef('word', WORD_ITEMS, (item) => item.word);
const grammarMultiGuidCases = await verifyCardDef(
  'grammar_multi',
  GRAMMAR_MULTI_ITEMS,
  (item) => `[${item.pattern}] note_index=${item.note_index}`,
);

// 習熟用(shuujuku): Content/Numは出力時点(buildFieldsReadyItems/
// build_shuujuku_v1.build_deckのstart_num)で確定するため、Web側の生item
// (source_kind/source_topicがフラット)とPython側の生item(source_keyが
// [kind, topic]の2要素)は形が異なる。どちらも同じ論理内容を表すよう変換する。
// meaning/expl/source_labelがNone(JS側はnull)のケースも1件混ぜて、
// render_item()側の「値が無ければブロックごと省略する」分岐を検証する。
const SHUUJUKU_RAW_ITEMS = [
  {
    pattern: "She doesn't <mark>動詞</mark>のようにHTMLタグを含む場合",
    meaning: '三人称単数の否定文(<u>形容詞</u>等のプレースホルダーを含む)',
    examples: [
      ["She doesn't like coffee.", '彼女はコーヒーが好きではない。'],
      ["He doesn't play tennis on Sundays.", '彼は日曜日にテニスをしない。', ['play', 'Sundays']],
    ],
    expl: '三人称単数の否定は doesn\'t を使う。',
    source_kind: 'chat',
    source_topic: 'discussの使い方',
    source_label: '由来: AIに質問',
  },
  {
    pattern: 'I 動詞ed yesterday',
    meaning: null,   // meaningが無いケース(gloss-line省略の分岐)
    examples: [['I went to school yesterday.', '私は昨日学校へ行った。']],
    expl: null,       // explが無いケース(expl-box省略の分岐)
    source_kind: 'dailyconv',
    source_topic: '59cb55d3-d794-4ae8-8813-c1268807b0f7',
    source_label: null, // source_labelが無いケース(source-tag省略の分岐)
  },
];
const shuujukuPyItems = SHUUJUKU_RAW_ITEMS.map(({ source_kind, source_topic, ...rest }) => ({
  ...rest,
  source_key: [source_kind, source_topic],
}));
const shuujukuWebItems = buildFieldsReadyItems(SHUUJUKU_RAW_ITEMS, 1);
const shuujukuGuidCases = await verifyCardDef(
  'shuujuku',
  shuujukuPyItems,
  (item) => item.source_key.join('::'),
  shuujukuWebItems,
);

// DailyConversation(daily): Python側へ渡すのは「添削結果」シートの**生の行**で、
// カテゴリ「誤りなし」の除外・ID重複の除去(process_sheet_rows)もPython側が行う。
// Web側は同等の処理を dailyconv.processSheetRows() が担当するため、
// 「両者が同じ行を同じ順序で残すか」もここで一緒に検証されることになる。
// スコアが全て入っている行/欠けている行、類似表現が空の行、除外対象の行を
// 一通り混ぜてある。
const DAILY_RAW_ROWS = [
  {
    id: '59cb55d3-d794-4ae8-8813-c1268807b0f7',
    original: 'I go to the park yesterday.',
    corrected: 'I went to the park yesterday.',
    explanation: '過去の出来事なので動詞は過去形 <b>went</b> にします。',
    category: '文法',
    similar_en_list: ['I visited the park yesterday.', 'I headed to the park yesterday.'],
    similar_ja_list: ['visit は「訪れる」の意味で少し硬い。', 'head to は「向かう」に近い。'],
    grammar_score: 60,
    naturalness_score: 70,
    comprehensibility_score: 90,
    score_comment: '時制の誤りが1点、意味は十分に伝わります。',
  },
  {
    // スコア列が空欄(sheets_reader が None を返す)→ Score フィールドは空になる
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    original: "She don't like coffee.",
    corrected: "She doesn't like coffee.",
    explanation: '三人称単数の否定は <b>doesn\'t</b> を使います。',
    category: '語彙',
    similar_en_list: [],   // 類似表現なし(Example/ExampleJA が空)
    similar_ja_list: [],
    grammar_score: null,
    naturalness_score: null,
    comprehensibility_score: null,
    score_comment: '',
  },
  {
    // カテゴリ「誤りなし」→ 両実装とも出力対象から除外するはず
    id: 'a1b2c3d4-0000-4000-8000-000000000002',
    original: 'This sentence is perfectly fine.',
    corrected: 'This sentence is perfectly fine.',
    explanation: '誤りはありません。',
    category: '誤りなし',
    similar_en_list: [],
    similar_ja_list: [],
    grammar_score: 100,
    naturalness_score: 100,
    comprehensibility_score: 100,
    score_comment: '問題ありません。',
  },
  {
    // 1件目とID重複 → 両実装とも先に出現した方だけを残すはず
    id: '59cb55d3-d794-4ae8-8813-c1268807b0f7',
    original: 'duplicated row',
    corrected: 'duplicated row',
    explanation: '',
    category: '自然さ',
    similar_en_list: [],
    similar_ja_list: [],
    grammar_score: null,
    naturalness_score: null,
    comprehensibility_score: null,
    score_comment: '',
  },
];
const { rows: dailyDeckRows, duplicateIds: dailyDuplicateIds } = dailyconv.processSheetRows(DAILY_RAW_ROWS);
console.log(
  `\n(daily) processSheetRows: ${DAILY_RAW_ROWS.length} 行 → ${dailyDeckRows.length} 行`
  + `(ID重複で除外: ${dailyDuplicateIds.length} 件)`,
);
const dailyGuidCases = await verifyCardDef(
  'daily',
  DAILY_RAW_ROWS,
  (row) => `${row.category} / ${row.id.slice(0, 8)}`,
  dailyconv.buildFieldsReadyItems(dailyDeckRows),
  dailyDeckRows,
);

// --- guid 単体(既知の値との突き合わせ。GUID_CASES は両方の呼び出しで共通) ---
console.log('\n=== guid アルゴリズム単体 ===');
for (const [values, want] of Object.entries({
  ...wordGuidCases, ...grammarMultiGuidCases, ...shuujukuGuidCases, ...dailyGuidCases,
})) {
  const got = await guidFor(...JSON.parse(values));
  if (got === want) ok(`guid_for(${values}) = ${got}`);
  else fail(`guid_for(${values}): web=${got} / python=${want}`);
}

console.log(
  hadFailure
    ? '\n❌ 検証失敗: 上記の不一致を解消してください。'
    : '\n✅ すべて一致しました。Web版のapkgはデスクトップ版と互換です。',
);
process.exitCode = hadFailure ? 1 : 0;
