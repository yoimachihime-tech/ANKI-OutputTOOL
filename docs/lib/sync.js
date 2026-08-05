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
 * 1セルに書き込むチャンクの長さ(2026-08-05追加)。
 *
 * 上限50,000ちょうどではなく余裕を持たせてある。Googleが数える「文字数」と
 * JavaScriptの`String.length`(UTF-16のコード単位数)は、絵文字などのBMP外文字で
 * ずれる。カード本文に絵文字が混ざっても弾かれないようにするための保険。
 */
export const SYNC_CHUNK_SIZE = 45000;

/**
 * 1つのキー(例: ai_ask_stock_items)を何セルまで分割してよいか。
 *
 * 【なぜ分割するのか】(2026-08-05追加)
 * 以前は1キー=1セルだったため、上限が50,000文字 = Grammar Multiで約49件
 * (質問16回分)しかなかった。実際に片桐から「AIに質問の占有率が50%近く、
 * すぐ100%になってしまう」と報告があった。
 * **Sheetsの50,000文字制限は「1セルあたり」で、シート全体ではない**
 * (1シートは1,000万セルまで持てる)。そこで値を複数セルに分けて書き、
 * 読むときに連結することで上限を実質的に取り払う。
 *
 * 【なぜ20か】
 * 20 × 45,000 = 900,000文字 ≒ Grammar Multi で約880件(質問290回分)。
 * 週3回質問しても2年近く保つ。**増やす副作用はほとんど無い**
 * (使っていないセルは空文字で書かれるだけ、シートのセル上限にも遠く及ばない)
 * ので、逼迫したらこの定数を増やせばよい。
 * ただし際限なく増やすと、JSON全体が数MBになってスマホでの読み書きが
 * 重くなる方が先に問題になる。そうなったら「出力済みを削除」で整理するか、
 * 保存時の圧縮(gzip、実データで約3.7分の1)を検討すること。
 */
export const SYNC_MAX_CHUNKS = 20;

/** 1キーあたりに保存できる合計文字数。 */
export const SYNC_VALUE_LIMIT = SYNC_CHUNK_SIZE * SYNC_MAX_CHUNKS;

/**
 * この使用率(%)を超えたら、まだ書き込めるうちに片桐へ知らせる閾値。
 *
 * 上限に達してからでは「同期がエラーで一切通らない」状態になり、しかも
 * 復旧手段(出力済みを削除する)を実行するために開くアプリ自体は同期できない、
 * という手詰まりになりやすいため、余裕のあるうちに警告する。
 */
export const CAPACITY_WARN_PERCENT = 70;

/**
 * JSON文字列の、保存できる上限に対する使用率(%、小数第1位に丸め)。
 *
 * 2026-08-05に分母を「1セル(50,000)」から「1キーの合計(SYNC_VALUE_LIMIT)」へ
 * 変更した。複数セルへの分割保存に対応したため、1セルを超えても問題なくなった。
 */
export function capacityPercent(jsonString) {
  const len = (jsonString || '').length;
  return Math.round((len / SYNC_VALUE_LIMIT) * 1000) / 10;
}

/**
 * 保存できる上限を超えていないか(2026-08-05追加)。
 *
 * 以前は`capacityPercent`を計算していたものの、それを表示するのは
 * `writeSyncState`が**成功した後**だった。使用率が100%を超えた瞬間、
 * Sheets APIが素の400を返して同期が丸ごと止まり、しかもどのストックが
 * 原因なのか分からないメッセージになる。書き込み前にこれで判定して、
 * 対処方法まで添えて中断できるようにする。
 */
export function exceedsSyncLimit(jsonString) {
  return (jsonString || '').length > SYNC_VALUE_LIMIT;
}

/**
 * 長い文字列を、1セルに収まる長さのチャンクに分ける。
 * 空文字なら空配列(＝どのセルにも書かない)。
 */
export function splitIntoChunks(value, chunkSize = SYNC_CHUNK_SIZE) {
  const s = String(value ?? '');
  if (!s) return [];
  const chunks = [];
  for (let i = 0; i < s.length; i += chunkSize) chunks.push(s.slice(i, i + chunkSize));
  return chunks;
}

/**
 * 分割して書かれたセルの並びを1つの文字列に戻す。
 *
 * **1セルしか無い場合もそのまま連結される**ので、分割対応より前に書かれた
 * データ(1キー=1セル)もそのまま読める(下位互換)。片桐の既存データに
 * 移行作業が要らないのはこのため。
 */
export function joinChunks(cells) {
  return (cells || []).map((c) => String(c ?? '')).join('');
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
 * 打ち消し記録(tombstone)の上限件数(2026-08-05追加)。
 *
 * 【なぜ上限が要るか】
 * 削除のたびにidが1つ増え、**無期限に増え続ける**設計だった。tombstoneは
 * items と同じ50,000文字のセル上限を持つ別の行に入るため、UUID(36文字)+
 * 引用符・カンマで1件約39バイトとして、1,280件ほどで書き込めなくなる。
 *
 * 【なぜ500件か】
 * 500件で約20KB = セル上限の約39%。警告閾値(CAPACITY_WARN_PERCENT = 70%)にも
 * 届かない余裕を残してある。片桐が1人で使う規模なら、500回の削除を遡って
 * 打ち消しが要る場面は考えにくい。
 */
export const MAX_TOMBSTONES = 500;

/**
 * 打ち消し記録が上限を超えていたら、**古い方から**捨てる。
 *
 * 【捨てて安全か】
 * 打ち消し記録は「この項目は削除済みだから、古いスナップショットを持つ端末が
 * 同期しても復活させるな」という目印。全端末が同期を終えた後は、その項目は
 * どこにも残っていないので記録も不要になる。捨てて問題が起きるのは
 * 「非常に古い削除を、まだ一度も同期していない端末が持っている」場合だけで、
 * 500件も削除が進んだ後にそれが起きるとは考えにくい。
 * 万一復活しても**データ消失ではなく一覧に重複が現れる**だけで、既存の
 * 「⚠ 重複」表示から手動で消せる(このアプリ全体の設計方針と同じ)。
 *
 * 【「古い」の判定について】
 * 記録はid文字列だけで時刻を持たない(時刻を持たせると1件あたりの容量が
 * 倍近くなり、容量を減らすという目的と衝突する)。そのため**配列の並び順を
 * 挿入順とみなして**先頭から捨てる。マージ後の並びは「ローカルの並び →
 * リモートにしか無かったid」なので厳密な時系列ではないが、この用途には十分。
 * ——だからこそ `saveTombstoneIds` はソートしてはいけない(2026-08-05に
 * ソートを廃止した。ソートすると並びがUUIDの辞書順になり、意味を失う)。
 */
export function pruneTombstoneIds(ids, max = MAX_TOMBSTONES) {
  const list = ids || [];
  if (list.length <= max) return list;
  return list.slice(list.length - max);
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
  // Set は挿入順を保つので、「ローカルの並び → リモートにしか無かったid」の
  // 順序になる。pruneTombstoneIds がこの並びを挿入順とみなして古い方から
  // 捨てるため、**ここでソートしないこと**。
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
    // 上限を超えたぶんは古い方から捨てる(2026-08-05追加)。
    // ソートしないのは上記のとおり(挿入順が刈り込みの判断材料になる)。
    tombstoneIds: pruneTombstoneIds([...tombstoneIds]),
  };
}
