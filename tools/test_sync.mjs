// tools/test_sync.mjs
// ---------------------------------------------------------------------------
// docs/lib/sync.js(マージロジック)と、docs/lib/sheets.js に追加した
// 複数端末間の同期用関数(readSyncState/writeSyncState/隠しタブの自動作成)の
// 単体テスト。
//
// 検証しているのは:
//   - mergeStock: 追加は和集合(データを失わない)、同じidの衝突は
//     updated_at(無ければgenerated_at)が新しい方を採用するLast-Write-Wins、
//     tombstoneに含まれるidは復活しないこと
//   - ensureItemIds: 既存(id/updated_at無し)ストックへの移行が1回だけ効くこと
//   - capacityPercent: Sheetsの1セル上限(50,000文字)に対する使用率の計算
//   - readSyncState/writeSyncState: 隠しタブ(_AppSync)が無ければ作成し、
//     A1:B6の固定レイアウトで読み書きすること
//
// Sheets API は fetch をモックするので、実際のスプレッドシートにも
// Googleアカウントにも一切アクセスしない。
//
// 【使い方】 cd tools && node test_sync.mjs

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('lib/sync.js / lib/sheets.js(同期関連)の単体テスト\n');

const {
  mergeStock, ensureItemIds, capacityPercent, parseIdArray, newSyncId, SHEET_CELL_LIMIT,
} = await import(new URL('../docs/lib/sync.js', import.meta.url));

// ---------------------------------------------------------------------------
console.log('[1] mergeStock');

{
  const local = [{ id: 'a', generated_at: '2026-07-30T00:00:00.000Z', updated_at: '2026-07-30T00:00:00.000Z', word: 'apple' }];
  const remote = [{ id: 'b', generated_at: '2026-07-30T00:01:00.000Z', updated_at: '2026-07-30T00:01:00.000Z', word: 'banana' }];

  const { items, tombstoneIds } = mergeStock(local, remote, [], []);
  if (items.length === 2 && deepEq(items.map((i) => i.id).sort(), ['a', 'b'])) {
    ok('両側にしか無い項目は和集合として残る(データを失わない)');
  } else {
    fail(`和集合の結果が想定と違う: ${JSON.stringify(items)}`);
  }
  if (deepEq(tombstoneIds, [])) ok('打ち消し記録が無ければ空のまま');
  else fail(`tombstoneIdsが想定と違う: ${JSON.stringify(tombstoneIds)}`);
}

{
  // 同じidが両側にある場合、updated_atが新しい方を採用する
  const local = [{ id: 'a', updated_at: '2026-07-30T00:00:00.000Z', word: 'apple', exported_at: null }];
  const remote = [{ id: 'a', updated_at: '2026-07-30T01:00:00.000Z', word: 'apple', exported_at: '2026-07-30T01:00:00.000Z' }];

  const { items } = mergeStock(local, remote, [], []);
  if (items.length === 1 && items[0].exported_at === '2026-07-30T01:00:00.000Z') {
    ok('同じidの衝突はupdated_atが新しい方(この場合はremote)を採用する');
  } else {
    fail(`LWWの結果が想定と違う: ${JSON.stringify(items)}`);
  }
}

{
  // ローカルの方が新しければローカルを採用する
  const local = [{ id: 'a', updated_at: '2026-07-30T02:00:00.000Z', exported_at: null }];
  const remote = [{ id: 'a', updated_at: '2026-07-30T01:00:00.000Z', exported_at: '2026-07-30T01:00:00.000Z' }];

  const { items } = mergeStock(local, remote, [], []);
  if (items.length === 1 && items[0].exported_at === null) {
    ok('ローカルの方が新しければローカル側(この場合は出力済みリセット後)を採用する');
  } else {
    fail(`LWWの結果が想定と違う(local優先ケース): ${JSON.stringify(items)}`);
  }
}

{
  // updated_atが無い場合はgenerated_atにフォールバックする
  const local = [{ id: 'a', generated_at: '2026-07-30T00:00:00.000Z' }];
  const remote = [{ id: 'a', generated_at: '2026-07-30T05:00:00.000Z' }];
  const { items } = mergeStock(local, remote, [], []);
  if (items.length === 1 && items[0].generated_at === '2026-07-30T05:00:00.000Z') {
    ok('updated_atが無ければgenerated_atで比較する');
  } else {
    fail(`generated_atフォールバックの結果が想定と違う: ${JSON.stringify(items)}`);
  }
}

{
  // tombstoneに含まれるidは、片側にしか無くても復活しない
  const local = [{ id: 'a', updated_at: '2026-07-30T00:00:00.000Z' }];
  const remote = [
    { id: 'a', updated_at: '2026-07-30T00:00:00.000Z' },
    { id: 'deleted-elsewhere', updated_at: '2026-07-30T00:00:00.000Z' },
  ];
  // ローカルで 'deleted-elsewhere' を削除済み(このidはlocalの配列には既に無い)。
  const { items, tombstoneIds } = mergeStock(local, remote, ['deleted-elsewhere'], []);

  if (items.length === 1 && items[0].id === 'a') {
    ok('打ち消し記録にあるidは、リモートにまだ残っていても復活しない');
  } else {
    fail(`tombstoneの除外が効いていない: ${JSON.stringify(items)}`);
  }
  if (deepEq(tombstoneIds, ['deleted-elsewhere'])) {
    ok('打ち消し記録は両側の和集合になる');
  } else {
    fail(`tombstoneIdsの和集合が想定と違う: ${JSON.stringify(tombstoneIds)}`);
  }
}

{
  // idが無い項目(移行前データの誤混入等)は無視する(クラッシュしない)
  const { items } = mergeStock([{ word: 'no-id' }], [], [], []);
  if (deepEq(items, [])) ok('idを持たない項目は同期対象から除外される(クラッシュしない)');
  else fail(`idなし項目の扱いが想定と違う: ${JSON.stringify(items)}`);
}

// ---------------------------------------------------------------------------
console.log('\n[2] ensureItemIds');

{
  const { items, changed } = ensureItemIds([{ word: 'apple', generated_at: '2026-07-30T00:00:00.000Z' }]);
  if (changed && items[0].id && items[0].updated_at === '2026-07-30T00:00:00.000Z') {
    ok('id/updated_atが無い既存項目に補う(updated_atはgenerated_atにフォールバック)');
  } else {
    fail(`移行結果が想定と違う: ${JSON.stringify(items)}`);
  }
}

{
  const already = { id: 'existing-id', updated_at: '2026-07-30T00:00:00.000Z', word: 'apple' };
  const { items, changed } = ensureItemIds([already]);
  if (!changed && items[0] === already) {
    ok('既にid/updated_atを持つ項目はそのまま(不要な再生成をしない)');
  } else {
    fail('既存id/updated_atが不要に書き換えられている');
  }
}

{
  const { items } = ensureItemIds([]);
  if (deepEq(items, [])) ok('空配列はそのまま空配列');
  else fail('空配列の扱いが想定と違う');
}

// ---------------------------------------------------------------------------
console.log('\n[3] capacityPercent / parseIdArray / newSyncId');

{
  const json = 'a'.repeat(SHEET_CELL_LIMIT / 2);
  if (capacityPercent(json) === 50) ok('capacityPercent: 上限の半分の長さなら50%');
  else fail(`capacityPercent の計算が想定と違う: ${capacityPercent(json)}`);

  if (capacityPercent('') === 0) ok('capacityPercent: 空文字なら0%');
  else fail('空文字のcapacityPercentが0でない');
}

{
  if (deepEq(parseIdArray('["a","b"]'), ['a', 'b'])) ok('parseIdArray: 正常なJSON配列をパースする');
  else fail('正常なJSON配列のパースに失敗');

  if (deepEq(parseIdArray(''), []) && deepEq(parseIdArray(undefined), []) && deepEq(parseIdArray('not json'), [])) {
    ok('parseIdArray: 空文字・未定義・壊れたJSONは空配列にフォールバックする');
  } else {
    fail('壊れた入力のフォールバックが想定と違う');
  }

  if (deepEq(parseIdArray('{"not":"array"}'), [])) {
    ok('parseIdArray: 配列でないJSON(オブジェクト等)も空配列にフォールバックする');
  } else {
    fail('オブジェクトが誤って配列として扱われている');
  }
}

{
  const id1 = newSyncId();
  const id2 = newSyncId();
  if (id1 !== id2 && typeof id1 === 'string' && id1.length > 0) {
    ok('newSyncId: 呼ぶたびに異なる非空文字列を返す');
  } else {
    fail(`newSyncIdの結果が想定と違う: ${id1} / ${id2}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] readSyncState / writeSyncState(隠しタブ _AppSync)');

const { readSyncState, writeSyncState, SYNC_SHEET_NAME, SYNC_ROW_KEYS } = await import(
  new URL('../docs/lib/sheets.js', import.meta.url)
);

const TOKEN = 'ya29.dummy-access-token';

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const result = await handler(url, init);
    if (result && result.__error) {
      return { ok: false, status: result.__error, text: async () => result.detail || '' };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  return calls;
}

{
  // タブが既に存在する場合: 作成APIを呼ばず、そのまま読み取る
  const calls = mockFetch(async (url) => {
    if (url.includes('fields=sheets.properties.title')) {
      return { sheets: [{ properties: { title: '添削結果' } }, { properties: { title: SYNC_SHEET_NAME } }] };
    }
    return {
      values: [
        ['word_stock_items', '[{"id":"a"}]'],
        ['word_stock_tombstones', '[]'],
      ],
    };
  });

  const state = await readSyncState({ spreadsheetId: 'SHEET_ID', accessToken: TOKEN });

  if (!calls.some((c) => c.method === 'POST')) {
    ok('タブが既にあれば addSheet(batchUpdate) は呼ばない');
  } else {
    fail('既存タブなのにbatchUpdateが呼ばれている');
  }
  if (state.word_stock_items === '[{"id":"a"}]' && state.ai_ask_stock_items === '') {
    ok('保存済みの行はJSON文字列を、未保存の行は空文字を返す');
  } else {
    fail(`readSyncStateの結果が想定と違う: ${JSON.stringify(state)}`);
  }
}

{
  // タブが無い場合: addSheet(batchUpdate)で hidden:true 付きで作成してから読む
  const calls = mockFetch(async (url) => {
    if (url.includes('fields=sheets.properties.title')) {
      return { sheets: [{ properties: { title: '添削結果' } }] };
    }
    if (url.includes(':batchUpdate')) return { replies: [{}] };
    return {};
  });

  await readSyncState({ spreadsheetId: 'SHEET_ID', accessToken: TOKEN });

  const batch = calls.find((c) => c.url.includes(':batchUpdate'));
  if (batch && batch.body.requests[0].addSheet.properties.title === SYNC_SHEET_NAME
    && batch.body.requests[0].addSheet.properties.hidden === true) {
    ok('タブが無ければ、片桐の目に触れない隠しタブとして自動作成する');
  } else {
    fail(`タブ自動作成のリクエストが想定と違う: ${JSON.stringify(batch)}`);
  }
}

{
  // 書き込み: A1:B{N}の固定レイアウトでRAW書き込みする
  const calls = mockFetch(async (url) => {
    if (url.includes('fields=sheets.properties.title')) {
      return { sheets: [{ properties: { title: SYNC_SHEET_NAME } }] };
    }
    return { updatedCells: SYNC_ROW_KEYS.length * 2 };
  });

  const state = { word_stock_items: '[{"id":"a"}]', word_stock_tombstones: '["x"]' };
  await writeSyncState({ spreadsheetId: 'SHEET_ID', accessToken: TOKEN, state });

  const put = calls.find((c) => c.method === 'PUT');
  if (put && put.url.includes(encodeURIComponent(`${SYNC_SHEET_NAME}!A1:B${SYNC_ROW_KEYS.length}`))
    && put.url.includes('valueInputOption=RAW')) {
    ok('固定レンジ A1:B{N} に対して valueInputOption=RAW で書き込む');
  } else {
    fail(`書き込みリクエストが想定と違う: ${put ? put.url : '(PUTが呼ばれていない)'}`);
  }

  const row0 = put.body.values[0];
  if (deepEq(row0, ['word_stock_items', '[{"id":"a"}]'])) {
    ok('各行はSYNC_ROW_KEYSの順に [キー名, JSON文字列] を書く');
  } else {
    fail(`書き込む値の形が想定と違う: ${JSON.stringify(row0)}`);
  }

  const emptyRow = put.body.values[SYNC_ROW_KEYS.indexOf('ai_ask_stock_items')];
  if (emptyRow[1] === '') {
    ok('stateに無いキーは空文字で書く');
  } else {
    fail(`未指定キーの扱いが想定と違う: ${JSON.stringify(emptyRow)}`);
  }
}

// ---------------------------------------------------------------------------
// [5] readSyncState は行の位置ではなくA列のキー名で引く(2026-08-05修正)
//
// 以前は `values[i][1]` と行の位置だけで読んでおり、A列に書いてあるキー名を
// 照合していなかった。将来 SYNC_ROW_KEYS の順序が変わる・途中にキーが増えると、
// 既にシートを持っている端末が「単語のJSONを習熟用として読み込む」取り違えを
// 起こす(エラーにならず静かにストックが混ざり、次の書き戻しで他端末へ伝播する)。
// ---------------------------------------------------------------------------
console.log('\n[5] readSyncState はA列のキー名で引く');

{
  // 行の並びが SYNC_ROW_KEYS と違う(順序が入れ替わっている)シートを渡す。
  mockFetch(async (url) => {
    if (url.includes('fields=sheets.properties.title')) {
      return { sheets: [{ properties: { title: SYNC_SHEET_NAME } }] };
    }
    return {
      values: [
        ['shuujuku_stock_items', '["習熟用"]'],
        ['word_stock_items', '["単語"]'],
        ['ai_ask_stock_items', '["AIに質問"]'],
      ],
    };
  });

  const state = await readSyncState({ spreadsheetId: 'SHEET_ID', accessToken: TOKEN });

  if (state.word_stock_items === '["単語"]'
    && state.shuujuku_stock_items === '["習熟用"]'
    && state.ai_ask_stock_items === '["AIに質問"]') {
    ok('行の並びが SYNC_ROW_KEYS と違っても、キー名で正しく対応付ける');
  } else {
    fail(`行の位置で読んでいてストックが取り違えられている: ${JSON.stringify(state)}`);
  }

  if (state.word_stock_tombstones === '') {
    ok('シートに無いキーは空文字になる');
  } else {
    fail(`未保存キーの扱いが想定と違う: ${JSON.stringify(state.word_stock_tombstones)}`);
  }
}

// ---------------------------------------------------------------------------
// [6] セル上限(50,000文字)の判定(2026-08-05追加)
//
// 上限を超えたJSONをそのまま送るとSheets APIが素の400を返し、どのストックが
// 原因かも分からないまま同期が丸ごと止まる。app.js の runSync が書き込み前に
// これで判定して、対処方法(「出力済みを削除」)を添えて中断する。
// ---------------------------------------------------------------------------
console.log('\n[6] exceedsCellLimit / CAPACITY_WARN_PERCENT');

{
  const { exceedsCellLimit, CAPACITY_WARN_PERCENT } = await import(
    new URL('../docs/lib/sync.js', import.meta.url)
  );

  if (!exceedsCellLimit('x'.repeat(SHEET_CELL_LIMIT))) {
    ok('ちょうど上限(50,000文字)は超過扱いにしない');
  } else {
    fail('ちょうど上限で超過と判定されている');
  }
  if (exceedsCellLimit('x'.repeat(SHEET_CELL_LIMIT + 1))) {
    ok('上限を1文字でも超えたら超過と判定する');
  } else {
    fail('上限超過を検出できていない');
  }
  if (!exceedsCellLimit('') && !exceedsCellLimit(null)) {
    ok('空文字・null は超過扱いにしない');
  } else {
    fail('空の値が超過と判定されている');
  }

  // 警告閾値は「上限に達してからでは、復旧のために開くアプリ自体が同期
  // できない」手詰まりを避けるためのもの。100%より十分手前である必要がある。
  if (CAPACITY_WARN_PERCENT > 0 && CAPACITY_WARN_PERCENT < 100) {
    ok(`警告閾値は上限より手前に設定されている(${CAPACITY_WARN_PERCENT}%)`);
  } else {
    fail(`警告閾値が実用的でない: ${CAPACITY_WARN_PERCENT}`);
  }

  const warnJson = 'x'.repeat(Math.ceil(SHEET_CELL_LIMIT * (CAPACITY_WARN_PERCENT / 100)));
  if (capacityPercent(warnJson) >= CAPACITY_WARN_PERCENT && !exceedsCellLimit(warnJson)) {
    ok('警告閾値ちょうどでは、警告は出るが書き込みは中断しない');
  } else {
    fail(`警告閾値付近の判定が想定と違う: ${capacityPercent(warnJson)}%`);
  }
}

// ---------------------------------------------------------------------------
// [7] 打ち消し記録(tombstone)の刈り込み(2026-08-05追加)
//
// 削除のたびにidが増え、無期限に膨らむ設計だった。tombstoneはitemsと同じ
// 50,000文字のセル上限を持つ別の行に入るため、放っておくといずれ同期が
// 書き込めなくなる。上限を超えたぶんを古い方から捨てる。
// ---------------------------------------------------------------------------
console.log('\n[7] pruneTombstoneIds(打ち消し記録の刈り込み)');

{
  const { pruneTombstoneIds, MAX_TOMBSTONES } = await import(
    new URL('../docs/lib/sync.js', import.meta.url)
  );

  const few = ['a', 'b', 'c'];
  if (pruneTombstoneIds(few) === few) {
    ok('上限以下ならそのまま返す(無駄なコピーもしない)');
  } else {
    fail('上限以下で余計な加工をしている');
  }

  const many = Array.from({ length: MAX_TOMBSTONES + 30 }, (_, i) => `id-${i}`);
  const pruned = pruneTombstoneIds(many);
  if (pruned.length === MAX_TOMBSTONES) {
    ok(`上限(${MAX_TOMBSTONES}件)まで減らす`);
  } else {
    fail(`刈り込み後の件数が想定と違う: ${pruned.length}`);
  }
  // 「新しい方を残す」= 配列の末尾を残す。ここが逆だと、直前に削除した
  // 項目の打ち消しが消えてしまい、次の同期で削除がすぐ復活する。
  if (pruned[pruned.length - 1] === `id-${many.length - 1}` && pruned[0] === 'id-30') {
    ok('新しい方(配列の末尾)を残し、古い方から捨てる');
  } else {
    fail(`残した範囲が想定と違う: 先頭=${pruned[0]} / 末尾=${pruned[pruned.length - 1]}`);
  }

  // 刈り込んでもセル上限に十分な余裕があること(そもそもの目的)
  const worstCase = JSON.stringify(
    Array.from({ length: MAX_TOMBSTONES }, () => '123e4567-e89b-12d3-a456-426614174000'),
  );
  const { exceedsCellLimit } = await import(new URL('../docs/lib/sync.js', import.meta.url));
  if (!exceedsCellLimit(worstCase) && capacityPercent(worstCase) < 70) {
    ok(`上限まで貯まってもセル容量に余裕がある(${capacityPercent(worstCase)}%)`);
  } else {
    fail(`刈り込み後もセル容量が厳しい: ${capacityPercent(worstCase)}%`);
  }
}

{
  // mergeStock を通しても刈り込みが効くこと・並びがソートされないこと
  const { pruneTombstoneIds, MAX_TOMBSTONES } = await import(
    new URL('../docs/lib/sync.js', import.meta.url)
  );
  const localTomb = Array.from({ length: MAX_TOMBSTONES }, (_, i) => `local-${i}`);
  const remoteTomb = ['remote-新しい削除'];
  const merged = mergeStock([], [], localTomb, remoteTomb);

  if (merged.tombstoneIds.length === MAX_TOMBSTONES) {
    ok('mergeStock の戻り値も上限まで刈り込まれる');
  } else {
    fail(`mergeStock 後の件数が想定と違う: ${merged.tombstoneIds.length}`);
  }
  if (merged.tombstoneIds[merged.tombstoneIds.length - 1] === 'remote-新しい削除') {
    ok('リモートで新しく増えた削除は残る(ソートされていない)');
  } else {
    fail(`並びがソートされている可能性: 末尾=${merged.tombstoneIds[merged.tombstoneIds.length - 1]}`);
  }
  if (pruneTombstoneIds(merged.tombstoneIds).length === MAX_TOMBSTONES) {
    ok('刈り込みは繰り返し適用しても安定している');
  } else {
    fail('刈り込みが冪等でない');
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? '\n✅ すべて成功しました。' : `\n❌ ${failures} 件失敗しました。`);
process.exitCode = failures === 0 ? 0 : 1;
