# ANKI出力ツール Web版

スマホのブラウザから単語カードを生成し、`.apkg` をダウンロードして
AnkiMobile / AnkiDroid に取り込むための静的Webページ。サーバーは不要で、
すべてブラウザ内で完結する。

## 構成

```text
docs/
  index.html            画面
  style.css             スタイル(ダーク/ライト両対応)
  app.js                UI・ストック管理(localStorage)
  lib/
    gemini.js           Gemini API 呼び出し(gemini_client.py の Web 版)
    guid.js             genanki.guid_for() と同一の guid 生成
    apkg.js             .apkg の組み立て(sql.js + JSZip)
  shared/               ← デスクトップ版と共有する資産(自動生成あり)
    word_card_prompt.txt  単語カード生成プロンプト(Python も同じものを読む)
    card_defs.json        ノートタイプ定義(自動生成)
    anki_schema.json      Anki の SQLite スキーマ(自動生成)
```

`shared/` に置いているのは、GitHub Pages が `docs/` 配下しか配信しないため。
リポジトリ直下に置くと Web 版から `fetch()` できない。

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

## 互換性の検証(変更したら必ず実行)

Anki は guid が同じノートを「同一ノート」として更新する。Web 版と
デスクトップ版で guid やフィールドの並びが食い違うと、同じ単語のカードが
二重に作られ、**既存カードの学習履歴が失われる**。

`docs/` 配下を変更したら必ず次を通すこと。

```sh
cd tools
npm install     # 初回のみ
npm test        # 下記2つをまとめて実行
```

| コマンド | 内容 |
| --- | --- |
| `npm run verify` | 同じ入力からデスクトップ版(genanki)と Web 版それぞれで `.apkg` を作り、guid・フィールド・カード構成・ノートタイプ定義を突き合わせる |
| `npm run test:ui` | jsdom 上で `index.html` + `app.js` を実際に動かし、単語入力 → AI生成 → 一覧 → プレビュー → apkg 出力 → 削除 の通し動作を確認する(Gemini API はモックするのでキー・割り当てを消費しない) |

`npm run test:ui` は Gemini を呼ばないため、**実際の Gemini が期待どおりの JSON を
返すか**は確認できない。そこだけは実機での確認が必要。

## 注意

- **API キーをこのリポジトリやページのソースに書かないこと。** リポジトリは
  非公開だが、GitHub Pages で公開したページの JavaScript は誰でも読める。
- 公開用の API キーには「アプリケーションの制限 → ウェブサイト」で
  `https://<ユーザー名>.github.io/*` を設定する。ブラウザは既定の
  Referrer-Policy によりオリジンまでしか送らないため、リポジトリ名を含む
  パスまで指定すると一致せず弾かれる。
- Gemini API キーは他の API と組み合わせた制限ができないため、
  Gemini 用と Cloud Text-to-Speech 用でキーを分ける必要がある。
