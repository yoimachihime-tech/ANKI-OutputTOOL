// tools/test_due_counter.mjs
// ---------------------------------------------------------------------------
// docs/lib/dueCounter.js(新規カードの位置 cards.due の続き番号)の単体テストと、
// apkg.js の due_scheme="sequence" の採番式の固定。
//
// 2026-08-20、片桐からの報告「1つの質問から作った3問がまとまって出題されず、
// 他の生成カードと同じ出題形式でまとまって出てしまう」への対応。原因は
// **出力のたびに due を0から振り直していた**ことで、別々のバッチのカードが
// Anki側で同じ位置に居座っていた。ここではその再発を防ぐ要点を固定する:
//
//   - 開始番号は出力のたびに件数分だけ進むこと(次のバッチと重複しない)
//   - 進めるのは出力に成功したときだけ(count<=0 では動かない)
//   - 1未満・数値でない値は保存しないこと(0や空文字を保存できてしまうと、
//     次の出力でAnki側の既存カードと必ず衝突する)
//   - due_scheme="sequence" は「開始番号 + ノートの並び順」であること
//
// 【使い方】 cd tools && node test_due_counter.mjs

let failures = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.error(`  ❌ ${m}`); failures += 1; };
const eq = (actual, expected, m) => {
  if (actual === expected) ok(m);
  else fail(`${m} (期待: ${expected} / 実際: ${actual})`);
};

console.log('lib/dueCounter.js(新規カードの位置の続き番号)の単体テスト\n');

// --- 最小限の localStorage(dueCounter.js を読み込む前に用意しておくこと) ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const {
  getNextDue, setNextDue, advanceNextDue, getAllNextDue, DUE_COUNTER_KEYS,
} = await import(new URL('../docs/lib/dueCounter.js', import.meta.url));
const { dueFor } = await import(new URL('../docs/lib/apkg.js', import.meta.url));

console.log('[1] 対象のカード種別');
eq(DUE_COUNTER_KEYS.join(','), 'word,grammar_multi,daily',
  '対象は word / grammar_multi / daily の3種(習熟用はNumの続き番号を使うため対象外)');

console.log('\n[2] 既定値と保存');
store.clear();
eq(getNextDue('grammar_multi'), 1, '未設定なら1から始まる');
eq(setNextDue('grammar_multi', 439), true, '整数は保存できる');
eq(getNextDue('grammar_multi'), 439, '保存した値が読み出せる');
eq(setNextDue('grammar_multi', '500'), true, '文字列の数字も受け付ける(入力欄からそのまま渡せる)');
eq(getNextDue('grammar_multi'), 500, '文字列でも数値として保存される');

console.log('\n[3] 不正な値は保存しない');
store.clear();
setNextDue('word', 100);
for (const bad of [0, -1, 1.5, '', 'abc', null, undefined, NaN]) {
  const label = typeof bad === 'string' ? JSON.stringify(bad) : String(bad);
  if (setNextDue('word', bad) === false) ok(`${label} は拒否する`);
  else fail(`${label} を保存してしまった`);
}
eq(getNextDue('word'), 100, '拒否された場合、元の値は壊れていない');

console.log('\n[4] 出力のたびに件数分だけ進む');
store.clear();
setNextDue('grammar_multi', 439);
advanceNextDue('grammar_multi', 3);   // 3問を出力した
eq(getNextDue('grammar_multi'), 442, '3件出力すると次は442から');
advanceNextDue('grammar_multi', 3);   // さらに3問
eq(getNextDue('grammar_multi'), 445, '続けて出力しても番号が重ならない');
advanceNextDue('grammar_multi', 0);
eq(getNextDue('grammar_multi'), 445, '0件では進まない(出力に失敗したバッチで番号を消費しない)');
advanceNextDue('grammar_multi', -5);
eq(getNextDue('grammar_multi'), 445, '負の件数でも戻らない');

console.log('\n[5] カード種別ごとに独立している');
store.clear();
setNextDue('word', 13310);
setNextDue('grammar_multi', 439);
setNextDue('daily', 3);
advanceNextDue('word', 10);
const all = getAllNextDue();
eq(all.word, 13320, 'word だけが進む');
eq(all.grammar_multi, 439, 'grammar_multi は影響を受けない');
eq(all.daily, 3, 'daily も影響を受けない');

console.log('\n[6] due_scheme="sequence" の採番式(apkg.js)');
const seq = { type: 'sequence' };
eq(dueFor(seq, {}, 0, 439), 439, '1件目は開始番号そのもの');
eq(dueFor(seq, {}, 1, 439), 440, '2件目は開始番号+1');
eq(dueFor(seq, {}, 2, 439), 441, '3件目は開始番号+2(1問=3ノートが連続する)');
eq(dueFor(seq, {}, 0), 1, '開始番号を省略すると1から(Python側のstart_num既定値と同じ)');
// 後方互換(2026-08-20より前の定義を読み込んだ場合)
eq(dueFor({ type: 'index' }, {}, 2, 439), 2, '旧 index 型は開始番号を無視する');
eq(dueFor({ type: 'fixed_zero' }, {}, 2, 439), 0, '旧 fixed_zero 型は常に0');
eq(dueFor({ type: 'field', key: 'num' }, { num: 7 }, 2, 439), 7,
  'field 型(習熟用)は item の値をそのまま使う');

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} 件の不一致がありました。`);
  process.exit(1);
}
console.log('✅ 新規カードの位置の続き番号は正常です。');
