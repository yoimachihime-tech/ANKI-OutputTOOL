// guid.js
// ---------------------------------------------------------------------------
// Python の genanki.guid_for() と完全に同一の guid を生成する。
//
// 【なぜ一致させる必要があるか(最重要)】
// Anki は同じ guid のノートを「同一ノート」とみなし、再インポート時に
// 重複追加ではなく更新する。デスクトップ版(genanki)と Web 版で guid が
// 食い違うと、同じ単語のカードが二重に作られ、既存カードの学習履歴が
// 引き継がれなくなる。したがってこの実装は絶対に「だいたい同じ」で
// 済ませてはならない。
//
// 【アルゴリズム(genanki/util.py と同じ)】
//   1. 値を "__" で連結
//   2. UTF-8 で SHA-256 を取り、先頭 8 バイトをビッグエンディアンの整数に
//   3. Anki 独自の base91 テーブルで基数変換(余りを求めて逆順に並べる)
//
// Python 側との一致は tools/verify_web_parity.mjs で検証している。

const BASE91_TABLE = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's',
  't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
  'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '0', '1', '2', '3', '4',
  '5', '6', '7', '8', '9', '!', '#', '$', '%', '&', '(', ')', '*', '+', ',', '-', '.', '/', ':',
  ';', '<', '=', '>', '?', '@', '[', ']', '^', '_', '`', '{', '|', '}', '~',
];

/**
 * genanki.guid_for(*values) と同一の文字列を返す。
 * @param {...*} values 連結する値(文字列化される)
 * @returns {Promise<string>} base91 エンコードされた guid
 */
export async function guidFor(...values) {
  const hashStr = values.map((v) => String(v)).join('__');
  const bytes = new TextEncoder().encode(hashStr);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

  // 先頭 8 バイトをビッグエンディアンの整数として解釈する
  let hashInt = 0n;
  for (const b of digest.subarray(0, 8)) {
    hashInt = (hashInt << 8n) + BigInt(b);
  }

  const base = BigInt(BASE91_TABLE.length);
  const reversed = [];
  while (hashInt > 0n) {
    reversed.push(BASE91_TABLE[Number(hashInt % base)]);
    hashInt /= base;
  }
  return reversed.reverse().join('');
}

/**
 * card_def_builder.build_guid() と同一の guid を返す。
 * dedup_key で指定された項目の値を、前後空白除去 + 小文字化して使う。
 * @param {object} cardDef docs/shared/card_defs.json の 1 定義
 * @param {object} item 生成した item(フィールドの内部項目名をキーに持つ)
 */
export async function buildGuid(cardDef, item) {
  const raw = item[cardDef.dedup_key];
  const keyValue = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return guidFor(cardDef.key, keyValue);
}
