// tools/verify_web_parity.mjs
// ---------------------------------------------------------------------------
// Web版(docs/lib/apkg.js)が生成した .apkg が、デスクトップ版(genanki)の
// 出力と一致することを検証する。
//
// 【なぜ必要か】
// Anki は guid が同じノートを「同一ノート」とみなして更新する。Web版と
// デスクトップ版で guid やフィールドの並びが食い違うと、同じ単語のカードが
// 二重に作られ、既存カードの学習履歴が失われる。docs/ 側のコードを変更したら
// 必ずこの検証を通すこと。
//
// 【使い方】
//   cd tools && npm install && npm run verify
//
// 内部で python(tools/dump_python_apkg.py)を呼び、同じ items から
// デスクトップ版が作る apkg の中身を JSON で受け取って突き合わせる。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

// 検証に使う item。日本語・HTML タグ・空フィールド・記号を含め、
// エンコード周りのズレを検出できるようにしてある。
const ITEMS = [
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

function fail(message) {
  console.error(`\n❌ 不一致: ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

// ---------------------------------------------------------------------------

console.log('Web版とデスクトップ版(genanki)のapkg一致検証\n');

// --- 1. Python 側の出力を取得 ---
// 入出力とも UTF-8 を明示する(日本語Windowsでは既定が cp932 になり、
// items の日本語が壊れて Python 側が UnicodeEncodeError になるため)。
const pythonStdout = execFileSync(
  'python3',
  [join(HERE, 'dump_python_apkg.py')],
  {
    input: Buffer.from(JSON.stringify(ITEMS), 'utf8'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    maxBuffer: 64 * 1024 * 1024,
  },
);
const expected = JSON.parse(pythonStdout.toString('utf8'));

// --- 2. Web 版で apkg を生成し、SQLite を読み出す ---
const cardDef = readJson(join(DOCS, 'shared', 'card_defs.json')).defs.word;
const ankiSchema = readJson(join(DOCS, 'shared', 'anki_schema.json'));

const blob = await buildApkg({ cardDef, ankiSchema, items: ITEMS });
const zip = await globalThis.JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));

const entries = Object.keys(zip.files).sort();
console.log('[1] apkg の構成');
if (JSON.stringify(entries) === JSON.stringify(expected.entries.sort())) {
  ok(`エントリ一致: ${entries.join(', ')}`);
} else {
  fail(`エントリ: web=${entries} / python=${expected.entries}`);
}

const dbBytes = await zip.file('collection.anki2').async('nodebuffer');
const tmpDb = join(HERE, '.verify_tmp.anki2');
const { writeFileSync, unlinkSync } = await import('node:fs');
writeFileSync(tmpDb, dbBytes);

try {
  const db = new DatabaseSync(tmpDb);

  // --- 3. notes 行の比較 ---
  console.log('\n[2] notes 行(guid / フィールド / ソートフィールド)');
  const notes = db.prepare('SELECT guid, mid, tags, flds, sfld FROM notes ORDER BY id').all();
  if (notes.length !== expected.notes.length) {
    fail(`ノート件数: web=${notes.length} / python=${expected.notes.length}`);
  }
  notes.forEach((n, i) => {
    const e = expected.notes[i];
    const label = ITEMS[i].word;
    for (const key of ['guid', 'mid', 'tags', 'flds', 'sfld']) {
      if (String(n[key]) !== String(e[key])) {
        fail(`notes[${i}] (${label}) の ${key}: web=${JSON.stringify(n[key])} / python=${JSON.stringify(e[key])}`);
        return;
      }
    }
    ok(`${label}: guid=${n.guid} フィールド一致`);
  });

  // --- 4. cards 行の比較 ---
  console.log('\n[3] cards 行(テンプレート番号 / デッキ / 出題順)');
  const cards = db.prepare('SELECT nid, did, ord, due FROM cards ORDER BY id').all();
  if (cards.length !== expected.cards.length) {
    fail(`カード件数: web=${cards.length} / python=${expected.cards.length}`);
  } else {
    const webShape = cards.map((c) => `${c.ord}/${c.did}/${c.due}`).join(' ');
    const pyShape = expected.cards.map((c) => `${c.ord}/${c.did}/${c.due}`).join(' ');
    if (webShape === pyShape) {
      ok(`${cards.length} 枚のカードが一致 (ord/デッキ/due)`);
    } else {
      fail(`cards: web=[${webShape}] / python=[${pyShape}]`);
    }
  }

  // --- 5. col.models / col.decks の比較 ---
  console.log('\n[4] ノートタイプ・デッキ定義');
  const col = db.prepare('SELECT models, decks FROM col').get();
  const webModel = JSON.parse(col.models)[String(cardDef.model_id)];
  const pyModel = expected.model;

  // mod は「書き出した時刻」なので、Python 実行時と JS 実行時で必ず数秒ずれる。
  // 一致を求めるのは無意味なため比較対象から外し、代わりに「妥当な時刻が
  // 入っているか」だけを確認する(0 や undefined のまま出荷されるのを防ぐ)。
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(webModel.mod) || Math.abs(nowSec - webModel.mod) > 600) {
    fail(`models.mod に書き出し時刻が入っていません: ${webModel.mod}`);
  }
  const stripMod = (m) => JSON.stringify({ ...m, mod: null });
  if (stripMod(webModel) === stripMod(pyModel)) {
    ok(`ノートタイプ「${webModel.name}」が一致 (CSS・テンプレート・req 含む / mod は時刻のため除外)`);
  } else {
    for (const key of new Set([...Object.keys(webModel), ...Object.keys(pyModel)])) {
      if (key === 'mod') continue;
      if (JSON.stringify(webModel[key]) !== JSON.stringify(pyModel[key])) {
        fail(`models.${key} が不一致`);
      }
    }
  }

  const webDeck = JSON.parse(col.decks)[String(cardDef.deck_id)];
  if (JSON.stringify(webDeck) === JSON.stringify(expected.deck)) {
    ok(`デッキ「${webDeck.name}」が完全一致`);
  } else {
    fail(`decks: web=${JSON.stringify(webDeck)} / python=${JSON.stringify(expected.deck)}`);
  }

  db.close();
} finally {
  try { unlinkSync(tmpDb); } catch { /* 消せなくても検証結果には影響しない */ }
}

// --- 6. guid 単体(既知の値との突き合わせ) ---
console.log('\n[5] guid アルゴリズム単体');
for (const [values, want] of Object.entries(expected.guid_cases)) {
  const got = await guidFor(...JSON.parse(values));
  if (got === want) ok(`guid_for(${values}) = ${got}`);
  else fail(`guid_for(${values}): web=${got} / python=${want}`);
}

console.log(
  process.exitCode
    ? '\n❌ 検証失敗: 上記の不一致を解消してください。'
    : '\n✅ すべて一致しました。Web版のapkgはデスクトップ版と互換です。',
);
