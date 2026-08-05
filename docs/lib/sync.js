// sync.js
// ---------------------------------------------------------------------------
// 複数端末(PC・スマホ)間で単語/AIに質問/習熟用の3ストックを同期するための
// マージロジック(純粋関数のみ、通信は持たない。実際の読み書きは
// docs/lib/sheets.js の readSyncState/writeSyncState が担当)。
//
// 【背景・設計方針(2026-07-30)】
// 保存先は「添削結果」スプレッドシート内の隠しタブ(_AppSync)。既に
// DailyConversation機能で使っている `spreadsheets` スコープのGoogleログインを
// そのまま流用でき、Drive APIへのスコープ追加(＝再同意・審査)が不要なのが
// 最大の利点(片桐の希望「今のGoogleログインの流用でなんとかならないか」に対応)。
//
// 単純な「後勝ち(読んだ内容で丸ごと上書き)」だと、同期し忘れた端末が古い
// スナップショットで上書きして他端末の新しい追加分を消してしまうリスクが
// ある。これを緩和するため、id単位の**和集合マージ**にした:
//   - 追加は基本的にデータを失わない(同じidの項目が両側にあればupdated_at
//     (無ければgenerated_at)が新しい方を採用、無ければどちらも残す)。
//   - 削除は「打ち消し記録(tombstone)」のidリストとして両側の和集合を取り、
//     それに含まれるidの項目は復活させない(でないと、削除前の古い
//     スナップショットを持つ端末が同期するたびに削除済み項目が復活する)。
// この設計は、単語/AIに質問/習熟用ストックが既に持つ「重複していても常に
// 追加→一覧で⚠表示→手動で選んで削除」という方針と相性が良い。同期の衝突が
// 起きても基本的にデータ消失ではなく「一覧に一時的に重複して見える」形に
// 倒れ、既存の重複検出・手動削除UIでそのまま解消できる。
//
// 【残る限界】真に同時(秒未満)に複数端末が同じ項目を編集した場合の
// フィールド単位の突き合わせ(3-wayマージ)までは行わない(item全体を
// updated_atで比較するだけ)。片桐一人が順番に端末を使う想定であれば
// 実用上十分と判断している。

/** Google Sheetsの1セルの上限文字数(公式仕様: 50,000文字)。 */
export const SHEET_CELL_LIMIT = 50000;

/**
 * この使用率(%)を超えたら、まだ書き込めるうちに片桐へ知らせる閾値。
 *
 * 上限に達してからでは「同期がエラーで一切通らない」状態になり、しかも
 * 復旧手段(出力済みを削除する)を実行するために開くアプリ自体は同期できない、
 * という手詰まりになりやすいため、余裕のあるうちに警告する。
 */
export const CAPACITY_WARN_PERCENT = 70;

/** JSON文字列の、Sheetsセル上限に対する使用率(%、小数第1位に丸め)。 */
export function capacityPercent(jsonString) {
  const len = (jsonString || '').length;
  return Math.round((len / SHEET_CELL_LIMIT) * 1000) / 10;
}

/**
 * 1セルの上限を超えていないか(2026-08-05追加)。
 *
 * 以前は`capacityPercent`を計算していたものの、それを表示するのは
 * `writeSyncState`が**成功した後**だった。使用率が100%を超えた瞬間、
 * Sheets APIが素の400を返して同期が丸ごと止まり、しかもどのストックが
 * 原因なのか分からないメッセージになる。書き込み前にこれで判定して、
 * 対処方法まで添えて中断できるようにする。
 */
export function exceedsCellLimit(jsonString) {
  return (jsonString || '').length > SHEET_CELL_LIMIT;
}

/** JSON文字列(配列)をパースする。壊れている/空なら空配列を返す。 */
export function parseIdArray(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** crypto.randomUUID が使えない古い環境向けのフォールバック付きID生成。 */
export function newSyncId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * 既存ストック項目(同期機能の追加前に生成された、id/updated_atを持たない
 * ものがありうる)に、無ければ補う(移行用)。
 * @param {object[]} items
 * @returns {{items: object[], changed: boolean}}
 */
export function ensureItemIds(items) {
  let changed = false;
  const out = (items || []).map((item) => {
    if (item.id && item.updated_at) return item;
    changed = true;
    return {
      ...item,
      id: item.id || newSyncId(),
      updated_at: item.updated_at || item.generated_at || new Date().toISOString(),
    };
  });
  return { items: out, changed };
}

/**
 * ローカルとリモートのストックをid単位でマージする。
 * @param {object[]} localItems 現在のローカルの配列(id/updated_atを持つ前提)
 * @param {object[]} remoteItems シートから読んだ配列
 * @param {string[]} localTombstoneIds この端末で削除・出力済みクリアしたidの一覧
 * @param {string[]} remoteTombstoneIds シートに書かれている削除済みidの一覧
 * @returns {{items: object[], tombstoneIds: string[]}}
 */
export function mergeStock(localItems, remoteItems, localTombstoneIds, remoteTombstoneIds) {
  const tombstoneIds = new Set([...(localTombstoneIds || []), ...(remoteTombstoneIds || [])]);

  const byId = new Map();
  const order = [];
  const consider = (item) => {
    if (!item || !item.id || tombstoneIds.has(item.id)) return;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      order.push(item.id);
      return;
    }
    // 同じidが両側にある場合、updated_at(無ければgenerated_at)が新しい方を採用する
    // (アイテム全体の単純なLast-Write-Winsで、フィールド単位の突き合わせはしない)。
    const existingTime = existing.updated_at || existing.generated_at || '';
    const candidateTime = item.updated_at || item.generated_at || '';
    if (candidateTime > existingTime) byId.set(item.id, item);
  };

  (localItems || []).forEach(consider);
  (remoteItems || []).forEach(consider);

  return {
    items: order.map((id) => byId.get(id)),
    tombstoneIds: [...tombstoneIds].sort(),
  };
}
