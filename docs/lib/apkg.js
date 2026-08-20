// apkg.js
// ---------------------------------------------------------------------------
// ブラウザ上で Anki の .apkg を組み立てる。
//
// .apkg の実体は次を固めた zip:
//   - collection.anki2 : Anki の SQLite データベース(schema 11)
//   - media            : {"0": "実ファイル名", ...} という JSON の対応表
//   - 0, 1, 2, ...     : メディア本体(連番のファイル名で格納)
//
// 【デスクトップ版(genanki)と一致させるための方針】
// スキーマ SQL・col 行の既定値・ノートタイプ JSON は、いずれも
// tools/export_shared_card_defs.py が genanki から機械的に書き出した
// docs/shared/*.json をそのまま使う。JS 側で組み立て直すと genanki の更新に
// 追従できずズレるため、「Python 側が作った値を運ぶだけ」に徹する。
//
// 唯一 JS で再実装しているのが guid(guid.js)とカード生成条件(req)の判定で、
// どちらも tools/verify_web_parity.mjs で Python 版との一致を検証している。

import { buildItemGuid } from './guid.js';

const SQL_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';

let sqlJsPromise = null;

/** sql.js(SQLite の WebAssembly 版)を初期化する(初回のみ読み込む)。 */
function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = window.initSqlJs({ locateFile: (file) => SQL_JS_CDN + file });
  }
  return sqlJsPromise;
}

/**
 * genanki の Note._front_back_cards() と同じ条件で、生成するカードの
 * テンプレート番号(ord)を決める。
 *
 * model.req は [[card_ord, 'any'|'all', [必要なフィールドのord...]], ...] で、
 * 指定されたフィールドが any/all で非空ならそのカードを作る。
 *
 * @param {object} ankiModel col.models に入るノートタイプ JSON
 * @param {string[]} fields フィールド値の配列(ノートタイプの定義順)
 * @returns {number[]} 生成するカードの ord
 */
export function cardOrdsFor(ankiModel, fields) {
  const ords = [];
  for (const [cardOrd, anyOrAll, requiredOrds] of ankiModel.req || []) {
    const values = requiredOrds.map((i) => fields[i] || '');
    const ok = anyOrAll === 'all'
      ? values.every((v) => v !== '')
      : values.some((v) => v !== '');
    if (ok) ords.push(cardOrd);
  }
  return ords;
}

/**
 * カードの新規学習順(due)を、card_def.due_scheme(共有JSON)に従って計算する。
 * カード種別ごとにPython側の採番方法が異なるため、種類を分けてある:
 *   - sequence  : startDue からの通し番号(word/grammar_multi/daily)。
 *                 startDue は dueCounter.js が種別ごとに永続化している
 *                 「次の開始番号」で、出力のたびに件数分だけ進む。
 *   - field     : item内の特定フィールドの値をそのまま使う
 *                 (build_shuujuku_v1.build_deck()のdue=idx。Numフィールドと
 *                 同じ値になる。この値は出力時点で払い出される連番なので、
 *                 呼び出し側が事前にitemへ埋め込んでおく必要がある)
 *   - fixed_zero: 常に0。2026-08-20より前のwordの採番方法で、後方互換のため
 *                 残してあるだけ(現在どの定義もこの型を使っていない)。
 *   - index     : 0始まりのインデックス。同じく旧grammar_multi/dailyの
 *                 採番方法で、後方互換のためだけに残してある。
 *
 * 【sequenceを追加した理由(2026-08-20)】
 * fixed_zero/indexは出力のたびに0から振り直すため、別のバッチで出力した
 * カードがAnki側で同じ位置に並び、1つの質問から作った複数問がまとまって
 * 出題されずに他のカードと混ざっていた(片桐からの報告)。
 *
 * @param {object} dueScheme cardDef.due_scheme(`{"type": ...}`)。省略時はfixed_zero扱い
 * @param {object} item
 * @param {number} index itemsの中でのこのitemの位置(0始まり)
 * @param {number} [startDue=1] type="sequence"のときの開始番号
 */
export function dueFor(dueScheme, item, index, startDue = 1) {
  const type = dueScheme?.type || 'fixed_zero';
  if (type === 'sequence') return startDue + index;
  if (type === 'index') return index;
  if (type === 'field') {
    const n = Number(item[dueScheme.key]);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * ノートの tags 列の値を、genanki の Note.write_to_db() と同じ形式で作る
 * (`' ' + ' '.join(tags) + ' '`。タグが無い場合も `'  '` になる)。
 *
 * タグを持つのは今のところ DailyConversation(`source::gemini_dailyconv`、
 * build_grammar_dailyconv_v1_final.build_deck() が全ノートに付ける)だけで、
 * 他のカード種別は tags を持たない。カード種別ごとに JS 側で分岐させず、
 * guid_scheme/due_scheme と同じく共有 JSON 側(card_def.tags)に持たせている。
 */
export function tagsFieldFor(cardDef) {
  return ` ${(cardDef.tags || []).join(' ')} `;
}

/**
 * item(AI が生成した内容)を、ノートタイプの定義順に並べたフィールド配列にする。
 * card_def_builder.build_deck_from_def() と同じ変換。
 */
export function fieldsFromItem(cardDef, item) {
  return cardDef.fields.map((f) => {
    const v = item[f.item_key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * .apkg を組み立てて Blob で返す。
 *
 * @param {object}   opts
 * @param {object}   opts.cardDef     docs/shared/card_defs.json の 1 定義
 * @param {object}   opts.ankiSchema  docs/shared/anki_schema.json
 * @param {object[]} opts.items       出力する item の配列
 * @param {Map<string, Uint8Array>} [opts.media] メディア(ファイル名 → 中身)
 * @param {number}   [opts.startDue=1] due_scheme.type="sequence" のときの開始番号
 *   (dueCounter.getNextDue(キー) の値を呼び出し側から渡す)
 * @returns {Promise<Blob>}
 */
export async function buildApkg({ cardDef, ankiSchema, items, media, startDue = 1 }) {
  if (!items || items.length === 0) {
    throw new Error('出力するカードがありません。');
  }

  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.run(ankiSchema.schema_sql);
    db.run(ankiSchema.col_insert_sql);

    // --- デッキを col.decks へ追加(genanki Deck.to_json() と同じ形) ---
    const decks = JSON.parse(selectOne(db, 'SELECT decks FROM col'));
    decks[String(cardDef.deck_id)] = {
      collapsed: false,
      conf: 1,
      desc: '',
      dyn: 0,
      extendNew: 0,
      extendRev: 50,
      id: cardDef.deck_id,
      lrnToday: [163, 2],
      mod: 1425278051,
      name: cardDef.deck_name,
      newToday: [163, 2],
      revToday: [163, 0],
      timeToday: [163, 23598],
      usn: -1,
    };
    db.run('UPDATE col SET decks = ?', [JSON.stringify(decks)]);

    // genanki は id を「書き出し時刻(ミリ秒)からの連番」で採番する。
    const timestampMs = Date.now();
    const timestampSec = Math.floor(timestampMs / 1000);
    let nextId = timestampMs;

    // --- ノートタイプを col.models へ追加(Python が書き出したものをそのまま) ---
    // mod だけは genanki が書き出し時刻で埋める値なので、ここで入れ直す
    // (共有 JSON に固定値で持たせると、更新時刻が常に同じになってしまう)。
    const models = JSON.parse(selectOne(db, 'SELECT models FROM col'));
    models[String(cardDef.model_id)] = { ...cardDef.anki_model, mod: timestampSec };
    db.run('UPDATE col SET models = ?', [JSON.stringify(models)]);

    // --- ノートとカードを挿入 ---

    const sortFieldIndex = cardDef.anki_model.sortf || 0;
    const tagsField = tagsFieldFor(cardDef);

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const fields = fieldsFromItem(cardDef, item);
      const guid = await buildItemGuid(cardDef, item);
      const due = dueFor(cardDef.due_scheme, item, i, startDue);
      const noteId = nextId;
      nextId += 1;

      db.run('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?,?)', [
        noteId,                       // id
        guid,                         // guid
        cardDef.model_id,             // mid
        timestampSec,                 // mod
        -1,                           // usn
        tagsField,                    // tags(genanki: ' ' + join + ' ')
        fields.join('\x1f'),          // flds
        fields[sortFieldIndex] || '', // sfld
        0,                            // csum(Anki 側が再計算するので 0 でよい)
        0,                            // flags
        '',                           // data
      ]);

      for (const ord of cardOrdsFor(cardDef.anki_model, fields)) {
        db.run('INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
          nextId,           // id
          noteId,           // nid
          cardDef.deck_id,  // did
          ord,              // ord
          timestampSec,     // mod
          -1,               // usn
          0,                // type
          0,                // queue
          due,              // due(card_def.due_schemeに従う。dueFor()参照)
          0, 0, 0, 0, 0, 0, 0, 0, // ivl factor reps lapses left odue odid flags
          '',               // data
        ]);
        nextId += 1;
      }
    }

    const dbBytes = db.export();
    return await zipApkg(dbBytes, media);
  } finally {
    db.close();
  }
}

function selectOne(db, sql) {
  const stmt = db.prepare(sql);
  try {
    stmt.step();
    return stmt.get()[0];
  } finally {
    stmt.free();
  }
}

/** collection.anki2 とメディアを zip に固めて Blob を返す。 */
async function zipApkg(dbBytes, media) {
  const zip = new window.JSZip();
  zip.file('collection.anki2', dbBytes);

  // media は「連番のファイル名 → 実際のファイル名」の対応表。
  // メディアが無くても空の JSON を必ず入れる(Anki が読みに行くため)。
  const mediaMap = {};
  if (media && media.size > 0) {
    let index = 0;
    for (const [filename, bytes] of media) {
      mediaMap[String(index)] = filename;
      zip.file(String(index), bytes);
      index += 1;
    }
  }
  zip.file('media', JSON.stringify(mediaMap));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
