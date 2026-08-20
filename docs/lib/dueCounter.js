/**
 * dueCounter.js
 * --------------
 * カード種別ごとに「次に払い出す cards.due(Ankiの新規カードの位置)」を
 * localStorage で管理する。デスクトップ版の due_counter.py と同じ役割。
 *
 * 【なぜ必要か】
 * apkg は毎回まっさらな一時コレクションとして組み立てられるため、以前の
 * 出力で使った due を知る手段がなく、従来は出力のたびに 0 から採番して
 * いた(word は全ノート due=0、grammar_multi/daily は 0 始まりのインデックス)。
 * その結果、別々の出力バッチのカードが Anki 側で同じ位置に居座り、
 * 「1つの質問から作った3問がまとまって出題されず、他のカードと混ざる」
 * 状態になっていた(2026-08-20、片桐からの報告)。
 *
 * shuujuku は Num フィールドの続き番号(shuujuku.js の getNextNum)を
 * そのまま due にも使っているため既に連番になっており、このモジュールの
 * 対象外。
 *
 * 【重要】この値は Anki コレクション側の実際の位置とは同期しない。
 * 初回は「そのデッキで既に使われている位置の最大値+1」を設定画面から
 * 手で入れる必要がある(fix_anki_new_order.py --show で確認できる)。
 */

/** 対象のカード種別キー(docs/shared/card_defs.json の defs のキーと同じ)。 */
export const DUE_COUNTER_KEYS = ['word', 'grammar_multi', 'daily'];

const PREFIX = 'anki_tool_';
const SUFFIX = '_next_due';

function storageKey(key) {
  return `${PREFIX}${key}${SUFFIX}`;
}

/**
 * 次に払い出す開始番号を返す。未設定なら 1。
 * @param {string} key カード種別キー
 */
export function getNextDue(key) {
  let raw = null;
  try {
    raw = localStorage.getItem(storageKey(key));
  } catch {
    // localStorage が使えない環境(プライベートモード等)では既定値で続行する。
    return 1;
  }
  const n = raw ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 開始番号を明示的に設定する(設定画面の入力欄用)。
 * 1 未満・数値でない値は拒否して false を返す。
 */
export function setNextDue(key, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return false;
  try {
    localStorage.setItem(storageKey(key), String(n));
  } catch {
    return false;
  }
  return true;
}

/**
 * 開始番号を count 件分進める。
 * **apkg の生成・ダウンロードが実際に成功した後にだけ呼ぶこと**
 * (失敗したバッチで番号を消費すると、Anki 側に存在しない番号が飛ぶため)。
 */
export function advanceNextDue(key, count) {
  if (!(count > 0)) return;
  setNextDue(key, getNextDue(key) + count);
}

/** 全カード種別の現在値を {key: 次の開始番号} で返す(設定画面・同期用)。 */
export function getAllNextDue() {
  const out = {};
  for (const key of DUE_COUNTER_KEYS) out[key] = getNextDue(key);
  return out;
}
