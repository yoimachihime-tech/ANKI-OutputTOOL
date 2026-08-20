// shuujuku.js
// ---------------------------------------------------------------------------
// 「習熟用(音読)」カードのフィールド組み立てと、Num フィールドの続き番号管理。
// build_shuujuku_v1.py の build_fields_dict() / build_deck() と、
// shuujuku_stock.get_next_num() / advance_next_num() に対応する Web 版。
//
// 【他のカード種別との違い(重要)】
// word・grammar_multi は「生成した瞬間の値」がそのままAnkiフィールド値に
// なるが、習熟用は違う。ストックに貯める item は pattern/meaning/examples/
// expl/source_label という生の内容で、Ankiのフィールド(DeckTitle/Num/
// I1PatternEN/…)とは1対1に対応しない。しかも DeckTitle/Num/I1Badge は
// 出力時点で払い出す連番(Num)が無いと決まらない。そのため、実際に .apkg を
// 書き出す直前に buildFieldsReadyItems() でフィールドを確定させる
// (docs/app.js の onExportShuujuku を参照)。
//
// 【v2(2026-08-20): 1文=1フィールド化】
// v1は Num/Content の2フィールドで、Content に英文・和訳・意味・解説・出典を
// HTMLで詰め込んでいた。v2では「ATSU表現・構文120選 (音読用・TTS対応)」と
// 同じ1文=1フィールドの様式にしたため、この Content 合成が無くなり、
// 各フィールドの値を組み立てるだけになった。フィールド名・item_key の
// 並びは build_shuujuku_v1.FIELD_ITEM_KEYS が正典
// (docs/shared/card_defs.json 側にも同じ並びが書き出されている)。

const NEXT_NUM_KEY = 'anki_tool_shuujuku_next_num';

/** build_shuujuku_v1.MAX_EXAMPLES と同じ値にすること。 */
export const MAX_EXAMPLES = 4;

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
 * build_shuujuku_v1.build_fields_dict() と同一の「フィールド確定済み値」を返す。
 * 返すのはAnkiフィールド名ではなく item_key をキーにした dict
 * (docs/shared/card_defs.json の fields[].item_key と対応)。
 *
 * @param {number} itemNum 出力時に払い出す連番(Num/I1Badgeになる)
 * @param {object} item ストックの生item
 * @param {string} deckTitleLabel DeckTitleフィールドの値
 * @param {string[]|null} exampleAudioTags 例文ごとの`[sound:...]`タグ。渡すと
 *   item.examplesと同じ順序で、対応する英文フィールドの末尾に`<br>`区切りで
 *   追記する(tts_core.generate_tts_for_collection()が通常のフィールドに対して
 *   行うのと同じ「フィールド末尾に追記」の形)。省略時(null)は音声無し。
 */
export function buildFieldsReadyItem(itemNum, item, deckTitleLabel = '習熟用', exampleAudioTags = null) {
  const numStr = String(itemNum).padStart(3, '0');
  const values = {
    deck_title: esc(deckTitleLabel),
    num: numStr,
    badge: numStr,
    pattern_en: markPattern(esc(item.pattern)),
    pattern_jp: item.meaning ? markPlaceholders(esc(item.meaning)) : '',
    tip: item.expl ? esc(item.expl) : '',
    source: item.source_label ? esc(item.source_label) : '',
    // 通し音声(HyperTTS等で後から付ける前提)。このツールからは埋めない。
    all_audio: '',
  };
  const examples = item.examples || [];
  for (let n = 1; n <= MAX_EXAMPLES; n += 1) {
    const i = n - 1;
    if (i < examples.length) {
      const [en, jp, hlWords] = examples[i];
      const enHtml = highlightExampleEn(en, hlWords);
      const tag = exampleAudioTags ? (exampleAudioTags[i] || '') : '';
      values[`ex${n}_en`] = tag ? `${enHtml}<br>${tag}` : enHtml;
      values[`ex${n}_jp`] = esc(jp);
    } else {
      values[`ex${n}_en`] = '';
      values[`ex${n}_jp`] = '';
    }
  }
  return values;
}

/**
 * ストックの生item(pattern/meaning/examples/expl/source_kind/source_topic/
 * source_label)を、apkg出力用の「フィールド確定済みitem」に変換する。
 * guid計算に必要な source_kind/source_topic は変換後もそのまま保持する
 * (docs/lib/guid.js の compound スキームが参照するため)。
 *
 * @param {object[]} items ストックの生item配列
 * @param {number} startNum 開始番号(getNextNum()で取得した値を渡す)
 * @param {string[][]|null} audioTagsByItem itemsと同じ順序・同じ長さの配列で、
 *   各要素はその item の examples に対応する audio tag 配列
 *   (buildFieldsReadyItem()のexampleAudioTagsにそのまま渡す)。
 *   省略時(null)は従来どおり音声無し。
 * @returns {object[]} 生itemのキー + フィールド確定済みの値
 */
export function buildFieldsReadyItems(items, startNum, audioTagsByItem = null) {
  return items.map((item, offset) => {
    const tags = audioTagsByItem ? audioTagsByItem[offset] : null;
    return {
      ...item,
      ...buildFieldsReadyItem(startNum + offset, item, '習熟用', tags),
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
