# ANKI出力ツール Web版

スマホのブラウザからカードを生成し、`.apkg` をダウンロードして
AnkiMobile / AnkiDroid に取り込むための静的Webページ。サーバーは不要で、
すべてブラウザ内で完結する。

**対応機能**: 単語カード生成 / AIに質問(Grammar Multi、3問生成 + 習熟用4問目) /
習熟用(音読) / DailyConversation(「添削結果」スプレッドシート連携) /
TTS音声の自動埋め込み(Cloud Text-to-Speech APIキーを設定した場合のみ)

## 構成

```text
docs/
  index.html            画面(単語 / AIに質問 / 習熟用(音読) /
                        DailyConversation のタブ構成)
  style.css             スタイル(ダーク/ライト両対応)
  app.js                UI・タブ切り替え・ストック管理(localStorage)
  lib/
    gemini.js           Gemini API 呼び出し(gemini_client.py の Web 版)
    tts.js               Cloud Text-to-Speech 呼び出し + 文分割(tts_core.py の Web 版)
    guid.js             genanki.guid_for() と同一の guid 生成
    apkg.js             .apkg の組み立て(sql.js + JSZip、mediaも埋め込み可能)
    shuujuku.js          習熟用(音読)のContentフィールド組み立て + 続き番号管理
                         (build_shuujuku_v1.py の Web 版)
    sheets.js            Googleログイン(GIS token client)+「添削結果」シートの
                         読み書き(sheets_reader.py / sheets_writer.py の Web 版)
    dailyconv.js         シートの行 → DailyConversation の9フィールドへの変換 +
                         ローカル除外リスト(build_grammar_dailyconv_v1_final.py /
                         daily_pending_exclusions.py の Web 版)
  shared/               ← デスクトップ版と共有する資産(自動生成あり)
    word_card_prompt.txt      単語カード生成プロンプト
    grammar_multi_prompt.txt  Grammar Multi(3問)生成プロンプト
    shuujuku_prompt.txt        習熟用(音読・「AIに質問」の4問目)生成プロンプト
    shuujuku_dailyconv_prompt.txt  習熟用(音読・DailyConversation由来)生成プロンプト
    correction_system_instruction.txt  英文添削の system_instruction
    correction_response_schema.json    英文添削の responseSchema(構造化出力)
    card_defs.json             ノートタイプ定義(自動生成)
    anki_schema.json           Anki の SQLite スキーマ(自動生成)
```

習熟用(音読)タブには直接の入力欄が無く、2つの経路から自動的に候補が
追加される(デスクトップ版と同じ挙動)。

- 「AIに質問」タブで質問を送信すると、Grammar Multiの3問に加えて、同じ質問の
  背景にある文法パターンを音読練習用にまとめた4問目が自動的に追加される
  (`app.js`の`onAiAskGenerate()`を参照)。
- DailyConversationタブで「④ .apkgをダウンロード」すると、実際にカード化
  された行それぞれについて、その添削・解説の背景にある文法パターンを
  まとめた候補が自動的に追加される(2026-07-29追加、`app.js`の
  `generateShuujukuCandidatesFromRows()`を参照。デスクトップ版の
  `_generate_shuujuku_candidates_from_rows`に対応)。

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

各タブのストック一覧には、生成した日時(単語/AIに質問/習熟用は生成時刻、
DailyConversationはシートの「日時」列)が項目ごとに表示される
(2026-07-29追加、`app.js`の`formatDateTime()`/各`render*Stock()`)。

## 出力済みカードのタグ管理・フィルター・リセット(2026-07-29追加)

単語・AIに質問タブは、`.apkg`出力に成功してもカードをストックから削除しない
(習熟用タブは従来通り出力成功時にストックを空にする、こちらは変更なし)。
削除しない代わりに:

- 出力に成功した項目には`exported_at`が付き、一覧に「✓ 出力済み」タグが表示される。
- **`.apkg`の出力対象は、常にストックのうち`exported_at`が付いていない項目
  (=まだ出力していない項目)だけ**になる(`app.js`の`onExport()`)。そのため
  「次に別の単語・質問を生成して出力したら、既に出力済みのカードまで
  もう一度バンドルされてしまう」ということが起きない。生成に失敗した場合は
  `exported_at`が付かないため、次回も出力対象に残る(2段階設計、
  デスクトップ版の`mark_exported`と同じ考え方)。
- 各タブに「出力済みを隠す」チェックボックス(既定ON)があり、出力済みの
  カードを一覧から一時的に隠せる(削除ではないので、フィルターを外せば
  いつでも再表示できる)。
- 「出力済み履歴をリセット」ボタンで、ストック内全項目の`exported_at`を
  消せる(カード自体は削除されない。次回の出力で改めて全件が対象になる)。

DailyConversationタブにも同様の仕組みがあるが、実体はシート側の
「Anki出力済み」列とは別の**ローカル記録**(`dailyconv.js`の
`loadExportedIds`/`addExportedIds`/`clearExportedIds`、localStorageキー
`anki_tool_daily_exported_ids`)。④の「Anki出力済みにする」チェックを
OFFにして出力した場合やシート書き込みが失敗した場合でも、「このブラウザで
少なくとも一度は.apkgに含めて出力した」行を「出力済み(このブラウザで記録)を
隠す」フィルター(既定ON)で見分けられるようにするための保険という位置づけ。
「出力済み履歴をリセット」ボタンはこのローカル記録だけを消し、シートの
「Anki出力済み」列には一切触れない。

**フィルターチェックボックスの状態は永続化される**(`app.js`の
`bindPersistentCheckbox()`、localStorageキー`anki_tool_filter_<チェックボックスの
id>`)。タブ切り替えやページの再読み込みをまたいでON/OFFが保持される。

## TTS音声の自動埋め込み(2026-07-28追加)

「⚙ 設定」の「Cloud Text-to-Speech APIキー」を設定すると、各タブの `.apkg`
出力時に対象フィールドの音声を自動で合成し、`[sound:...]`タグを埋め込む。
**空欄のままなら従来どおり音声無しの `.apkg` を出力する**(他のAI呼び出しと
同じ「未設定なら黙ってスキップ」方針)。

- 対象フィールド: 単語は `Example`、AIに質問(Grammar Multi)と
  DailyConversation は `Answer` + `Example`(デスクトップ版
  `tts_gui.on_notetype_selected()` の既定選択と揃えてある)。
- **音声の分割単位**(2026-07-28に確定):
  - 単語 / AIに質問 / DailyConversation … **フィールド全体で1つのMP3・
    1つの`[sound:]`タグ**。複数文が含まれていても文ごとには分けない。
  - 習熟用(音読) … **例文(`ex-en`)ごとに個別のMP3・タグ**を作り、各例文の
    直下に埋め込む(音読練習で1文ずつ再生したいため。デスクトップ版の
    `generate_shuujuku_sentence_tts_for_collection()` と同じ挿入位置)。
- **デスクトップ版との方式の違い**: デスクトップ版は複数文を「無音を挟んで
  結合し1つの音声にする」方式(`synthesize_with_gaps`)を持つが、これはWAVで
  受け取って結合し lameenc でMP3へ再エンコードする実装で、ブラウザには同等の
  エンコーダが無い。そのためWeb版はデスクトップ版の `gap_seconds <= 0` の
  ときと同じく、フィールドの平文をそのまま1回のTTS呼び出しに渡す
  (文と文の間の無音間隔の調整はWeb版では未対応)。
- 音声名・言語コードの既定値はデスクトップ版の既定(`en-US-Chirp3-HD-Iapetus` /
  `en-US`)と同じ。音量ゲイン(dB)も設定できる(Google Cloud TTSの
  `audioConfig.volumeGainDb`にそのまま渡す)。
- **Gemini用とCloud Text-to-Speech用でAPIキーを分ける必要がある**(下記
  「注意」参照)。
- 実装は `lib/tts.js`(Cloud Text-to-Speech 呼び出し・文分割・エラー分類。
  `tts_core.py`の`call_google_tts`/`split_into_sentences`/
  `_classify_tts_error`に対応)と、`app.js`の`embedTtsAudioIntoItems()`
  (単語・AIに質問)/`embedShuujukuTtsAudio()`(習熟用)が担う。どちらも
  ストックの生item自体は変更せず、`buildApkg()`に渡す直前のコピーにのみ
  音声タグを追記する(再エクスポート時に二重にタグが付くのを防ぐため)。

### テスト再生・日本語除外オプション(2026-07-29追加)

「⚙ 設定」のTTSセクションに以下の2つを追加した。

- **🔊 テスト再生**: 固定の短い2文を現在の音声名・言語コード・音量ゲインで
  合成し、ブラウザ内で再生する。本番の `.apkg` 出力前に設定を耳で確認できる。
  デスクトップ版の「テスト再生」機能と違い、波形表示・0dBクリッピング検出・
  文と文の間隔調整は無い簡略版(理由は上記「デスクトップ版との方式の違い」と
  同じ)。
- **TTSで日本語を含む文を除外する**(既定OFF): AIがプロンプト指示に反して
  日本語混じりのテキストを返してきた場合に備えた保険用オプション。ONにすると、
  単語・AIに質問・DailyConversationタブの音声生成時、文単位で日本語
  (ひらがな/カタカナ/漢字)を含む文をTTS対象から除外する
  (`[sound:...]`タグの追記先であるカード本文自体は変更しない)。
  習熟用(音読)タブの例文音声には効かない(例文はAI生成時点で英日が
  構造的に分離されているため)。

## DailyConversation(スプレッドシート連携、2026-07-29追加)

「添削結果」スプレッドシートを直接読み書きするタブ。デスクトップ版の
DailyConversationタブと同じ4段階の流れをブラウザだけで行う。

```text
① Googleにログイン
② 英文を入力 → AIが添削・採点 → シートに新規行として追記
③ 「Anki出力済み」列が空の行を一覧表示(不要な行はローカルで除外できる)
④ .apkg をダウンロード → 出力した行をシートの「Anki出力済み」列にマーク
```

Googleフォーム→Apps Script経由で追加された行も、そのまま③の一覧に出てくる
(このタブは「添削結果」シートを唯一の実体として扱う)。

### 認証方式(GIS token client)

デスクトップ版はサービスアカウント(JSON秘密鍵)方式だが、**その鍵をブラウザに
置くことは絶対にできない**(鍵を持つ者は誰でもシートを自由に読み書きできる)。
また Google の「ウェブ アプリケーション」型クライアントは認可コード→トークン
交換に client_secret を要求するため、静的サイトだけでは PKCE も完結できない。
そこで client_secret もバックエンドも不要な
**Google Identity Services の token client**(`initTokenClient`)を使う。

- アクセストークンは**メモリ上にのみ**保持する(localStorage には置かない)。
  有効期限は約1時間で、切れたら画面上のボタンから取り直す。リフレッシュ
  トークンはこの方式では発行されない。
- 一度同意していれば `prompt: ''` での再取得は基本的に無操作で通る。
- 要求するスコープは `https://www.googleapis.com/auth/spreadsheets`
  (未出力行の読み取りと、添削結果の追記・Anki出力済みのマークの両方を行うため)。

### 事前準備(初回のみ)

1. Google Cloud Console →「APIとサービス → ライブラリ」で
   **Google Sheets API** を有効化する。
2. 「APIとサービス → 認証情報」で **OAuth クライアント ID** を種類
   「ウェブ アプリケーション」で作成し、**承認済みの JavaScript 生成元**に
   このページのオリジン(例: `https://yoimachihime-tech.github.io`、
   ローカル確認用なら `http://localhost:8000`)を登録する。
   末尾が `.apps.googleusercontent.com` の文字列がクライアントID。
3. OAuth 同意画面が「テスト」ステータスの場合は、自分のGoogleアカウントを
   **テストユーザー**に追加する(でないと同意画面で弾かれる)。
4. Web版の「⚙ 設定 → スプレッドシート」に、クライアントID・
   スプレッドシートID・シート(タブ)名を入力する。

**クライアントIDは秘密情報ではない**ため、APIキーと違い公開ページに置いても
問題ない(設定項目にしてあるのは、コード変更・再デプロイ無しに差し替えられる
ようにするため)。

### 実装上の注意

- **シートの行は削除できない**。`sheets.js` の責務は読み取りと「Anki出力済み」
  列の書き込み・新規行の追記だけ(デスクトップ版の `sheets_reader.py` /
  `sheets_writer.py` と同じ責務分担)。重複行などを一覧から外したい場合は、
  シートを変更せず**行IDをローカル(localStorage)に記録して表示・出力対象から
  除く**(`dailyconv.js`、デスクトップ版の `daily_pending_exclusions.py` と
  同じ考え方)。
- **カテゴリが「誤りなし」の行とID重複行は `.apkg` に含まれない**
  (`dailyconv.processSheetRows()`、正典 `build_grammar_dailyconv_v1_final.py`
  の `process_sheet_rows()` と同一)。一覧では「誤りなし」の行に
  出力対象外である旨のバッジを出している。
- **原文が重複している行の警告表示 + 絞り込みフィルター**(2026-07-29追加):
  同じ「原文」テキスト(trim + 空白圧縮 + 小文字化で正規化)を持つ未出力行が
  複数あると、一覧に「⚠ 重複の可能性」バッジが付く(`app.js` の
  `dailyDuplicateOriginalIds()`。判定は現在表示している全行に対して行う)。
  IDはuuid4で新規採番されるため通常重複しないが、Googleフォーム経由・
  直接入力経由で同じ英文が二重に投稿されるケースがある。一覧上部の
  チェックボックスで「誤りなしを隠す」「重複の可能性がある行のみ表示」を
  切り替えられる(既定は両方OFF=全件表示。表示を絞るだけでシート・
  ローカルの除外登録には一切影響しない)。
- **一覧はスクロール可能**(2026-07-29追加、`.stock` クラス、単語/AIに質問/
  習熟用/DailyConversationの4タブ共通)。件数が増えても画面が際限なく
  縦に伸びないよう、一覧自体を `max-height` + `overflow-y: auto` で
  スクロールさせる。
- **「Anki出力済み」のマークは `.apkg` の生成に成功してから**行う
  (デスクトップ版と同じ2段階設計。失敗した行を出力済みにしないため)。
- 添削の `system_instruction` / `responseSchema` は
  `shared/correction_system_instruction.txt` /
  `shared/correction_response_schema.json` に切り出してあり、
  デスクトップ版(`gemini_client.correct_english_text()`)も同じファイルを読む。
  **これらはGoogleフォーム側の Apps Script の実装と意味的に同一に保つこと**
  (採点基準がズレると、同じシート上でフォーム経由の行とこのアプリ経由の行で
  評価基準が食い違ってしまう)。

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
経由、DailyConversation(`daily`)は`build_grammar_dailyconv_v1_final.py` +
`deck_builder.py`経由と、Python側の生成経路自体がすべて異なる(word は
「1フィールドの正規化値」でguidを作り、grammar_multi は
`topic_key`+`note_index`、shuujuku は `source_kind`+`source_topic`、
daily はシートのID列の生値でguidを作る)。この
ため各カード種別の共有定義には`guid_scheme`(guidの計算方法)・
`due_scheme`(カードのdueの計算方法)・`tags`(ノートに付けるタグ)を
持たせてあり、`docs/lib/guid.js`・`docs/lib/apkg.js`はこれを読んで
種別ごとの分岐をハードコードせずに動く。新しいカード種別を追加する場合も、
この2ファイルを直接編集する必要は基本的にない
(実際 daily の追加時は `tags` を1つ足しただけで、既存3種別のコードは
無変更のまま通っている)。

**DailyConversation(daily)の特殊事情**: Question/Example/ExampleJA/Score
フィールドは、シート1行の複数列から HTML に合成した結果。そのため習熟用と
同じく、`.apkg` を書き出す直前に `docs/lib/dailyconv.js` の
`buildFieldsReadyItems(rows)` で9フィールド分の値を確定させてから
`buildApkg()` に渡す。また現状このカード種別だけがノートにタグ
(`source::gemini_dailyconv`)を持つ。

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
npm test        # 下記6つをまとめて実行
```

| コマンド | 内容 |
| --- | --- |
| `npm run verify` | 同じ入力からデスクトップ版(genanki)と Web 版それぞれで `.apkg` を作り(word・grammar_multi・shuujuku・daily の4カード種別)、guid・フィールド・タグ・カード構成・ノートタイプ定義を突き合わせる |
| `npm run verify:grammar-multi` | Grammar Multi 固有の後処理(日本語指示文と英文の間の改行整形、選択問題の正解記号 `(B)` の付与、choices/whynot/example の HTML 化)が Python 版と一致するかを、生の Gemini 応答 JSON を固定して突き合わせる |
| `npm run test:ui` | jsdom 上で `index.html` + `app.js` を実際に動かし、単語・AIに質問(3問+習熟用4問目)・習熟用(音読)・DailyConversation の各タブで通し動作を確認する(Gemini API・Sheets API・Googleログインはすべてモックするので、キー・割り当て・実データを消費しない) |
| `npm run test:tts` | `lib/tts.js`(Cloud Text-to-Speech 呼び出し・文分割・エラー分類・音声埋め込み)を fetch モックで単体テストする(Text-to-Speech API キー・割り当ては消費しない) |
| `npm run test:gemini` | `lib/gemini.js` の `callGemini()` のエラー処理・リトライ挙動(503 の自動リトライ、429 の既存挙動の回帰確認)を fetch モックで単体テストする |
| `npm run test:sheets` | `lib/sheets.js`(未出力行の取得・添削結果の追記・「Anki出力済み」列のマーク・エラー分類)と `lib/dailyconv.js` のローカル除外リストを fetch モックで単体テストする(実際のスプレッドシートにはアクセスしない) |

`npm run test:ui` は Gemini・Sheets を呼ばないため、**実際の Gemini が期待どおりの
JSON を返すか**・**実際のシートのヘッダーが想定どおりか**は確認できない。
そこだけは実機での確認が必要。

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
