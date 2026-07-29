// dailyconv.js
// ---------------------------------------------------------------------------
// 「添削結果」シートの行を、DailyConversation ノートの 9 フィールドへ変換する。
// build_grammar_dailyconv_v1_final.py の process_sheet_rows() / build_deck() と、
// daily_pending_exclusions.py に対応する Web 版。
//
// 【他のカード種別との違い(重要)】
// word・grammar_multi は「AIが生成した瞬間の値」がそのままAnkiフィールド値に
// なるが、DailyConversation は違う。元になるのはシートの1行で、
// Question/Example/ExampleJA/Score はその行の複数列から HTML に合成した結果。
// そのため習熟用(shuujuku.js)と同じく、buildFieldsReadyItems() で先に
// 9フィールド分の値を確定させてから buildApkg() に渡す。
//
// 【正典との関係】
// build_grammar_dailyconv_v1_final.py の正典は claude.ai 側にあり、このリポジトリ
// にあるのはそのコピー(CLAUDE.md 参照)。ここはそのコピーの build_deck() の
// 組み立てを移植したもので、両者が一致することは
// tools/verify_web_parity.mjs が実際に apkg を突き合わせて検証している。

const EXCLUSIONS_KEY = 'anki_tool_daily_excluded_ids';

/** CATEGORY_PATTERN_MAP と同一。 */
const CATEGORY_PATTERN_MAP = {
  文法: '誤り訂正問題(文法)',
  語彙: '誤り訂正問題(語彙)',
  自然さ: '表現改善問題',
};

const DEFAULT_PATTERN = '誤り訂正問題';

/**
 * process_sheet_rows() と同一。カテゴリ「誤りなし」の行を除外し、
 * ID が重複する行は先に出現した方だけを残す。
 *
 * @returns {{rows: object[], duplicateIds: string[]}}
 */
export function processSheetRows(rawRows) {
  const filtered = (rawRows || []).filter((r) => r.category !== '誤りなし');
  const seen = new Set();
  const rows = [];
  const duplicateIds = [];
  for (const r of filtered) {
    if (seen.has(r.id)) {
      duplicateIds.push(r.id);
      continue;
    }
    seen.add(r.id);
    rows.push(r);
  }
  return { rows, duplicateIds };
}

/** build_score_html() と同一。 */
function buildScoreHtml(grammar, naturalness, comprehensibility, comment) {
  return '<div class="score-badges">'
    + `<span class="score-badge">文法 <span class="num">${grammar}</span>/100</span>`
    + `<span class="score-badge">自然さ <span class="num">${naturalness}</span>/100</span>`
    + `<span class="score-badge">伝わりやすさ <span class="num">${comprehensibility}</span>/100</span>`
    + '</div>'
    + `<div class="score-comment">${comment}</div>`;
}

/**
 * Score フィールドを出すかどうか。build_deck() の
 * `all(k in r and r[k] is not None for k in (...))` と同一の判定。
 *
 * **score_comment が空文字でも「値はある」と見なす**のが正典の挙動
 * (Python 側は None かどうかだけを見ており、空文字は通る)。
 * sheets.js の fetchPendingRows() は score_comment を必ず文字列で返し、
 * 3つのスコアだけが数値 or null になるため、実質「3つのスコアが全て
 * 入力されていれば Score を出す」という意味になる。
 */
function hasScore(row) {
  return ['grammar_score', 'naturalness_score', 'comprehensibility_score', 'score_comment']
    .every((k) => row[k] !== null && row[k] !== undefined);
}

/**
 * シートの行(sheets.fetchPendingRows() の戻り値)を、apkg 出力用の
 * 「9フィールド確定済み item」に変換する(build_deck() のノート組み立てと同一)。
 *
 * guid 計算に使う `id` はそのまま保持する
 * (docs/shared/card_defs.json の daily.guid_scheme が参照する)。
 *
 * @param {object[]} rows processSheetRows() を通した後の行
 * @returns {object[]}
 */
export function buildFieldsReadyItems(rows) {
  return rows.map((r) => {
    const enList = r.similar_en_list || [];
    const jaList = r.similar_ja_list || [];

    return {
      id: r.id,
      pattern: CATEGORY_PATTERN_MAP[r.category] || DEFAULT_PATTERN,
      question: '<b>指示:</b> 以下の英文には誤りがあります。誤りを見つけて訂正してください。<br><br>'
        + `${r.original}`,
      choices: '',
      answer: r.corrected,
      example: enList
        .map((en, i) => `<span class="ex-num">Ex${i + 1}.</span> ${en}`)
        .join('<br>'),
      example_ja: jaList.map((ja) => `└ ${ja}`).join('<br>'),
      why: r.explanation,
      whynot: '',
      score: hasScore(r)
        ? buildScoreHtml(
          r.grammar_score, r.naturalness_score, r.comprehensibility_score, r.score_comment,
        )
        : '',
    };
  });
}

// ---------------------------------------------------------------------------
// ローカル除外リスト(daily_pending_exclusions.py の移植)
// ---------------------------------------------------------------------------
//
// 「添削結果」シートは sheets.js の責務上、行の削除ができない
// (読み取りと、Anki出力済み列の書き込み・新規行追記だけ)。そのため
// 「Googleフォーム経由と直接入力経由で同じ内容が二重に入ってしまった」
// といった行を一覧から外したい場合は、シートを変更せず**行IDをこちら側で
// ローカルに記録して表示・出力対象から除く**方式にしている
// (デスクトップ版と同じ考え方。ただし保存先は localStorage)。

/** 除外登録済みの行IDの集合を返す。 */
export function loadExcludedIds() {
  try {
    const raw = localStorage.getItem(EXCLUSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveExcludedIds(ids) {
  localStorage.setItem(EXCLUSIONS_KEY, JSON.stringify([...ids].sort()));
}

/** 行IDを除外リストに追加する(シート側のデータには一切書き込まない)。 */
export function addExcludedIds(rowIds) {
  const ids = loadExcludedIds();
  for (const rowId of rowIds) {
    if (rowId) ids.add(rowId);
  }
  saveExcludedIds(ids);
}

/** 除外リストを空にする。 */
export function clearExcludedIds() {
  localStorage.removeItem(EXCLUSIONS_KEY);
}

/** fetchPendingRows() の結果から、除外登録済みの行を取り除いて返す。 */
export function filterOutExcluded(rows) {
  const excluded = loadExcludedIds();
  if (excluded.size === 0) return rows;
  return rows.filter((r) => !excluded.has(r.id));
}

// ---------------------------------------------------------------------------
// 出力済みのローカル記録(2026-07-29追加)
// ---------------------------------------------------------------------------
//
// シート側の「Anki出力済み」列マーク(④のチェックボックス、markRowsAsExported)
// とは別に、「このブラウザで少なくとも一度は.apkgに含めて出力した」ことを
// ローカルに記録する。④のチェックボックスをOFFにして出力した場合や、
// シートへの書き込みが何らかの理由で失敗した場合でも、③の一覧に残り続ける
// 行のうち「実は既に一度カード化した」ものを見分けられるようにするための
// 保険(除外リストとは目的が異なるため別のキーで管理する)。

const EXPORTED_KEY = 'anki_tool_daily_exported_ids';

/** ローカルで「出力済み」と記録した行IDの集合を返す。 */
export function loadExportedIds() {
  try {
    const raw = localStorage.getItem(EXPORTED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveExportedIds(ids) {
  localStorage.setItem(EXPORTED_KEY, JSON.stringify([...ids].sort()));
}

/** 行IDを出力済み記録に追加する(シート側のデータには一切書き込まない)。 */
export function addExportedIds(rowIds) {
  const ids = loadExportedIds();
  for (const rowId of rowIds) {
    if (rowId) ids.add(rowId);
  }
  saveExportedIds(ids);
}

/** 出力済み記録を空にする(「出力済み履歴をリセット」ボタン用)。 */
export function clearExportedIds() {
  localStorage.removeItem(EXPORTED_KEY);
}
