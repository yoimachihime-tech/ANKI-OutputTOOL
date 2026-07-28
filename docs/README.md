# ANKI出力ツール Web版

スマホのブラウザからカードを生成し、`.apkg` をダウンロードして
AnkiMobile / AnkiDroid に取り込むための静的Webページ。サーバーは不要で、
すべてブラウザ内で完結する。

**対応機能**: 単語カード生成 / AIに質問(Grammar Multi、3問生成 + 習熟用4問目) /
習熟用(音読)

## 構成

```text
docs/
  index.html            画面(単語 / AIに質問 / 習熟用(音読) のタブ構成)
  style.css             スタイル(ダーク/ライト両対応)
  app.js                UI・タブ切り替え・ストック管理(localStorage)
  lib/
    gemini.js           Gemini API 呼び出し(gemini_client.py の Web 版)
    guid.js             genanki.guid_for() と同一の guid 生成
    apkg.js             .apkg の組み立て(sql.js + JSZip)
    shuujuku.js          習熟用(音読)のContentフィールド組み立て + 続き番号管理
                         (build_shuujuku_v1.py の Web 版)
  shared/               ← デスクトップ版と共有する資産(自動生成あり)
    word_card_prompt.txt      単語カード生成プロンプト
    grammar_multi_prompt.txt  Grammar Multi(3問)生成プロンプト
    shuujuku_prompt.txt        習熟用(音読・4問目)生成プロンプト
    card_defs.json             ノートタイプ定義(自動生成)
    anki_schema.json           Anki の SQLite スキーマ(自動生成)
```

習熟用(音読)タブには直接の入力欄が無い。「AIに質問」タブで質問を送信すると、
Grammar Multiの3問に加えて、同じ質問の背景にある文法パターンを音読練習用に
まとめた4問目が自動的に習熟用ストックへ追加される(デスクトップ版と同じ挙動、
`app.js`の`onAiAskGenerate()`を参照)。

`shared/` に置いているのは、GitHub Pages が `docs/` 配下しか配信しないため。
リポジトリ直下に置くと Web 版から `fetch()` できない。

プロンプトはPythonの`gemini_client.py`と共有しており、Python側は`open()`で、
Web側は`fetch()`で同じファイルを読む。プレースホルダは`str.format()`ではなく
`{{name}}`形式の単純置換にしてある(format()だとプロンプト内のJSON例の
波括弧を`{{`にエスケープする必要があり、共有ファイルの意味が薄れるため)。

## 動かし方(ローカル)

`file://` で開くとリファラーが送られず API 呼び出しに失敗するため、
必ず HTTP で配信すること。

```sh
cd docs
python -m http.server 8000
# → http://localhost:8000 を開く
```

初回に「⚙ 設定」から Gemini API キーを入力する。キーはこのブラウザの
localStorage にのみ保存され、どこにも送信されない。

## 共有ファイルの再生成

`card_defs.json` / `anki_schema.json` は自動生成物。デスクトップ版の
⚙設定「カード定義」タブでノートタイプを編集したら、次を実行して
Web 版にも反映すること(でないと両者の見た目がズレる)。

```sh
python tools/export_shared_card_defs.py
```

単語(`word`)は`card_defs.json` + `card_def_builder`経由、AIに質問
(`grammar_multi`)は`build_grammar_multi_v1_updated.py` +
`grammar_multi_builder.py`経由、習熟用(`shuujuku`)は`build_shuujuku_v1.py`
経由と、Python側の生成経路自体がすべて異なる(word は「1フィールドの
正規化値」でguidを作り、grammar_multi は `topic_key`+`note_index`、
shuujuku は `source_kind`+`source_topic` の複合キーでguidを作る)。この
ため各カード種別の共有定義には`guid_scheme`(guidの計算方法)・
`due_scheme`(カードのdueの計算方法)を持たせてあり、`docs/lib/guid.js`・
`docs/lib/apkg.js`はこれを読んで種別ごとの分岐をハードコードせずに動く。
新しいカード種別を追加する場合も、この2ファイルを直接編集する必要は
基本的にない。

**習熟用(shuujuku)だけの特殊事情**: Content フィールドは pattern/meaning/
examples/expl/source_label を HTML に合成した結果であり、item の1フィールド
をそのまま流し込むものではない。さらに Num フィールドと due は、出力の
たびに払い出される続き番号(Ankiのソートフィールド衝突を避けるため)に
依存する。そのため他の種別と違い、ストックに貯める item は生の
pattern/meaning/... のままにしておき、`.apkg` を書き出す直前に
`docs/lib/shuujuku.js`の`buildFieldsReadyItems(items, startNum)`で
Num/Content を確定させてから`buildApkg()`に渡す
(`app.js`の`onExportShuujuku()`を参照)。続き番号は`getNextNum()`/
`advanceNextNum()`が localStorage で管理し、apkg生成が実際に成功した
時点で初めて進める(デスクトップ版の`shuujuku_stock.get_next_num()`/
`mark_exported()`と同じ2段階設計)。

## 互換性の検証(変更したら必ず実行)

Anki は guid が同じノートを「同一ノート」として更新する。Web 版と
デスクトップ版で guid やフィールドの並びが食い違うと、同じカードが
二重に作られ、**既存カードの学習履歴が失われる**。

`docs/` 配下を変更したら必ず次を通すこと。

```sh
cd tools
npm install     # 初回のみ
npm test        # 下記3つをまとめて実行
```

| コマンド | 内容 |
| --- | --- |
| `npm run verify` | 同じ入力からデスクトップ版(genanki)と Web 版それぞれで `.apkg` を作り(word・grammar_multi・shuujuku の3カード種別)、guid・フィールド・カード構成・ノートタイプ定義を突き合わせる |
| `npm run verify:grammar-multi` | Grammar Multi 固有の後処理(日本語指示文と英文の間の改行整形、選択問題の正解記号 `(B)` の付与、choices/whynot/example の HTML 化)が Python 版と一致するかを、生の Gemini 応答 JSON を固定して突き合わせる |
| `npm run test:ui` | jsdom 上で `index.html` + `app.js` を実際に動かし、単語タブ・AIに質問タブ(3問+習熟用4問目)・習熟用(音読)タブそれぞれで 生成 → 一覧 → プレビュー → apkg 出力 → 削除 の通し動作を確認する(Gemini API はモックするのでキー・割り当てを消費しない) |

`npm run test:ui` は Gemini を呼ばないため、**実際の Gemini が期待どおりの JSON を
返すか**は確認できない。そこだけは実機での確認が必要。

## 注意

- **API キーをこのリポジトリやページのソースに書かないこと。** リポジトリは
  非公開だが、GitHub Pages で公開したページの JavaScript は誰でも読める。
- 公開用の API キーには「アプリケーションの制限 → ウェブサイト」で
  `https://<ユーザー名>.github.io/*` を設定する。ブラウザは既定の
  Referrer-Policy によりオリジンまでしか送らないため、リポジトリ名を含む
  パスまで指定すると一致せず弾かれる。`localhost` はTLDを持たないため
  ウェブサイト制限には登録できない。ローカル動作確認用に、制限なしの
  開発用キーを別途用意すること。
- Gemini API キーは他の API と組み合わせた制限ができないため、
  Gemini 用と Cloud Text-to-Speech 用でキーを分ける必要がある。
- Gemini APIキーが「前払いクレジット(prepayment credits)」が尽きて
  429を返す場合がある。これは短期のレート制限とは違い待っても回復しない
  (`lib/gemini.js`の`isBillingError`が判定し、専用のエラーメッセージを表示する)。
