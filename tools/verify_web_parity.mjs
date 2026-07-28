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
// word(単語)・grammar_multi(AIに質問)の2種別。どちらもPython側の生成経路が
// 異なる(word: card_defs.json + card_def_builder / grammar_multi:
// grammar_multi_builder.build_deck())ため、それぞれ別個に突き合わせる。
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

/** Python側(dump_python_apkg.py --card-def <cardDefKey>)を呼んで正解データを取得する。 */
function dumpPython(cardDefKey, items) {
  // 入出力とも UTF-8 を明示する(日本語Windowsでは既定が cp932 になり、
  // items の日本語が壊れて Python 側が UnicodeEncodeError になるため)。
  const stdout = execFileSync(
    'python3',
    [join(HERE, 'dump_python_apkg.py'), '--card-def', cardDefKey],
    {
      input: Buffer.from(JSON.stringify(items), 'utf8'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout.toString('utf8'));
}

/** 1つのカード種別について、Web版とPython版のapkgを突き合わせる。 */
async function verifyCardDef(cardDefKey, items, labelOf) {
  console.log(`\n=== ${cardDefKey} ===`);
  const expected = dumpPython(cardDefKey, items);
  const cardDef = cardDefsAll[cardDefKey];

  const blob = await buildApkg({ cardDef, ankiSchema, items });
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
      const label = labelOf(items[i]);
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

// --- guid 単体(既知の値との突き合わせ。GUID_CASES は両方の呼び出しで共通) ---
console.log('\n=== guid アルゴリズム単体 ===');
for (const [values, want] of Object.entries({ ...wordGuidCases, ...grammarMultiGuidCases })) {
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
