// shuujuku.js
// ---------------------------------------------------------------------------
// 「習熟用(音読)」カードの Content フィールド組み立てと、Num フィールドの
// 続き番号管理。build_shuujuku_v1.py の render_item() / build_guid() /
// build_deck() と、shuujuku_stock.get_next_num() / advance_next_num() に
// 対応する Web 版。
//
// 【他のカード種別との違い(重要)】
// word・grammar_multi は「生成した瞬間の値」がそのままAnkiフィールド値に
// なるが、習熟用は違う。Content フィールドは pattern/meaning/examples/expl/
// source_label を HTML に合成した結果で、しかも合成には出力時点で払い出す
// 連番(Num)が必要になる。そのため、ストックに貯める item は生の
// pattern/meaning/examples/... のままにしておき、実際に .apkg を書き出す
// 直前に buildFieldsReadyItem() で Num/Content を確定させる
// (docs/app.js の onExportShuujuku を参照)。

const NEXT_NUM_KEY = 'anki_tool_shuujuku_next_num';

// build_shuujuku_v1.PLACEHOLDER_TOKENS と同一(順序も含めて一致させること。
// 先に出現するトークンほど優先してマッチする)。
const PLACEHOLDER_TOKENS = ['動詞/代名詞', '否定文', '形容詞', '代名詞', '主語', '動詞', '名詞', '時制', '数'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PLACEHOLDER_RE = new RegExp(
  `(${PLACEHOLDER_TOKENS.map(escapeRegExp).join('|')}|\\bX\\b|\\bY\\b)`,
  'g',
);

/** html.escape(s, quote=False) と同じ(&・<・> のみエスケープ、引用符はそのまま)。 */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markPlaceholders(textEscaped) {
  return textEscaped.replace(PLACEHOLDER_RE, (m) => `<u>${m}</u>`);
}

function markPattern(textEscaped) {
  return textEscaped.replace(PLACEHOLDER_RE, (m) => `<mark>${m}</mark>`);
}

/** highlight_example_en() と同じ: 各語を1回だけ(大小文字無視で)<mark>で囲む。 */
function highlightExampleEn(enText, hlWords) {
  let out = esc(enText);
  if (!hlWords || hlWords.length === 0) return out;
  for (let w of hlWords) {
    w = w.trim();
    w = w.replace(/^,+/, '').replace(/,+$/, '').trim();
    if (!w) continue;
    const pat = new RegExp(escapeRegExp(esc(w)), 'i'); // gを付けない = 最初の1件だけ(Pythonのcount=1と同じ)
    out = out.replace(pat, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

/**
 * render_item(item_num, item) と同一のHTMLを返す(Numのdeck-title行は含まない。
 * buildContentHtml()側で付与する)。
 *
 * @param {string[]|null} exampleAudioTags 例文ごとの`[sound:...]`タグ(2026-07-28
 *   TTS埋め込み追加時に追加)。渡すとitem.examplesと同じ順序でex-en divの内側
 *   (英文の直後)に`<br>`区切りで挿入する。tts_core.
 *   generate_shuujuku_sentence_tts_for_collection()の
 *   `<div class="ex-en">{inner_html}<br>[sound:{stored_name}]</div>`と同じ位置。
 *   要素が空文字/未指定の例文には何も挿入しない。省略時(null)は従来どおり
 *   音声無し(この関数の呼び出し元を増やしても既存の呼び出しは無変更で動く)。
 */
function renderItem(itemNum, item, exampleAudioTags = null) {
  const numStr = String(itemNum).padStart(3, '0');
  const patternHtml = markPattern(esc(item.pattern));
  const glossHtml = item.meaning ? markPlaceholders(esc(item.meaning)) : '';
  const exHtml = (item.examples || []).map((ex, i) => {
    const [en, jp, hlWords] = ex;
    const enHtml = highlightExampleEn(en, hlWords);
    const audioTag = exampleAudioTags ? (exampleAudioTags[i] || '') : '';
    const enWithAudio = audioTag ? `${enHtml}<br>${audioTag}` : enHtml;
    return `<div class="ex-row"><div class="ex-en">${enWithAudio}</div><div class="ex-jp">${esc(jp)}</div></div>`;
  }).join('');
  const explBlock = item.expl
    ? `<div class="expl-box"><div class="expl-label">解説</div>${esc(item.expl)}</div>`
    : '';
  const glossBlock = glossHtml ? `<div class="gloss-line">${glossHtml}</div>` : '';
  const sourceBlock = item.source_label
    ? `<div class="source-tag">${esc(item.source_label)}</div>`
    : '';
  return `<div class="item-card"><div class="item-head">`
    + `<span class="item-num">${numStr}</span>`
    + `<span class="pattern-line">${patternHtml}</span></div>`
    + `${glossBlock}${exHtml}${explBlock}${sourceBlock}</div>`;
}

/** build_deck() 内の content 組み立てと同一(deck-title行 + render_item)。 */
export function buildContentHtml(itemNum, item, deckTitleLabel = '習熟用', exampleAudioTags = null) {
  const numStr = String(itemNum).padStart(3, '0');
  return `<div class="deck-title">${esc(deckTitleLabel)} &nbsp;No.${numStr}</div>`
    + renderItem(itemNum, item, exampleAudioTags);
}

/**
 * ストックの生item(pattern/meaning/examples/expl/source_kind/source_topic/
 * source_label)を、apkg出力用の「Num/Content確定済みitem」に変換する。
 * guid計算に必要な source_kind/source_topic は変換後もそのまま保持する
 * (docs/lib/guid.js の compound スキームが参照するため)。
 *
 * @param {object[]} items ストックの生item配列
 * @param {number} startNum 開始番号(getNextNum()で取得した値を渡す)
 * @param {string[][]|null} audioTagsByItem itemsと同じ順序・同じ長さの配列で、
 *   各要素はその item の examples に対応する audio tag 配列(renderItem()の
 *   exampleAudioTagsにそのまま渡す。2026-07-28 TTS埋め込み追加時に追加)。
 *   省略時(null)は従来どおり音声無し。
 * @returns {object[]} { num, content, source_kind, source_topic } の配列
 */
export function buildFieldsReadyItems(items, startNum, audioTagsByItem = null) {
  return items.map((item, offset) => {
    const idx = startNum + offset;
    const tags = audioTagsByItem ? audioTagsByItem[offset] : null;
    return {
      ...item,
      num: String(idx).padStart(3, '0'),
      content: buildContentHtml(idx, item, '習熟用', tags),
    };
  });
}

// ---------------------------------------------------------------------------
// Numフィールドの続き番号(shuujuku_stock.get_next_num/advance_next_numのWeb版)
// ---------------------------------------------------------------------------
//
// build_shuujuku_v1.build_deck()は呼び出しのたびに1から採番するだけなので、
// 「出力するたびに続き番号を払い出す」責務はこちら側が持つ。デスクトップ版と
// 違い、Web版はこれが初回導入なので「既存の出力実績から安全な初期値を推定する」
// 移行ロジックは不要(常に1から始めればよい)。

/** 次に払い出すNumフィールドの開始番号を返す(未設定なら1)。 */
export function getNextNum() {
  const raw = localStorage.getItem(NEXT_NUM_KEY);
  const n = raw ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 開始番号をcount件分進める。apkg出力が実際に成功した後に呼ぶこと。 */
export function advanceNextNum(count) {
  if (!(count > 0)) return;
  const next = getNextNum() + count;
  localStorage.setItem(NEXT_NUM_KEY, String(next));
}
