# CLAUDE.md — anki_tts_tool

このファイルは、このフォルダ(`anki_tts_tool`)でClaude Codeが作業する際の
引き継ぎ資料です。作業を始める前に必ず読んでください。

## プロジェクト概要

「添削結果」スプレッドシートの内容をAnkiカード化し、Google Cloud
Text-to-Speech(Chirp 3: HD対応)で音声を自動追加するデスクトップGUIツール。
片桐が日常的に使うローカルツールで、Windows上で `ANKI出力ツール.bat` から
`pythonw` 経由で起動する。**2026-07-27に「ANKI出力ツール」へ改称**
(TTS音声追加専用のツールではなくなった実態に合わせたもの。ウィンドウ
タイトル・起動用バッチファイル名・ビルド成果物名を変更。Pythonの内部
クラス名`AnkiTTSApp`は変更していない)。

もともと `anki_tts_gui.py` という1ファイル(約1270行)にGUIとバックエンド処理が
すべて混在していたが、責務ごとに分割済み。**分割後のファイルが正典**であり、
`anki_tts_gui.py`(または `_old_anki_tts_gui.py` にリネームされている場合あり)は
参照用の旧版として残っているだけなので、編集対象にしないこと。

### 全体ワークフロー

```text
① Googleフォームで英文入力 → Apps Script → Gemini API で添削・採点
   (このプロジェクトの範囲外。「添削結果」シートに結果が書き込まれるだけ)
   ※ 2026-07-27〜、DailyConversationタブに直接英文入力する代替経路も追加
     (下記「① Googleフォームを介さない直接入力経路」を参照。Apps Scriptを
     置き換えるものではなく、片桐の選択で使い分けられる並行経路)
② [このソフト] シートの「Anki出力済み」が空の行を読み込み、Ankiデッキを生成
③ [このソフト] TTS音声を追加
④ [このソフト] Ankiに直接インポート、成功した行をシートの「Anki出力済み」にマーク
```

②〜④まで一貫してこのソフト内で完結する。②のカード生成ロジック(ノートタイプ・
デッキ定義)は元々別のclaude.aiチャットで行われていたが、実体はLLMを使わない
機械的な変換処理だったため、`build_grammar_dailyconv_v1_final.py`を移植して
このソフトに組み込んだ(詳細は後述)。

### ① Googleフォームを介さない直接入力経路(2026-07-27追加)

DailyConversationタブに、英文を直接入力してAIに添削・採点させ、「添削結果」
シートに新規行として追記できる機能を追加した(`on_daily_correct_clicked`、
`self.daily_input_text`)。従来のGoogleフォーム経路を置き換えるものではなく、
**並行して使える代替入力経路**という位置づけ(フォーム自体は今後も使える)。

- 実現できた理由: 片桐からApps Script側の実際のコード(`onFormSubmit`→
  `callGeminiForCorrection`→`writeToResultSheet`)の提供を受け、その
  system_instruction・responseSchema(Gemini構造化出力/JSON Mode)を
  そのまま`gemini_client.correct_english_text()`に移植できたため。
  **採点基準を意図的にズラすと、Googleフォーム経由の行とこのアプリ経由の行で
  「添削結果」シート上の評価基準が食い違ってしまうため、
  `CORRECTION_SYSTEM_INSTRUCTION`/`CORRECTION_RESPONSE_SCHEMA`はApps Script側の
  実装と意味的に同一になるよう保つこと**(Apps Script側が変更された場合は
  片桐に確認の上、このコピーも追従させる。position的には
  `build_grammar_dailyconv_v1_final.py`の「正典はclaude.ai側」と同種の
  「正典は別システム側」パターン)。
- `gemini_client.correct_english_text(text, api_key, model)`: 複数文・複数
  段落をまとめて渡しても、Geminiの構造化出力(`responseSchema`が`ARRAY`)が
  文ごとに自動分割して返す(Apps Scriptの「1フォーム送信=1englishText」でも
  結果的に複数行に分かれるのと同じ挙動)。戻り値はcorrections(dictのリスト)で、
  シートへの書き込みは行わない(責務分離)。
- `sheets_writer.append_correction_rows(...)`: correctionsを「添削結果」
  シートに新規行として追記する。ID列はuuid4で新規採番、日時列は
  `valueInputOption="USER_ENTERED"`で書き込むことでApps ScriptのnewDate()と
  同様にシート側で日時として認識される。**列の並びはシートの実ヘッダー行を
  読み取って動的に対応させており、固定の列順を決め打ちしていない**(手元で
  シートの列を並べ替えていても壊れない)。`mark_rows_as_exported`(既存行の
  「Anki出力済み」列のみ書き込む)とは別関数で、互いの担当範囲(新規行追加/
  既存行の特定列更新)には踏み込まない。
- UI側は、追記後に自動で②の「シートから読み込む」処理へ連鎖させていない
  (Sheets API反映タイミングとの競合を避けるため)。片桐が改めて
  「シートから未出力行を読み込んでデッキ生成」ボタンを押す想定。

## ファイル構成と役割

```text
tts_core.py       バックエンドロジック(tkinter非依存)
tts_gui.py        tkinter GUI層(tts_coreを呼ぶだけの薄い層)
sheets_reader.py  スプレッドシートの読み取り専用モジュール(実装済み)
sheets_writer.py  「Anki出力済み」列への書き込み専用モジュール(実装済み)
deck_builder.py   sheets_readerの行データ→genankiデッキ生成の橋渡し(実装済み)
build_grammar_dailyconv_v1_final.py
                  ノートタイプ・デッキ定義の実体(コピー、下記「正典について」参照)
gemini_client.py  Gemini API呼び出しの薄いラッパー(仮実装、実装済み)
shuujuku_stock.py 「習熟用」候補のファイル永続化ストック(実装済み)
build_shuujuku_v1.py
                  「習熟用」ノートタイプ・デッキ定義の実体(コピー、下記「習熟用
                  (ATSU方式)カード生成との関係」参照)
word_stock.py     「単語」候補のファイル永続化ストック(習熟用とは完全に別、実装済み)
daily_pending_exclusions.py
                  DailyConversationの「シート上の未出力行」一覧から、重複などの
                  理由で出力対象外にしたい行IDをローカルに記録するモジュール
                  (2026-07-27追加、実装済み)
build_grammar_multi_v1_updated.py
                  ノートタイプ「Grammar Multi (文法・複数出題形式)」の定義
                  (CSS・カードテンプレート・choice()/whynot_item()/example_en()/
                  example_ja()ヘルパー関数)の実体(コピー、下記「Grammar Multi
                  カード生成との関係」参照)
grammar_multi_builder.py
                  grammar_multi_stockのitem→genankiデッキ生成の橋渡し
                  (2026-07-27追加、実装済み)
grammar_multi_stock.py
                  「AIに質問」タブの候補のファイル永続化ストック(習熟用とは
                  完全に別、2026-07-27追加、実装済み)
build_word_v1.py  「単語」ノートタイプ・デッキ定義の実体(2026-07-27時点では
                  card_defs.jsonの初期シード元としてのみ使用。下記「単語カード
                  生成との関係」参照)
card_defs.py      各タブ出力用ノートタイプ定義(フィールド・テンプレート・CSS)の
                  JSON永続化(⚙設定「カード定義」タブから編集、実装済み)
card_def_builder.py
                  card_defsの定義から動的にgenanki Model/Deckを組み立てる
                  汎用モジュール(実装済み)
tab_notes_state.py
                  各タブが「まとめてノート一覧に出力」した内容を、アプリを
                  再起動しても保持するための永続化モジュール(2026-07-28追加、
                  下記「ノート一覧の永続化」参照)
config.json       APIキー・音声設定などの保存先(平文注意・Git管理対象外)
backup/           自動バックアップされた.apkgの保存先
pending_decks/    各タブの「まとめてノート一覧に出力」が生成する作業用デッキ
                  (タブごとに固定名 <tab>.apkg。④のTTS生成成功時に削除される)
output/           ④のTTS音声生成の最終成果物(Ankiに取り込むapkg)の既定の
                  置き場所。pending_decks/(作業用)とは意図的に分けてある
ANKI出力ツール.bat 起動用バッチファイル(pythonw tts_gui.py を実行)
```

### ノート一覧の永続化(tab_notes_state.py、2026-07-28追加)

「まとめてノート一覧に出力」した内容は、アプリを再起動しても保持される。
④の「TTS音声を生成する」が**成功した時点でノート一覧から消える**
(キャンセル時は消さず、途中状態を保持して再開できるようにする)。

- 作業用デッキの実体は`pending_decks/<tab>.apkg`(タブごとに固定名で上書き)。
  OSのtempフォルダはクリーンアップで消える可能性があるため使わない。
- メタデータ(apkg/出力先/row_map/ストックの出力済みマーク待ち)は
  `tab_notes_state.json`に保存する。対象は
  `PERSISTED_TAB_KEYS`(daily/shuujuku/word/ai_ask)のみで、apkgインポート
  タブは対象外(外部apkgを都度手動で読み込む使い方のため)。
- `AnkiTTSApp._snapshot_tab_output_state` / `_restore_tab_output_state` /
  `_clear_tab_output_state` が入口。タブ切り替え時と起動時に復元される。
- **`run_generate`は開始時点で`generated_apkg_path`と`generated_tab_key`を
  ローカル変数に固定すること**(2026-07-28修正)。TTS生成は数分かかるため、
  完了時に`self.source_tab_var.get()`を読む方式だと、その間に別タブへ
  切り替えられていた場合に無関係なタブのノート一覧を消してしまう。
- **記録されたapkgが実在しない場合は未出力タブと同じ扱いにフォールバック
  すること**(2026-07-28修正)。このフォルダはGoogle Drive同期下にあり、
  `pending_decks/`内のapkgが同期の都合で消えることがあるため、存在確認を
  しないと起動直後に「読み込みエラー」ダイアログが出てしまう。

### tts_core.py

TTS呼び出し、HTML→読み上げテキスト整形、文分割、Ankiコレクションの読み込み・
走査・TTSタグ書き込み、バックアップ管理など、**tkinterに一切依存しない**関数群。

- `generate_tts_for_collection(...)` が実際のTTS書き込みメインループ。
  `log` / `on_progress` / `should_cancel` をコールバックとして受け取る設計なので、
  将来CLI化する場合もこの関数をそのまま呼べばよい。
- **TTS対象フィールドの複数化(2026-07-27)**: 従来の「読み上げ元(Source)」
  「タグ追加先(Target)」という2つの別フィールド選択を廃止し、
  `analyze_targets(col, nt_name, field_indices: list, force_regen, source_transform=None)`
  / `generate_tts_for_collection(col, nt_name, to_process, *, ...)` の2関数とも
  「TTSを適用するフィールドのインデックスのリスト」を受け取る形に変更した
  (読み上げ元とタグ追加先は常に同じフィールドで、そのフィールド自身に
  `[sound:...]`タグを追記する)。`to_process`の要素は`(note_id, field_idx)`の
  ペアになり、1ノートに複数フィールドを指定した場合はフィールドごとに
  独立して「音声済みスキップ」「空欄スキップ」が判定される。生成される
  音声ファイル名も`tts_{note_id}_{field_idx}.mp3`のように`field_idx`を含める
  よう変更した(同一ノートの複数フィールドを処理する際のファイル名衝突を
  避けるため)。
- `export_collection(col, output_path)` は col の状態をapkgとして書き出すだけ。
  ここでは Sheets 側の「Anki出力済み」マークなどは一切行わない(責務外)。
- `load_row_map(path)` / `match_sheet_row_ids(col, note_ids, row_map)`:
  ノートのguidからスプレッドシートの行ID(ID列の値)を逆引きするための関数。
  詳細は下記「row_map.jsonによるスプレッドシート連携」を参照。
- `parse_shuujuku_content_html(content_html)` / `extract_shuujuku_tts_text(content_html)`
  (2026-07-24追加): 習熟用(ATSU方式)ノートの`Content`フィールド(レンダリング済み
  HTML)から、`build_shuujuku_v1.render_item()`が出力するCSSクラス名
  (`pattern-line`/`gloss-line`/`ex-en`/`ex-jp`/`expl-label`/`source-tag`)を頼りに
  正規表現でPattern/Meaning/Examples/Explanation/Sourceを逆抽出する。
  `extract_shuujuku_tts_text`は`examples`のうち英文(`ex-en`)部分だけを`<br>`区切りで
  結合して返す(和訳・パターン名・解説はTTS対象から除外)。
  **`build_shuujuku_v1.py`側のCSSクラス名を変更した場合はこの正規表現も追従が
  必要**(密結合。テストは`test_source_transform.py`相当を参照)。
- `analyze_targets(...)` / `generate_tts_for_collection(...)`にキーワード専用引数
  `source_transform`を追加(2026-07-24): 渡すと、`strip_sound_tags`後・
  `strip_html_for_tts`前のSourceフィールド生テキストに対して適用される。
  習熟用ノートのようにフィールド内に英語例文と日本語(意味・解説)が混在する
  notetype向けに、TTSに渡す前だけテキストを絞り込むためのフック。
  `tts_gui.py`側の`_get_source_transform_for()`が実際の関数を選択する。
- `contains_japanese(text)` / `strip_japanese_sentences(raw_field_text)`
  (2026-07-27追加): `extract_shuujuku_tts_text`が習熟用ノート専用(CSSクラス名
  への依存)なのに対し、こちらはHTML構造に一切依存しない**汎用**の
  source_transform。`split_into_sentences`で文単位に分割し、ひらがな/
  カタカナ/漢字(半角カタカナ含む、`_JAPANESE_CHAR_RE`)を含む文を丸ごと
  除外して`<br>`で再結合するだけ(1文内の部分的な日本語だけを取り除くこと
  はしない)。単語タブの`Example`フィールドのように、そもそも構造的に
  英日混在しない設計のフィールドでも、AIがプロンプト指示に反して日本語を
  混ぜて返してきた場合の保険として使える。`tts_gui.py`の
  `self.exclude_japanese_var`(③のチェックボックス)がONの時だけ、
  `_get_source_transform_for()`がノートタイプ固有の変換(習熟用の
  `extract_shuujuku_tts_text`等、無ければNone)の後段にこれを合成して返す。
- **音量ゲイン(`volume_gain_db`)**(2026-07-27追加): 「TTSの音声が小さい場合が
  ある」への対応。`call_google_tts` / `call_google_tts_wav` / `synthesize_per_sentence`
  / `synthesize_with_gaps` / `generate_tts_for_collection`すべてに
  `volume_gain_db: float = 0.0`引数を追加し、Google Cloud TTSの
  `audioConfig.volumeGainDb`(有効範囲-96.0〜+16.0dB、UIでは-20.0〜+16.0dBに
  絞っている)へそのまま渡す。ローカルでPCM波形を後から増幅するのではなく
  合成時点でGoogle側にゲインを掛けさせる方式にしたのは、クリッピング(音割れ)
  のリスクを避けるため。`tts_gui.py`の`self.volume_gain_db_var`(既定0.0、
  `config.json`の`"volume_gain_db"`キーに保存)が実際の値の起点で、
  ⚙設定「TTS」タブのスライダーと、`on_preview_play_clicked`(試聴)・
  `run_generate`(本番生成)の両方に同じ値が使われる。
- **`split_into_sentences`の見出しラベル結合(2026-07-27修正)**: 「Ex1. ...」
  「2. ...」のような見出しラベル付きの文(DailyConversationの類似表現、単語
  タブのExample等で使われる形式)は、単純な句点区切りだと`"Ex1."`単体が
  1つの「文」として切り出されてしまい、TTS生成時にラベルだけの極小mp3が
  大量発生してAnkiコレクションを圧迫する原因になっていた。`_LABEL_ONLY_RE`
  (英字0〜6文字+数字1〜3文字+句点)にマッチする断片は、次の断片(実際の
  文)に結合してから返すよう修正した。少なくとも1桁の数字を要求している
  ため、"Yes." "No."のような正当な短文をラベルと誤認して結合することはない。
  `synthesize_per_sentence` / `synthesize_with_gaps`はどちらもこの関数を
  内部で使っているため、per_sentence(文ごとにタグを分ける)・結合の
  どちらのモードでも効果がある。
- **習熟用ノートの例文ごと個別TTS+インラインタグ挿入(2026-07-27追加)**:
  「習熟用タブで生成する場合は例文ごとに個別のMP3を作り、タグをその例文の
  直下に配置してほしい」という要望への対応。通常のフィールド全体を1つの
  音声にまとめる/タグをフィールド末尾に追記する方式(`analyze_targets`/
  `generate_tts_for_collection`)とは別に、専用の
  `analyze_shuujuku_sentence_targets(col, nt_name, field_idx, force_regen)` /
  `generate_shuujuku_sentence_tts_for_collection(col, nt_name, field_idx,
  to_process, ...)`を新設した。`to_process`は`(note_id, 例文の連番)`の
  ペア(例文単位、フィールド単位ではない)。生成方式が根本的に異なる
  (Contentフィールドの`<div class="ex-en">...</div>`の内側にタグを
  `re.sub`のコールバックで直接埋め込む、`_SHUUJUKU_EX_EN_RE`を再利用)ため、
  通常のフィールド末尾追記方式では実現できず別関数にした。「音声済み
  スキップ」の判定はノート単位(フィールド全体に`[sound:...]`が1つでもあれば
  そのノートの全例文をまとめてスキップ)。`tts_gui.py`側は
  `nt_name == SHUUJUKU_NOTETYPE_NAME`の場合、②のTTS対象フィールド選択に
  関わらず常にこの専用ロジックを使う(フィールド選択UIはこのノートタイプでは
  実質無視される。②に案内ラベル`self.shuujuku_tts_hint_label`を表示して
  その旨を明示する)。
- **`strip_sound_tags`の汎用化(2026-07-27修正)**: 以前は文字列**末尾**の
  `<br>[sound:...]`しか除去できなかったが、習熟用ノートの例文ごとインライン
  タグ挿入方式(上記)ではタグがフィールドの途中(各`ex-en`divの中)に複数箇所
  現れるため、出現位置を問わず`(<br>)?[sound:...]`を全て除去するよう
  一般化した(`force_regen`時に古いタグ・余分な`<br>`を残さないため)。
  従来の「フィールド末尾にまとめて追記」方式にも問題なく使える(後方互換)。
- **テスト再生用の合成・波形計算関数**(2026-07-27追加、⚙設定「TTS」タブの
  「テスト再生」機能で使用):
  - `TEST_SAMPLE_SENTENCES`: 固定の短い英語サンプル文2つ(文と文の間隔設定を
    耳で確認できるよう意図的に2文)。
  - `synthesize_test_sample_wav(voice_name, language_code, api_key, gap_seconds,
    volume_gain_db=0.0)`: 上記2文を現在の音声・言語・間隔・音量ゲインの設定で
    合成し、常にWAV(LINEAR16)で返す(mp3変換を挟まないのは、そのまま
    `winsound`で再生できるようにするため)。
  - `compute_amplitude_envelope(wav_bytes, buckets=40)`: WAVの生PCMサンプルから
    バケットごとのRMS(実効値)を計算し、0.0〜1.0に正規化したリストを返す。
    **リアルタイムの音声解析(録音デバイスからのキャプチャ)は一切行わない**
    ——再生前に全サンプルから概形を事前計算しておき、再生開始からの経過時間で
    その配列を参照しながらCanvasに描画する方式(多くの音楽プレイヤー・
    波形ビューアが使う手法と同じ)。numpy等の追加パッケージは使わず、標準の
    `wave`/`struct`のみで完結させている。
  - `wav_duration_seconds(wav_bytes)`: 再生時間(秒)を返す。アニメーションの
    経過割合(`elapsed / duration`)の計算に使う。

**変更時の注意**: このファイルに tkinter の import (`import tkinter`, `from tkinter import ...`)
を混ぜないこと。GUI非依存であることがこのファイルの存在意義。

### tts_gui.py

tkinterウィジェットの構築・イベントハンドラ・見た目だけを担当する薄い層。
ロジックは全て `tts_core` の関数を呼び出す形にする。

- **readonly Comboboxのマウスホイール無効化(2026-07-27追加)**: tkinterの
  既定動作では、readonly Comboboxにマウスホバー中にホイールスクロールすると
  選択値が変わってしまう。画面を上下スクロールしただけでノートタイプや
  TTS対象フィールドの選択が意図せず変わる事故を防ぐため、`__init__`で
  `self.bind_class("TCombobox", "<MouseWheel>", lambda e: "break")`を1回
  呼ぶだけで全Comboboxに適用している。クラスバインドなので、後から動的に
  作成されるCombobox(TTS対象フィールドの行、カード定義エディタのテンプレート
  選択等)にも自動的に効く。
- **3ペインレイアウト**(Outlook風): 左=設定列(①入力元/①結果のapkg/②フィールド/
  ③出力・オプション/④実行、縦スクロール)、中央=ノート一覧(#+先頭2フィールドの
  要約)、右=プレビューペイン(選択中ノートの全フィールドを縦に表示、TTS対象
  フィールドには`[TTS対象]`バッジ付き)。下段に進捗バーとログ(トグルボタンで
  折りたたみ可)。
  TTS設定・Gemini API設定は「一度設定したらそのまま」の性質なので、メイン画面
  常設ではなくヘッダーの「⚙ 設定」ボタンから開く独立ダイアログにまとめてある
  (詳細は後述)。
  - ノート一覧・プレビューは各ヘッダーの「隠す」ボタンで縮小できる。縮小中は
    細い縦書きタブが**左側(設定列のすぐ右)にまとめて**残り、クリックで再展開
    (`_toggle_mid_pane` / `_toggle_right_pane`)。縮小するとウィンドウ幅も
    その分だけ狭まり、再表示すると元に戻る(`_pane_layout_refresh`が
    毎回「設定列幅+各ペインの保存幅+余白」の合計から幅とサッシ位置を
    決定的に再計算する方式。差分の足し引きではないので誤差が蓄積しない)。
  - ペインの表示状態・保存幅・ウィンドウサイズは`config.json`
    (`show_notes_pane` / `show_preview_pane` / `notes_pane_width` /
    `preview_pane_width` / `window_geometry`)に保存され、次回起動時に復元される
    (終了時保存は`WM_DELETE_WINDOW`→`_on_close`)。
- 「🔍 カードをプレビュー」ボタン(`on_open_card_in_browser`): **右のプレビュー
  ペインに現在表示されている内容**(`self._preview_source`)を、実際のカード
  テンプレート+CSSで`tts_core.render_card_preview_html`によりHTML化し、
  `tts_core.open_html_preview_window`でAnki風の**タブ・アドレスバー無しの小窓**
  として開く(簡易mustache展開による近似レンダリング)。
  - `self._preview_source`は`{"kind": "note", ...}`(ノート一覧選択時、
    `update_preview`が設定)か`{"kind": "shuujuku", "item": item}`(習熟用
    ストック選択時、`_show_shuujuku_item_preview`が設定)のどちらか。
    ノート一覧が空でも、習熟用ストックを選択していればプレビューできる
    (2026-07-24修正: 以前はノート一覧の選択に固定されていた)。
    shuujuku側は`build_shuujuku_v1.render_item()` + `FRONT_TMPL`/`BACK_TMPL`/
    `BASE_CSS`でレンダリングする(実際に`build_deck()`が生成するのと同じ見た目)。
  - 実装はEdge/Chromeの`--app`モード(`_find_app_mode_browser`が実行ファイルを
    探索)を`subprocess.Popen`で直接起動する方式で、新規の依存パッケージは
    不要(Ankiが内部で使っているのと同じChromiumエンジンなので再現度も高い)。
    見つからない場合は`open_with_default_player`(既定ブラウザでの通常表示)に
    フォールバックする。
- **習熟用(ATSU方式)ノートのプレビュー構造化**(2026-07-24追加): `update_preview`は
  `notetype名 == SHUUJUKU_NOTETYPE_NAME`(定数、値は
  `"ATSU方式 (PDF再現・音読用)"`)かつ`Content`フィールドがある場合、生HTMLの
  代わりに`tts_core.parse_shuujuku_content_html()`でPattern/Meaning/Examples/
  Explanation/Sourceに分解し、`_render_shuujuku_fields_to_pane(parsed)`で描画する。
  これは「習熟用(音読)」タブのストック選択時プレビュー(`_show_shuujuku_item_preview`)
  と**同じ描画ロジックを共有**しており、まとめて出力した後にノート一覧経由で
  確認する場合も、出力前のストックプレビューと同じ見た目(フィールド構成が
  一目でわかる形)になる。**理由**: 「まとめて出力」直後にノート一覧へ現れる
  カードの`Content`が生HTMLのまま表示され、フィールド構成・内容が分かりづらい
  という指摘への対応。
- **習熟用ノートのTTS対象を英文例文のみに限定**(2026-07-24追加):
  `_get_source_transform_for(nt_name)`が`nt_name == SHUUJUKU_NOTETYPE_NAME`のとき
  `tts_core.extract_shuujuku_tts_text`を返し、`on_dry_run_clicked`/`run_generate`
  経由で`analyze_targets`/`generate_tts_for_collection`の`source_transform`引数に
  渡される。**理由**: `Content`フィールドには英語例文だけでなく日本語(Pattern名・
  Meaning・和訳・Explanation)も混在しており、そのままTTSに渡すと日本語部分まで
  英語音声で読み上げようとしてしまう懸念への対応。
- **②のTTS対象フィールドは複数選択・可変(2026-07-27変更)**: 従来あった
  「読み上げ元(Source)」「タグ追加先(Target)」という2つの別フィールド選択は
  廃止した(読み上げ元とタグ追加先は常に同じフィールドで良いという指示による。
  `tts_core.py`の項も参照)。代わりに`self.tts_field_vars`(`tk.StringVar`の
  リスト)で複数フィールドを選択でき、`self.tts_fields_frame`内に1フィールド
  1行のComboboxとして表示される。「＋ フィールドを追加」ボタン
  (`_add_tts_field_row`)で行を増やし、各行の「－」ボタン(`_remove_tts_field_row`。
  最後の1行は無効化され0件にはできない)で減らせる。`on_notetype_selected`が
  ノートタイプ切替時の既定値を決める: `Answer`と`Example`の両方があれば
  その2つ(Grammar DailyConversationでの主な使い方に合わせ、「類似表現」の
  Exampleフィールドも既定でTTS対象にする)、どちらも無ければ先頭フィールド。
  行のUI再構築は`_rebuild_tts_field_rows`が毎回`self.tts_field_vars`から
  作り直す(差分更新ではない)。「🔊試聴」(`on_preview_play_clicked`)は
  複数フィールド選択時でも先頭のフィールドのみを対象にする(簡易実装)。
  デフォルト候補には`Content`も追加してある(習熟用ノート用、後述)。
- **習熟用ノートは②のフィールド選択を無視する(2026-07-27追加)**:
  `on_dry_run_clicked`/`run_generate`は、`nt_name == SHUUJUKU_NOTETYPE_NAME`
  の場合、②で何が選択されていても常に`tts_core.analyze_shuujuku_sentence_
  targets`/`generate_shuujuku_sentence_tts_for_collection`(Contentの
  例文ごとに個別MP3+インラインタグ、詳細はtts_core.pyの項を参照)を使う。
  この専用ロジックが動いていることを片桐に伝えるため、②に警告色の案内
  ラベル`self.shuujuku_tts_hint_label`を表示し、`on_notetype_selected`が
  ノートタイプに応じて`grid()`/`grid_remove()`で表示を切り替える。
- **`load_fields`が0件のapkgを読み込んだ場合の`notetype_var`クリア
  (2026-07-27修正)**: 以前は、読み込んだapkgにノートが1件も無い場合
  (例: DailyConversationのシート取得結果が全て「誤りなし」/ID重複で
  フィルタされ0件になった場合)、`self.notetype_var`を更新せず**直前に
  選択していた別のノートタイプ名を残したまま**にしていた。そのため例えば
  単語タブで作業した直後にこの状況が起きると、②のノートタイプ選択が
  実際には無関係な「Vocab (単語 v1)」を指したまま残り、④のTTS生成が
  誤ったノートタイプ・ストックに対して走ってしまう可能性があった
  (「DailyConversationのTTS生成でストックの単語が意図せず出力済みになった」
  という報告の一因と考えられる)。`names`が空の場合は`self.notetype_var.
  set("")`で明示的にクリアするよう修正し、`on_dry_run_clicked`/
  `run_generate`側にも`nt_name`が空文字の場合の明示的なエラー
  (「ノートタイプが選択されていません」)を追加した(以前は`col.models.
  by_name("")`がNoneを返し、その後の`nt["flds"]`で分かりにくい
  `TypeError`になっていた)。
- 見た目には `sv-ttk`(Windows 11 Fluent風の丸みのあるダーク/ライトテーマ)を採用。
  未インストールでも動作するようフォールバックあり(`SV_TTK_AVAILABLE`判定)。
- テーマ(ダーク/ライト)切り替えは、⚙ 設定ダイアログの「全般」タブにある
  Radiobutton(`self.theme_var`にvalue="light"/"dark"で直接バインド)から行う
  (2026-07-27にヘッダーの🌙/☀ボタンから移動。他の「一度設定したらそのまま」
  項目と同じ理由)。選択は`command=self.on_theme_setting_changed`で即座に
  `_apply_theme`/`_apply_titlebar_theme`/`_style_text_widgets`を呼んで反映し、
  `config.json`の`"theme"`キーに保存されて次回起動時に復元される
  (以前の「ヘッダーのボタンを押すたびに反転」という`on_toggle_theme`の実装は、
  Radiobuttonがcommand実行前に既に`theme_var`をセットしてくれるため不要になり、
  `on_theme_setting_changed`に置き換えた)。
  - Windowsのタイトルバーもテーマに連動する(`_apply_titlebar_theme`。
    DWM APIの`DwmSetWindowAttribute`属性20/19をctypesで直接呼ぶ。失敗時は無視)。
  - `tk.Text`(ログ・プレビュー)はttkテーマ対象外のため、`_style_text_widgets`で
    配色を手動同期している。新しく`tk.Text`を足す場合はここに登録すること。
- `tkinterdnd2` はドラッグ&ドロップ用(任意)。`lameenc` はMP3圧縮用(任意)。
  どちらも未インストールで動作するようフォールバックがあるので、
  必須依存にしないこと。

**変更時の注意**: このファイルに新しいバックエンドロジック(TTS呼び出しの
リトライ処理など)を直接書かないこと。`tts_core.py` に足してからimportする。

- 「① 入力元を選択」セクション(画面最上部): タブ切替式、**5タブ**。入力源が
  増えてもタブを追加するだけで済むように設計している(どのタブで生成しても
  結果は`self.apkg_path`に集約され、②以降は共通)。
  - **タブ選択は固定ヘッダー**: `ttk.Notebook`ではなく、タブ選択ボタン
    (`_source_tab_buttons`)を左ペインのスクロール領域(`left_canvas`)の**外**、
    `left_outer`直下の`source_tabbar`に配置し、タブの中身(`_source_tab_frames`
    の5枚のFrame、`self.source_tabs_container`配下)だけをスクロール領域内に
    置く2層構成にしてある。これにより左ペインを下までスクロールしてもタブ
    ボタンは常に見える。`_switch_source_tab(key)`が表示切替+選択中タブの
    ボタンを`Accent.TButton`スタイルにするハイライトを行う。
  - **タブの並び順**(`self._source_tab_labels`の辞書順=表示順、2026-07-24に
    「出力導線が分かるように」との指示で並べ替え済み、2026-07-27に`word`を
    `shuujuku`の直後へ追加):
    `daily`(DailyConversation)→`ai_ask`(AIに質問)→`shuujuku`(習熟用、
    前の2つが供給元)→`word`(単語、独立したAI生成→ストック→まとめて出力の
    流れを持つが習熟用とは無関係)→`apkg_import`(独立した手動経路)。
  - **DailyConversationタブ**(実装済み): 「シートから未出力行を読み込んで
    デッキ生成」ボタン(`on_fetch_from_sheet_clicked`。`self.fetch_sheet_btn`、
    生成中は無効化+「読み込み中...」表示になる)と「エクスポート後、対応する
    行をAnki出力済みにする」チェック(`self.sheets_update_var`)だけが
    このタブにある。スプレッドシートID・シート(タブ)名(`self.sheets_
    spreadsheet_id_var` / `self.sheets_sheet_name_var`)自体は「一度設定したら
    そのまま」の項目のため、2026-07-27に「⚙ 設定」ダイアログの
    「スプレッドシート」タブへ移動した(下記「設定ダイアログ」参照。このタブ
    には案内文言だけが残っている)。ボタンを押すと`sheets_reader.
    fetch_pending_rows`が未出力行を取得→`deck_builder`でデッキ生成→一時.apkgに
    書き出して`self.apkg_path`に自動セットし、guid対応表を`self._current_row_map`
    にメモリ保持する(row_map.jsonファイルは経由しない)。
    続けて`_generate_shuujuku_candidates_from_rows`が、実際にデッキへ採用された
    行(row_mapに含まれる行)ごとに自動でGemini APIを呼び、習熟用ストックへ
    候補を追加する(Gemini APIキー未設定なら黙ってスキップ)。**Gemini呼び出しは
    行ごとに直列で、数秒〜十数秒かかることがある**ため、デッキ生成完了のログ
    (「①以降に読み込みました」)が出た直後に習熟用タブを確認しても、まだ
    候補が反映されていないことがある(生成完了時に`messagebox.showinfo`で
    追加件数を通知するので、それを待つこと)。
    - **候補が0件のときの挙動**(2026-07-27に「読み込んでも習熟用タブに
      追加されない」と報告された挙動への対応): `process_sheet_rows()`
      (`build_grammar_dailyconv_v1_final.py`)は「誤りなし」カテゴリの行・
      ID重複行をデッキから除外する仕様のため、取得した行が全てそれに
      該当すると`row_map`に1件も入らず、習熟用候補の生成対象
      (`target_rows`)も0件になる(そもそも「誤りの背景にある文法パターン」を
      抽出する機能なので、誤りが無い行は対象外というのは仕様として妥当)。
      以前はこの場合`_generate_shuujuku_candidates_from_rows`が無言で
      returnしており、なぜ増えないのか分からなかった。現在はログに理由
      (「取得した行はすべて『誤りなし』またはID重複などの理由でデッキから
      除外されたため」)を出力する。また、対象行はあってもGemini呼び出しが
      **全件失敗**した場合(APIキー・モデル名の設定ミス、プロンプト精度の
      問題など)もログだけだと見落としやすいため、`messagebox.showwarning`
      でも通知するようにした。
    - **英文の直接入力(2026-07-27追加)**: シート読み込みボタンの下に区切り線
      を挟んで、英文を直接入力できるテキストボックス(`self.daily_input_text`)
      +「AIに添削させてシートに追加」ボタン(`on_daily_correct_clicked`)を
      追加した。Googleフォームを介さず、`gemini_client.correct_english_text()`
      で添削・採点させた結果を`sheets_writer.append_correction_rows()`で
      「添削結果」シートに新規行として追記する(詳細は各モジュールの項を参照)。
      複数文・複数段落をまとめて入力してよい(Gemini側が自動で文ごとに分割)。
      **2026-07-27に「Googleフォームはもう使わずこちらをメインで使う」運用へ
      切り替えたのに合わせ、追記成功後は自動的に②の`on_fetch_from_sheet_
      clicked`(シートから未出力行を読み込んでデッキ生成)まで連鎖実行する
      よう変更した**(以前は「Sheets APIの反映タイミングとの競合を避ける」
      理由で自動連鎖させず、片桐が改めてボタンを押す設計だったが、
      「確認導線が上下バラバラになる」との指摘を受けての変更。Sheets APIの
      追記は基本的に読み取り直後から反映されるため、通常は問題ない想定)。
    - **シート上の未出力行の確認用一覧(2026-07-27追加)**: 単語/AIに質問と
      同じ「生成した内容をすぐ確認したい」ニーズへの対応。ただし
      DailyConversationの候補の実体はローカルのストックファイルではなく
      「添削結果」シート自体(Anki出力済み列が空の行)なので、ローカルに
      複製せず`sheets_reader.fetch_pending_rows()`の結果をそのまま
      `self.daily_pending_listbox`に表示する(`refresh_daily_pending_view`)。
      ネットワークアクセスが要るため起動時には自動実行せず、「更新」ボタン
      または`on_daily_correct_clicked`の追加成功時にのみ取得する。選択時は
      `_render_daily_row_preview`で原文・添削後・解説・カテゴリ・類似表現・
      スコアを右のプレビューペインに表示する(実カードテンプレートでの
      レンダリングは行わない。deck_builder経由のノート化が必要になり
      この簡易確認用一覧の範囲を超えるため、`_preview_source`は更新しない
      = 「🔍 カードをプレビュー」ボタンはこの一覧の選択には対応しない)。
      永続化はシート側の「Anki出力済み」列が唯一の実体のため、ソフトを
      再起動しても自然に一覧へ復元される(ローカルの状態は一切持たない)。
      **選択項目を削除(2026-07-27追加)**: Googleフォーム経由・直接入力経由で
      同内容が重複してシートに追加されてしまった場合などに、一覧から選択して
      「削除」できるようにした(`on_delete_selected_daily_pending_item_
      clicked`)。ただし「添削結果」シート自体は`sheets_reader.py`(読み取り
      専用)・`sheets_writer.py`(「Anki出力済み」列書き込みと新規行追記のみが
      責務)のどちらからも直接削除できないため、実体はシートの削除ではなく
      **`daily_pending_exclusions.py`(新設)による行IDのローカル除外登録**。
      `refresh_daily_pending_view`のシート再取得時、および`on_fetch_from_
      sheet_clicked`(②のデッキ生成)の両方で`daily_pending_exclusions.
      filter_out_excluded()`を通すため、削除した行は一覧表示からもデッキ
      生成対象からも外れる(シート上のデータそのものは一切変更されない)。
  - **AIに質問タブ**(実装済み・仮実装、**2026-07-27に出力先変更**): 質問を
    入力して「AIに生成させる(3問セットを生成)」を押すと、`gemini_client.
    generate_grammar_multi_items_from_question`がGemini APIで独立ノート3件分
    (出題形式を分散: 選択問題/誤り訂正問題/記述式・書き換え問題が基本)を生成し、
    その場でapkgは作らず**grammar_multi_stock(独立ストック)に追加するだけ**
    (`on_ai_ask_clicked`)。実際のTTS→Anki出力は、このタブ自身の
    「まとめてGrammar Multiとして出力」(`on_export_grammar_multi_stock_
    clicked`)で行う(単語/習熟用タブの「まとめて出力」と同じ2段階設計:
    ④のapkg出力が実際に成功するまで`mark_exported`を呼ばない)。
    **以前はshuujuku_stock.json(習熟用/ATSU方式、音読練習用)に追加していたが、
    「習熟用タブに飛ぶ内容と同じでダブっている」との指摘を受けて変更した**。
    習熟用は「音読による習熟」、Grammar Multiは「知識を深める」出題形式
    (選択問題・誤り訂正問題・記述式)であり目的が異なるため、詳細は下記
    「Grammar Multiカード生成との関係」を参照。
    **生成済み一覧(2026-07-27追加)**: `self.ai_ask_listbox`が
    `grammar_multi_stock.get_pending()`の全件をそのまま表示する
    (以前のshuujuku_stock.jsonをsource_key[0]=="chat"で絞り込む方式と違い、
    このストックの中身は全てこのタブ由来のため絞り込みは不要)。選択時の
    プレビュー(`on_ai_ask_item_selected`→`_show_grammar_multi_item_preview`)・
    「選択項目を削除」(`on_delete_selected_ai_ask_item_clicked`→
    `grammar_multi_stock.remove_pending_at`)も専用実装を持つ。
    永続化(ソフト再起動しても保持)・出力済み管理はgrammar_multi_stock.py側
    完結のため、他のストックと同様「apkg出力するまでは消えない」。
  - **習熟用(音読)タブ**(実装済み・仮実装): 下記「習熟用(ATSU方式)カード生成
    との関係」を参照。タブボタン自体に現在のストック件数がバッジ表示される
    (`refresh_shuujuku_stock_view`が`self._source_tab_buttons["shuujuku"]`の
    テキストを「習熟用(音読) (N)」のように更新)。ストック一覧
    (`shuujuku_listbox`。選択すると`on_shuujuku_item_selected`→
    `_show_shuujuku_item_preview`で右のプレビューペインにPattern/Meaning/
    Examples/Explanation/Sourceを表示する)・「まとめて習熟用として出力」
    (`on_export_shuujuku_stock_clicked`。`build_shuujuku_v1.build_deck()`で
    一時.apkgを生成し`self.apkg_path`にセット。**`shuujuku_stock.mark_exported`は
    ここでは呼ばない(2026-07-27変更)**。デッキの骨組み(音声無し)を作った
    段階でストックから消してしまうと、②③④(TTS生成・apkg出力)を完了しない
    まま片桐がアプリを再起動した場合に、実際にAnkiへ取り込めたのか・候補が
    消えてしまっただけなのか区別が付かなくなる(「どこまでカード出力が
    進んでいるか分からなくなる」)という指摘への対応。代わりに
    `self._pending_shuujuku_stock_items`に候補を保持しておき、`run_generate`が
    `tts_core.export_collection`(④の実際のapkg出力)まで成功した時点で
    初めて`mark_exported`を呼ぶ。`_set_apkg_path`は(このタブ経由に限らず)
    別のapkgに切り替えるたびにこの保留変数をクリアするため、④を経ずに
    別の入力元へ切り替えた場合は、候補はストックに残ったままになる
    (`self.apkg_path`自体はconfig.jsonに保存されず再起動で消えるが、それでも
    候補はストック側に残っているため、改めて「まとめて出力」からやり直せる)。
    **安全策(2026-07-27追加)**: 「DailyConversationのTTS生成でストックの
    単語が意図せず出力済みになった」という報告を受け、`self._pending_
    shuujuku_stock_items`(および`self._pending_word_stock_items`)の値を
    `(その時点のapkg_path, items)`のタプルに変更した。`run_generate`は、
    今回処理したapkg_path(実行開始時に`generated_apkg_path`としてローカル
    変数に固定)がこの記録と完全一致する場合だけ`mark_exported`を呼ぶ。
    `_set_apkg_path`のクリアだけでも通常は十分なはずだが、万一クリア漏れ・
    タイミングのズレがあっても、apkg_pathの完全一致を追加の必須条件にする
    ことで誤って無関係なストックを出力済みにしないようにする二重の安全策。
    ボタン文言は2026-07-24に
    「まとめて習熟用として出力(下の①に自動入力)」から「まとめて習熟用として出力」
    へ修正済み — apkg欄が独立した「① 結果のapkg」セクションとして下に
    存在した頃の文言が、apkgインポートタブへの統合後も残っていたため)・
    「選択項目を削除」(`on_delete_selected_shuujuku_item_clicked`、
    2026-07-27追加。一覧で選択した1件だけを`shuujuku_stock.remove_pending_at`で
    削除する。重複していても常に追加する仕様に変更したため、⚠表示されている
    不要な重複をここから間引く用途)・「ストックをクリア」
    (`on_clear_shuujuku_stock_clicked`。出力済みにはせず全件破棄、要確認ダイアログ)。
  - **単語タブ**(実装済み、2026-07-27追加): 下記「単語カード生成との関係」を
    参照。UI構造・ハンドラ名は習熟用(音読)タブとほぼ同じパターン(入力欄→
    「AIに生成させる」→ストック一覧→「まとめて単語カードとして出力」)だが、
    **`word_stock.py`(word_stock.json)という完全に別のストックファイルを使い、
    `shuujuku_stock.py`には一切書き込まない**(片桐の明示的な指示)。
    入力は`self.word_pairs_text`(複数行テキスト)。**2026-07-27に単語1件ずつの
    入力から、「単語 | 文脈」ペアを複数行まとめて入力できる形に変更**した
    (読書中に複数の未知語をまとめて調べたいニーズへの対応)。1行1件、
    `_parse_word_pairs`が`|`区切りでパースする(`|`が無ければ文脈は空文字、
    空行はスキップ)。**文脈は完全な英文である必要はない**(句動詞や単語の
    組み合わせのみでもよい。空欄も可。この方針は`gemini_client.py`の
    プロンプト内でも明記してあり、AIが無理に1つの完全な文として解釈しよう
    としないようにしてある)。`on_word_generate_clicked`が各ペアについて
    順番に`gemini_client.generate_vocab_card_from_word`を呼び(DailyConversation
    の複数行処理と同じ、直列でのAI呼び出しパターン)、生成できたものを
    まとめて`word_stock.add_pending_items`でストックに追加する。**全件成功
    した場合だけ**入力欄をクリアする(一部失敗時は、どの行が失敗したか
    片桐が見て判断できるよう入力内容を残す)。対象行が全件失敗した場合は
    `_generate_shuujuku_candidates_from_rows`と同様に`messagebox.showwarning`
    で通知する。**生成には成功したのに追加件数が0件になるケース
    (2026-07-27、片桐から「AIに生成させるボタンを押して成功してもストックに
    上がってこない」と報告)**: `word_stock.add_pending_items`は、正規化した
    単語キー(前後空白除去・小文字化)が既にpendingまたは`exported_keys`
    (過去に出力済み)に存在する場合、黙ってスキップする仕様のため、
    以前一度でも生成・出力したことのある単語を再度入力すると「生成成功」の
    ログが出ても実際にはストックに何も増えない。原因が分からないと
    バグに見えるため、`_generate_shuujuku_candidates_from_rows`と同様に
    ログで通知する対応を入れたが、同日中にさらに「静かにスキップされて
    気づけない」こと自体が問題だという指摘を受け、**重複していても常に
    追加する仕様に変更**した(`add_pending_items`の項は`shuujuku_stock.py`の
    項を参照。単語タブでも「選択項目を削除」ボタン
    (`on_delete_selected_word_item_clicked`→`word_stock.remove_pending_at`)で
    ⚠表示された重複を手動で間引ける)。「まとめて単語カードとして出力」(`on_export_word_stock_
    clicked`)は`card_defs.get_def("word")` + `card_def_builder.build_deck_
    from_def()`で一時.apkgを生成し`self.apkg_path`にセット(下記「単語カード
    生成との関係」のcard_defs移行の項を参照)。**`word_stock.mark_exported`は
    ここでは呼ばない(2026-07-27変更)**。習熟用タブの`on_export_shuujuku_
    stock_clicked`と全く同じ理由・同じ設計で、`self._pending_word_stock_items`
    に候補を保持しておき、`run_generate`が④のapkg出力まで成功した時点で
    初めてmark_exportedを呼ぶ(詳細は習熟用タブの項を参照)。タブボタンの
    バッジ表示・ストック一覧選択時の
    プレビュー(`_show_word_item_preview`/`_render_word_fields_to_pane`)・
    「🔍 カードをプレビュー」対応(`on_open_card_in_browser`の`kind == "word"`
    分岐)も習熟用タブと同じ構成で実装してある。
  - **apkgインポートタブ**(実装済み、2026-07-24追加): 外部(別チャット等)で
    生成された`.apkg`を手動で読み込むための独立タブ。apkg欄(参照/ドラッグ&
    ドロップ)・row_map.json欄・「エクスポート後、Anki出力済みにする」
    チェックがここにある。DailyConversation/習熟用/AIに質問は自前でapkgを
    生成するためこのタブを経由しないので、「apkgファイルを参照する」という
    UIをこの1タブに閉じ込め、他タブをapkg入力に依存させない設計にした。
    apkgを手動選択した場合、同じファイル名で拡張子だけ`.row_map.json`にした
    ファイルが同じフォルダにあれば自動検出してrow_map.json欄に入力する
    (`_set_apkg_path`。このとき`self._current_row_map`はクリアされる)。
  - 「エクスポート後、対応する行をAnki出力済みにする」チェック
    (`self.sheets_update_var`。DailyConversationタブとapkgインポートタブの
    両方に同じ変数へバインドしたCheckbuttonがある): TTS生成→エクスポート
    完了後に`sheets_writer`を呼んで書き戻す(`_update_sheets_export_status`)。
    実書き込み前に必ず確認ダイアログを挟む。row_idsの組み立ては
    `self._current_row_map`(DailyConversationタブでの読み込み時)を優先し、
    無ければ`row_map_path`(apkgインポートタブでの手動指定、下記参照)を使う。
  - `SHEETS_WRITER_CREDENTIALS`環境変数が未設定、またはスプレッドシートIDが
    空なら黙ってスキップする(エラーにはしない)。

**設定ダイアログ**(ヘッダーの「⚙ 設定」ボタン、`_build_settings_dialog` /
`_open_settings_dialog`): 「一度設定したらそのまま」の性質の項目をメイン画面
から追い出し、ワークフロー関連の項目(入力元タブの操作ボタン・②フィールド・
③のチェックボックス類)だけをメイン画面に残すための独立`tk.Toplevel`。
2026-07-27に、それまで縦積みだった2つのLabelFrame(TTS設定/Gemini API設定)を
`ttk.Notebook`によるカテゴリ別の横タブに再構成し、他の画面から以下の項目も
ここへ移動した(現在6タブ、`notebook.add()`の順が表示順)。
**ウィンドウのデフォルトサイズは固定値の決め打ちではない(2026-07-27変更)**:
以前は`480x620`を決め打ちしていたが、横幅の広いTTSタブなどで文字が見切れる
ことがあったため、全タブを組み立てた後に`dlg.update_idletasks()` +
`winfo_reqwidth()`/`winfo_reqheight()`で実際に必要なサイズを計算し、それを
`geometry()`とminsize両方に使う方式に変更した(画面サイズは超えないよう
クランプ)。「カード定義」タブだけ専用のスクロール可能なCanvasに載っている
ため、このタブの内容がどれだけ長くても要求サイズはビューポート分に収まる
(実際の高さはこのタブでは決まらない)。

- **全般**タブ(2026-07-27新設): テーマ(ダーク/ライト)のRadiobutton
  (`self.theme_var`にvalue="light"/"dark"で直接バインド、
  `command=self.on_theme_setting_changed`)。元はヘッダーの🌙/☀ボタンだった
  ものを移動(詳細は上記「見た目には `sv-ttk`」の項を参照)。
- **TTS**タブ: Google Cloud APIキー・言語コード・音声名・文と文の間隔・
  MP3ビットレート・文ごとにタグを分けるか(既存)に加え、2026-07-27に
  「音量ゲイン(dB)」スライダー(`self.volume_gain_db_var`、`ttk.Scale`
  `self.volume_gain_scale`)と「テスト再生」機能(下記参照)を追加。
- **Gemini API**タブ: APIキー・モデル名コンボボックス`gemini_model_combo`・
  「モデル一覧を取得」ボタン(既存)。
- **スプレッドシート**タブ(2026-07-27新設): スプレッドシートID
  (`sheets_spreadsheet_id_var`)・シート(タブ)名(`sheets_sheet_name_var`)。
  元はDailyConversationタブ内にあったが、生成のたびに触るものではないため
  ここへ移動(DailyConversationタブ側には案内文言だけが残る)。
- **出力先**タブ(2026-07-27新設): 出力先パス(`output_path`)の編集用
  Entry+参照ボタン。元は③ 出力・オプション内にあったが、同様の理由で移動。
  ③側には編集不可の現在値表示(ラベル、`textvariable=self.output_path`)
  だけを残し、値そのものは`_set_apkg_path`が apkg選択のたびに自動更新する
  ため、設定ダイアログを開かなくても③を見れば現在の出力先は確認できる。
- **カード定義**タブ(2026-07-27新設): 「単語」タブなどが出力するノートタイプの
  定義(フィールド・カードテンプレート・CSS)をコード編集無しに直接編集する
  ためのタブ。詳細は下記「カード定義エディタ」を参照。他タブと違い縦に長く
  なるため、専用のスクロール可能なCanvasに載せてある。

**テスト再生機能**(⚙設定「TTS」タブ、2026-07-27追加。「TTSの音声が小さい
場合がある」「文と文の間隔も確認したい」という要望への対応):
`on_test_play_clicked`が、現在の音声・言語コード・文と文の間隔・音量ゲインの
設定で`tts_core.TEST_SAMPLE_SENTENCES`(固定の短い2文)を合成し、再生しながら
波形を`self.test_waveform_canvas`(`tk.Canvas`)にアニメーション表示する。

- **再生方式は`winsound`(標準ライブラリ、Windows専用)**。他のプレビュー機能
  (🔊試聴・🔍カードをプレビュー)が使っている`os.startfile`(既定の外部
  プレイヤーを起動するだけ)ではアプリ側が再生開始タイミングを把握できず、
  波形を再生に同期させられないため、この機能に限って`winsound.PlaySound(path,
  SND_FILENAME | SND_ASYNC)`による内部再生に切り替えている。未インストール
  環境向けのフォールバックと同じパターンで`WINSOUND_AVAILABLE`判定を持ち、
  非Windows環境ではボタンを無効化するだけでアプリ自体は起動できる。
- **波形は事前計算+経過時間アニメーション方式**(録音デバイスからのリアルタイム
  解析は行わない): 合成したWAVから`tts_core.compute_waveform_minmax()`で
  バケットごとの最小値・最大値(40バケット、-1.0〜+1.0正規化)を再生前に
  計算しておき、`winsound`で再生開始した`time.monotonic()`を基準に
  `self.after(40, ...)`ループ(`_animate_test_waveform`)で経過時間から
  再生位置の割合を求め、そこまでのバーをアクセントカラーに塗り分ける
  (`_draw_test_waveform`)。再生時間は`tts_core.wav_duration_seconds()`から
  求める(既知の固定値なので、実際の音声デバイス側の遅延・ドリフトは
  考慮していない)。
  - **波形はbipolar表示**(2026-07-27変更。以前はRMSベースの棒グラフ
    だったが、Audacity等の一般的な音声波形ビューアと同じ、中心(0点)を
    挟んで上下に振れる表示に変更した。`compute_waveform_minmax`は
    RMS(実効値)ではなく各バケットの実際のサンプル値の[最小値, 最大値]を
    そのまま返す)。
- **0dBクリッピング検出**(2026-07-27追加): `tts_core.compute_peak_amplitude()`
  で合成音声の最大絶対振幅(0.0〜1.0、1.0=16bit PCMのフルスケール=0dBFS)を
  測り、`tts_core.is_clipped()`(閾値`CLIPPING_THRESHOLD = 0.999`)で
  0dBを超えた(音割れの可能性がある)かどうかを判定する。テスト再生中に
  クリッピングを検出すると、ステータス表示(`self.test_play_status_label`)に
  警告文を出し、波形も警告色(赤系)で描画する(`_draw_test_waveform`の
  `clipped`引数)。
- **音量の自動調整**(2026-07-27追加、「デフォルトで自動的に0dBを超えない
  範囲までゲインを上げたい」という要望への対応): TTSタブの「自動調整」
  ボタン(`self.auto_gain_btn` → `on_auto_gain_clicked`)が
  `tts_core.find_safe_volume_gain_db()`を呼ぶ。この関数は、まずゲイン0.0dBで
  テストサンプルを合成してベースのピーク振幅を測り、目標ピーク
  (0dBFSから既定1.0dBの余裕を持たせた値)まで引き上げるのに必要なゲインを
  20*log10比で計算した上で、実際にそのゲインで合成し直してまだ音割れして
  いれば1dBずつ下げて再検証する(TTSエンジン内部のAGC等により、ゲインと
  実際の振幅の関係が厳密に線形とは限らないための安全策。最大4回試行)。
  結果は`self.volume_gain_db_var`にそのままセットされ、スライダー・
  本番生成(`run_generate`)にも即座に反映される。
- 音量ゲインはローカルでのPCM後処理ではなく、Google Cloud TTSの
  `audioConfig.volumeGainDb`に渡す合成時点のゲイン(上記tts_core.pyの項参照)。
  この設定はテスト再生だけでなく、🔊試聴・本番生成(`run_generate`)にも
  そのまま使われる。
- 再生中に再度「テスト再生」を押した場合は、`winsound.PlaySound(None,
  SND_PURGE)`で前の再生を止めてからやり直す。アプリ終了時(`_on_close`)にも
  同様にpurgeし、進行中の波形アニメーションループ(`self.after`)も
  `_stop_test_waveform_animation`でキャンセルする(ウィジェット破棄後に
  `after`コールバックが発火してエラーになるのを防ぐため)。

- **起動時に1回だけ構築し、`withdraw()`で隠しておくだけ**(閉じるボタン・
  ウィンドウの✕も`destroy`ではなく`withdraw`にしてある)。毎回作り直す設計に
  すると、ダイアログを閉じている間は`self.voice_combo`等のウィジェット参照が
  失われ、`on_fetch_voices`/`on_fetch_gemini_models`などダイアログの外から
  (起動時の自動取得や言語コード変更時のイベントから)呼ばれるコードが壊れる
  ため、この方式にしている。
- Gemini APIキーが設定済みなら、起動時に`on_fetch_voices`と同様に
  `on_fetch_gemini_models(silent=True)`を自動実行する。`config.json`に保存
  されているモデル名が実在しない/廃止されていても、一覧取得時に
  「現在の値が一覧に無ければ先頭を選び直す」ロジック(`on_fetch_gemini_models`
  内)で自動的に有効なモデルへ補正される。

### sheets_reader.py

「添削結果」シートから、**「Anki出力済み」列が空の行だけ**を読み取り専用で
取得するモジュール(`sheets_writer.py`の対)。`fetch_pending_rows(spreadsheet_id,
sheet_name, credentials_path, ...)`が、`build_grammar_dailyconv_v1_final.build_deck()`
がそのまま受け取れる形式(`id`, `original`, `corrected`, `similar_en_list`など)の
dictのリストを返す。書き込みは一切行わない。

- 「類似表現(英文)」「類似表現(解説)」列は`\n`区切りで複数件入っているため、
  行ごとに分割してリスト化する(実データで確認済み)。
- スコア列(文法/自然さ/伝わりやすさ)は文字列の数値なので`int`に変換する。
  空欄の場合は`None`(build_deck側の「4項目揃っていなければScoreを出さない」
  ロジックに対応するため)。

### deck_builder.py

`sheets_reader`が返した行データから、genankiでAnkiデッキを組み立てる橋渡し役。
`build_deck_and_row_map(raw_rows)`が`build_grammar_dailyconv_v1_final.py`の
`process_sheet_rows()` / `build_deck()`を**そのまま呼び出すだけ**で、ノートタイプの
フィールド構成などの内部構造には一切依存しない(下記「正典について」の理由)。
同時に`{genanki.guid_for('dailyconv', id): id}`のrow_mapをメモリ上に作る。

- `genanki` / `build_grammar_dailyconv_v1_final.py`が無い環境でも`tts_gui.py`
  自体は起動できるよう、importは`try/except`で保護してあり
  (`DECK_BUILDER_AVAILABLE`)、実際に「シートから読み込む」を使ったときだけ
  `DeckBuilderError`を投げる(`sheets_writer.py`/`sheets_reader.py`の
  `GOOGLE_API_AVAILABLE`と同じパターン)。

### build_grammar_dailyconv_v1_final.py

ノートタイプ「Grammar DailyConversation (日次英作文添削 v1)」の定義
(CSS・カードテンプレート・9フィールド)と、`process_sheet_rows()` /
`build_deck()`が入った、**genankiによるデッキ生成の実体**。

**正典についての重要な注意**: このファイルの正典(source of truth)は
**claude.ai側のプロジェクト知識ベース**にあり、ここにあるのは2026-07-22時点の
コピー。claude.ai側が更新されても、このローカルコピーは自動同期されない。
そのため、`deck_builder.py`をはじめこのリポジトリの他のコードは、
**`process_sheet_rows()` / `build_deck()`を呼び出す以外の形でこのファイルの
内部構造(フィールド順序・model_id・CSS等)に依存しないこと**。ズレがあった
場合は片桐に正典との差分を確認すること。
guidの計算方法(`genanki.guid_for('dailyconv', シートのID列の値)`)はこの
ファイル内で「変更しないこと」と明記されたルールなので、`deck_builder.py`が
row_map生成に使っても問題ない。

**乖離チェックの手順**(ローカルコピーが正典と一致しているか確認したいとき):

1. 現在のローカルコピーのSHA256(2026-07-22時点):
   `56DC56855D329F0FDC6A2E8DBE8D776F5FA79715BB9E1B737DBBAEC82D8BEC30`
   確認コマンド:
   `Get-FileHash build_grammar_dailyconv_v1_final.py -Algorithm SHA256`
   このハッシュが上と違う場合、ローカルコピーが(意図的か事故かを問わず)
   書き換わっている。git管理外なので、このハッシュが唯一の改変検知手段。
2. claude.ai側の正典と比較する場合: 該当チャットで最新版を出力してもらい、
   `_canon_latest.py` などの名前でこのフォルダに保存して
   `git diff --no-index build_grammar_dailyconv_v1_final.py _canon_latest.py`
   (またはVSCodeの「ファイルの比較」)で差分を確認。差分があれば正典側を
   このローカルコピーに上書きし、このCLAUDE.mdのハッシュ値と日付を更新する。
3. 更新後は `deck_builder.py` 経由のデッキ生成が通ることを確認する
   (`process_sheet_rows()` / `build_deck()` のシグネチャが変わっていた場合は
   `deck_builder.py` の追従が必要)。

### sheets_writer.py

「添削結果」シートへの書き込みを行うモジュール。もともとは「Anki出力済み」列
への書き込みだけだったが、2026-07-27にDailyConversationタブの直接入力機能
向けに新規行の追記も追加した。それぞれの関数は自分が担当する列・操作の範囲外
には一切触れない。

- `mark_rows_as_exported(spreadsheet_id, sheet_name, row_ids, credentials_path, ...)`
  を呼ぶと、ID列から対象行を特定し、「Anki出力済み」列に書き込み時刻
  (`YYYY-MM-DD HH:MM:SS`)を`batchUpdate`で書き込む(他の列には触れない)。
- `append_correction_rows(spreadsheet_id, sheet_name, corrections, credentials_path, ...)`
  (2026-07-27追加): `gemini_client.correct_english_text()`の戻り値(dictの
  リスト)を、Apps Script(`writeToResultSheet`)と同じ列構成でシートに新規行
  として追記する。ID列はuuid4で新規採番、日時列は現在時刻を
  `valueInputOption="USER_ENTERED"`で書き込む(Apps ScriptのnewDate()と同様に
  シート側で日時として認識される)。**列の並びはシートの実ヘッダー行
  (`_fetch_headers`)を読み取って動的に対応させており、固定の列順を決め打ち
  していない**(`_CORRECTION_COLUMN_BUILDERS`がヘッダー名→値の対応表)。
  戻り値は追記した各行のID列の値のリスト。
- 認証は**サービスアカウント**方式のみ(OAuthは未対応)。JSONキーのパスは
  `credentials_path` 引数で渡す。呼び出し側が環境変数
  (`SHEETS_WRITER_CREDENTIALS`)から読んで渡す想定で、このモジュール自体は
  `config.json` や特定の環境変数名に依存しない。`sheets_reader.py`も同じ
  環境変数・同じサービスアカウントJSON(編集者権限)を読み取り専用スコープで使う。
- `dry_run=True` を渡すと実際には書き込まず、書き込み予定の行番号・値を
  `log` コールバックに出すだけ。本番実行前に必ずこれで確認すること
  (`append_correction_rows`も対応)。
- 依存パッケージ: `google-api-python-client`, `google-auth`, `genanki`
  (インストール済み。未インストールの場合は各モジュールが専用の例外を送出)。
- `tts_gui.py`の「スプレッドシート連携」セクションから呼ばれる
  (`_update_sheets_export_status`)。`append_correction_rows`は
  `on_daily_correct_clicked`から呼ばれる。

### gemini_client.py

Gemini API(Generative Language API)への呼び出しをまとめたモジュール。
`tts_core.py`のGoogle Cloud TTS呼び出しと同様、`urllib.request`で直接REST APIを
叩く方式で、公式SDKへの依存は持たない。

- `generate_shuujuku_item_from_row(row, api_key, model)`: DailyConversationの
  シート行から、文法パターンの抽象化・新規例文の創作をGeminiにやらせ、
  `build_shuujuku_v1.build_deck()`向けのitem dictを1つ返す。
- `generate_grammar_multi_items_from_question(question, api_key, model)`:
  「AIに質問」タブの質問文から、Grammar Multi(文法・複数出題形式)の独立
  ノート3件分のitem dictを返す(2026-07-27追加。以前あった
  `answer_question_as_shuujuku_item`は、習熟用ストックとの内容重複を解消する
  ためこの関数に置き換えて削除した。詳細は「Grammar Multiカード生成との
  関係」を参照)。
- `list_gemini_models(api_key)`: `generateContent`に対応しているモデル名一覧
  (`models/`プレフィックスは除去済み)を返す。`tts_gui.py`の「モデル一覧を取得」
  ボタンから呼ばれる(`on_fetch_gemini_models`)。
- どちらもプロンプトでJSON形式での出力を指示し、`_extract_json`で
  (` ```json ` フェンス付きでも)パースする。パース失敗時は`GeminiClientError`。
- **429(レート制限/無料枠上限)時のリトライ**(2026-07-27追加): 実際に
  「無料枠は1日20件まで」のような厳しいモデルで`RESOURCE_EXHAUSTED`が
  頻発したことへの対応。`call_gemini`/`correct_english_text`は内部で共通の
  `_post_gemini_request()`を通しており、429が返るとGoogle側が示す
  `retryDelay`(無ければ既定5秒、上限60秒)だけ待って最大3回リトライする
  (`tts_core.call_google_tts`の3回リトライと同じ考え方)。無料枠の上限は
  「1日あたり」であることが多く、短いリトライでは解決しないことがあるため、
  3回失敗した時点で「レート制限または無料枠の1日あたりのリクエスト数上限に
  達しました」という分かりやすいメッセージの`GeminiClientError`にして
  打ち切る(生のJSONエラーをそのまま見せない)。
- `correct_english_text(text, api_key, model)`(2026-07-27追加): DailyConversation
  タブへの直接入力機能向け。片桐から提供を受けたApps Script
  (`onFormSubmit`→`callGeminiForCorrection`)の`system_instruction`・
  `responseSchema`をそのまま移植した(`CORRECTION_SYSTEM_INSTRUCTION`/
  `CORRECTION_RESPONSE_SCHEMA`)。他の関数と違い、プロンプトでJSON出力を
  「指示」するのではなく、Geminiの`generationConfig.responseMimeType=
  "application/json"` + `responseSchema`(構造化出力/JSON Mode)を使っており、
  `_extract_json`によるフェンス除去は不要(`json.loads`に直接渡せる)。
  `responseSchema`が`ARRAY`なので、複数文・複数段落をまとめて渡しても
  Gemini側が文ごとに自動分割して配列で返す。**採点基準がApps Script側と
  ズレると「添削結果」シート上でGoogleフォーム経由の行とこのアプリ経由の
  行の基準が食い違ってしまうため、system_instruction/responseSchemaは
  Apps Script側の実装と意味的に同一になるよう保つこと**(Apps Script側が
  更新されたら片桐に確認の上、このコピーも追従させる)。戻り値のdictは
  シートへの書き込みは行わない(`sheets_writer.append_correction_rows`の責務)。
- **2026-07-24時点で「仮実装」**: AI APIはGemini APIを暫定選択(Claude APIも
  候補だったが未決定のため保留)。プロンプトの精度・モデル名(既定
  `gemini-2.0-flash`)は今後の調整が前提。
- APIキー(`gemini_api_key`)・モデル名(`gemini_model`)は`config.json`に平文保存
  (既存のGoogle Cloud TTSの`api_key`と同じ方針)。このモジュール自体は
  `config.json`に依存せず、呼び出し側(`tts_gui.py`)が読んで渡す。

### shuujuku_stock.py

「習熟用(音読)」カードの候補(item dict)を、まとめて出力するまでファイルに
貯めておくモジュール。DailyConversationタブ(自動)・AIに質問タブ(手動操作後
自動)の両方から候補が追加され、習熟用タブの「まとめて出力」でまとめて
`build_shuujuku_v1.build_deck()`に渡す。

- 永続化先: このフォルダの`shuujuku_stock.json`(アプリを閉じても保持される。
  2026-07-24時点でのユーザー方針)。
- **重複の扱い(2026-07-27変更)**: 以前は`item['source_key']`
  (`("chat"|"dailyconv", 値)`)を文字列化したものをキーに、現在ストック中・
  過去に出力済み(`exported_keys`、無期限保持)の両方と重複する場合は
  `add_pending_items`が黙ってスキップしていた。しかし「AIによる生成には
  成功したのにストックに増えない」状態が分かりにくく誤解を招く(実際に
  複数回問い合わせを受けた)ため、**重複していても常に追加する**方式に変更。
  代わりに`find_duplicate_pending_indices()`が重複しているインデックスの
  集合を返し、`tts_gui.py`の`refresh_shuujuku_stock_view`が該当行を
  `⚠ [重複]`表示+琥珀色ハイライト(`DUPLICATE_HIGHLIGHT_BG`)にする。
  不要な重複は「選択項目を削除」ボタン(`on_delete_selected_shuujuku_item_
  clicked`→`remove_pending_at(index)`)で1件ずつ手動削除できる
  (出力済みにはせず、単純にpendingから取り除くだけ)。
- **patternの類似度による重複検出(2026-07-27追加)**: 「AIに質問」タブで
  似た内容の質問を言い回しを変えて複数回試した場合など、`source_key`
  (質問文そのもの、またはシート行ID)は互いに異なるのに、AIが生成する
  `pattern`(穴埋め形式の英語パターン)がほぼ同じ内容になり、ATSU方式の
  音読カードとしては実質重複というケースが報告された。
  `find_duplicate_pending_indices()`はsource_key完全一致だけでなく、
  pending内の他の項目と`pattern`(大文字小文字・空白差を無視して正規化した
  もの)が`difflib.SequenceMatcher`比率0.8以上で酷似している場合も重複候補
  として検出するよう拡張した。exact重複と同じ扱いで一覧に⚠表示されるだけ
  (自動削除はしない。黙ってスキップする方式へ戻すと「生成成功なのに
  増えない」問題が再発するため)。
- `get_pending()`で読み取り→呼び出し側が`build_deck()`でapkgを実際に生成
  できた後に初めて`mark_exported(items)`を呼ぶ、という2段階设计にしてある
  (生成に失敗した場合にストックが消えないようにするため)。
- **実装上の注意**: 各関数の`path`引数は`= None`にして関数内で
  `if path is None: path = STOCK_PATH`と解決すること。`path: str = STOCK_PATH`
  のように関数定義時点のデフォルト引数として束縛すると、モジュール読み込み後に
  `shuujuku_stock.STOCK_PATH`を書き換えても(テストでの差し替え等)反映されない
  バグを一度踏んでいる。
- **重要: `shuujuku_stock.json`には2026-07-24時点で片桐の実データが入っている**
  (AIに質問・DailyConversation双方から生成された、未出力の習熟用候補)。
  Claude Codeがこのモジュールをテストする際は、必ず`shuujuku_stock.STOCK_PATH`
  を一時ファイルに差し替えてから行うこと(`tts_core.CONFIG_PATH`の差し替えと
  同様)。このファイルをテストで上書き・削除する事故を過去に2回起こしている。

## row_map.json(外部生成apkgとの互換用フォールバック)

`sheets_reader.py`/`deck_builder.py`が実装される前は、カード生成が別の
claude.aiチャット(`build_grammar_dailyconv_v1_final.py`の`build_deck()`を
手動実行)でしか行えず、genankiのguidが`genanki.guid_for('dailyconv', シートの
ID列の値)`という一方向ハッシュのため、`.apkg`だけからはノート→スプレッドシート
行の対応を復元できないという問題があった。この対応表を`row_map.json`という
サイドカーファイルとして受け渡す設計にしていた(ノートタイプにフィールドを
追加する案は、genankiのmodel_id不整合で既存の学習履歴に影響するリスクが
あるため不採用)。

現在は②のシート読み込みがこのソフト内で完結するため、`self._current_row_map`
でメモリ上に保持でき、row_map.jsonファイルは**不要**になった。ただし、
片桐が今後も別チャット側で`.apkg`を生成する場合に備え、フォールバックとして
`row_map_path`欄と`tts_core.load_row_map` / `match_sheet_row_ids`は残してある。

- **形式**: `{ "<ノートのguid>": "<シートのID列の値>", ... }` という単純なJSON
- **命名規則**: `tts_gui.py`はapkgを手動選択した際、同じ場所にある同名
  (拡張子だけ`.row_map.json`)のファイルを自動検出する。例:
  `foo.apkg` → `foo.row_map.json`

## 習熟用(ATSU方式)カード生成との関係

「習熟用(音読)」カードは、DailyConversationとは別のnotetype/デッキで、
2026-07-24にこのソフトウェアへ**Gemini APIを使った仮実装**として統合済み。

- notetype: ATSU方式 (PDF再現・音読用) / MODEL_ID 1901020103491
  フィールド: Num / Content(1項目=1カード)
- デッキ: 02.単語・MindTips::習熟用(固定)
- 正典ファイル: `build_shuujuku_v1.py`(claude.ai側のプロジェクト知識ベースが本体。
  このフォルダにあるのは2026-07-24時点の参照用コピー。
  `build_grammar_dailyconv_v1_final.py`と同じく「正典はclaude.ai側」という
  位置づけなので、上記の乖離チェックの考え方が同様に適用される)
- 表面と裏面は同一内容(クイズ化しない、答えを隠す設計は一切しない)

**このローカルコピーについての注記**: チャットへの貼り付け時に文字化け
(UTF-8をLatin-1として誤解釈し、さらに一部バイトが消失)しており、機械的な
検証(「元の単語をUTF-8化→特定バイト範囲だけ除去した結果」が実際の文字化け
文字列と一致するか)でMODEL_ID・DECK_ID・デッキ名・notetype名・コード構造は
確定させたが、`PLACEHOLDER_TOKENS`(ハイライト表示用の文法用語リスト)のうち
1項目だけ確度の低い推測が残っている(ファイル冒頭のNOTEコメント参照)。
影響はカード内の下線・ハイライト表示のみで、notetype・デッキ・データ構造には
影響しない。

### 重要な制約: この変換は完全自動化できない(AI呼び出しが必須)

DailyConversationのシート行(または直接入力された質問等)から習熟用カードを
作る際は、以下のAIの判断が毎回必要になる。

1. 解説文から、誤りの背景にある文法パターンを抽象化する
   (例: 「三人称単数の否定はdoesn't」→ pattern: "She doesn't 動詞")
2. その文法パターンを使った、元の文とは別の新しい例文を2〜3個その場で考える
   (シートの「類似表現」列をそのまま examples に流用するのは禁止。
   言い換え文であってパターン練習用の例文ではないため)

`build_grammar_dailyconv_v1_final.py`のときのような「実は機械的変換だった」
ケースとは異なり、これは実際にAI呼び出しが必要なため、`gemini_client.py`を
新設してGemini APIに丸投げする設計にした(詳細は`gemini_client.py`の項を参照)。

### 統合後のフロー

```text
DailyConversationタブでの読み込み ─┐
                                    ├→ shuujuku_stock.json(ストック、永続化)
AIに質問タブでの生成 ──────────────┘
                                    ↓
                 習熟用タブ「まとめて出力」
                                    ↓
                 build_shuujuku_v1.build_deck() → 一時.apkg → ①へ自動セット
                                    ↓
                        (以降は②③④⑤、他の入力源と共通)
```

DailyConversation由来のitemの`source_key`は`("dailyconv", シートのID列の値)`、
AIに質問由来は`("chat", 質問文そのもの)`。どちらも`shuujuku_stock.py`の重複防止
キーとして使われ、同じ行・同じ質問から二重に候補が作られることはない。

## 単語カード生成との関係

「単語」タブ(読書中に出会った未学習の英単語をAnkiカード化する機能)は、
2026-07-27にGemini APIを使って統合済み。**習熟用(音読)とは完全に無関係**
(文法パターンの音読練習ではなく単語単体の記憶定着が目的)であり、
`word_stock.py`/`word_stock.json`という専用のストックを使う
(`shuujuku_stock.json`には一切書き込まない。片桐の明示的な指示)。

- notetype: `Vocab (単語 v1)` / MODEL_ID `1907245001123`
  フィールド(8個、この順序): `Word` / `Reading` / `POS` / `Meaning` /
  `Example` / `ExampleJA` / `ExampleBlank` / `Note`
- デッキ: `02.単語・MindTips::単語`(固定、DECK_ID `1785112749312`)
- カードテンプレート2種: 「1. 意味想起(英→日)」「2. 語彙想起(文脈→英単語)」
- 正典ファイル: `build_word_v1.py`。DailyConversation/習熟用と異なり、
  このファイルは「claude.ai側が正典」ではなく、**片桐の実際のAnki上に
  既に存在していたノートタイプを、エクスポートしたapkgから直接読み取って
  複製したもの**(下記「ノートタイプ確認の経緯」参照)。よってズレの心配は
  基本的に無い。
- **2026-07-27追記: 実行時の参照元は`build_word_v1.py`ではなく
  `card_defs.json`(`card_defs.get_def("word")`)に変わった。** `build_word_v1.py`
  自体は、`card_defs.json`が存在しない初回起動時に一度だけ内容をコピーする
  「シード元」としてのみ使われる(`card_defs.seed_default_word_def_if_missing()`、
  `AnkiTTSApp.__init__`から呼ばれる)。以降、`tts_gui.py`の単語タブの出力
  (`on_export_word_stock_clicked`)・プレビュー(`on_open_card_in_browser`の
  `kind == "word"`分岐)はどちらも`card_defs.get_def("word")` +
  `card_def_builder.build_deck_from_def()`経由になっており、**片桐が⚙設定の
  「カード定義」タブでフィールドやテンプレートを編集すると、その内容が
  そのまま次回出力に反映される**(コード変更は不要)。この切り替え時、
  `card_def_builder.build_deck_from_def()`で生成したapkgが
  `build_word_v1.build_deck()`の出力と(model_id・フィールド名・テンプレート・
  CSS・ノートのguid まで)完全一致することを検証済み。

### ノートタイプ確認の経緯(重要な教訓)

片桐から最初に提示されたのは「ANKI Term」という名前の5フィールド
(タイトル/表面/裏面/裏面(例文)/日本語解説)向けの巨大なプロンプトだった。
しかし実際に片桐が「選択中のノート.apkg」としてエクスポートし、
`tts_core.load_collection`で読み込んで中身を確認したところ、
**「ANKI Term」という名前のノートタイプは存在せず**、実際にAnki上で
使われていたのは全く別の`Vocab (単語 v1)`(8フィールド、既にTTS音声タグが
埋め込まれたノートが1件実在)だった。この食い違いを片桐に確認したところ、
`Vocab (単語 v1)`が正しいという回答を得た。

**教訓**: 「既存のノートタイプに合わせて実装してほしい」という依頼を受けた
場合、名称や仕様の伝聞だけを信用せず、可能であれば実際のapkgエクスポートを
読み込んで(`tts_core.load_collection` + `col.models`)フィールド名・
カードテンプレート・CSS・model_id・デッキ名を直接確認すること。
`build_word_v1.py`作成後は、実際に`build_deck()`で生成したapkgを
`tts_core.load_collection`で再度読み込み、元のapkgから抽出した
CSS/テンプレート(qfmt/afmt)/フィールド名と完全一致することを検証してある
(ラウンドトリップ検証。差分があれば`build_word_v1.py`の転記ミス)。

### AI生成プロンプトの設計

`gemini_client.generate_vocab_card_from_word(word, context_sentence, api_key,
model)`が、当初の「ANKI Term」プロンプトのスタイルルール(アスタリスク禁止・
強調は`<b></b>`・半角角括弧禁止・言語分離・`<br>`で改行)を踏襲しつつ、
実際の8フィールド構成に合わせてプロンプトを再設計したもの。`word`フィールドは
AIに生成させず、入力された単語をそのまま使う(表記ゆれ防止のため)。
JSON形式(`_extract_json`と同じ抽出方式)でreading/pos/meaning/example/
example_ja/example_blank/noteの7キーを受け取る。

### ストックの重複の扱い・出力の流れ

`word_stock.py`は`shuujuku_stock.py`と全く同じ設計(2段階の出力フロー、
`path`引数の遅延解決パターン、**重複していても常に追加しハイライト+手動削除で
対応する方式**(2026-07-27変更、詳細は`shuujuku_stock.py`の項を参照)など)を
採用しているが、重複判定キーは単語テキスト(前後空白除去・小文字化)のみを
使う。`card_def_builder.build_guid()`も同じキー生成ロジック
(`genanki.guid_for(card_def["key"], 正規化した値)`。「単語」の場合
`card_def["dedup_key"] == "word"`なので実質`genanki.guid_for('word', 正規化した
単語)`となり、`build_word_v1.build_guid()`と完全に同じ結果になる)を使っており、
同じ単語を複数回生成して出力しても既存ノートの学習履歴を壊さない(重複を
ストックに残す方式に変更しても、guidが同じなのでAnki側では上書き更新される
だけであり問題ない)。

## Grammar Multiカード生成との関係(2026-07-27追加)

「AIに質問」タブの出力先。**習熟用(音読・ATSU方式)とは目的が異なる**
(習熟用は文法パターンの音読による習熟、Grammar Multiは選択問題・誤り訂正
問題・記述式問題による「知識を深める」ための出題)。以前は「AIに質問」の
回答も習熟用ストックに追加していたが、「習熟用タブに飛ぶ内容と同じで
ダブっている」との指摘を受け出力先を分離した。

- notetype: `Grammar Multi (文法・複数出題形式)` / MODEL_ID `1907250010123`
  フィールド(8個、この順序): `Pattern` / `Question` / `Choices` / `Answer` /
  `Example` / `ExampleJA` / `Why` / `WhyNot`
- デッキ: `02.単語・MindTips::文法・用法`(固定、DECK_ID `1907231458999`)
- カードテンプレートは**「1. 判断問題」の1つのみ**(片桐が既にAnki GUI側で
  テンプレート2〜4「セルフチェック/理由想起/例文穴埋め」を削除済みのため。
  以後、正典ファイルもテンプレート1つのみを定義する)
- 正典ファイル: `build_grammar_multi_v1_updated.py`(claude.aiプロジェクト
  「●ANKI出力」側からの2026-07-27時点のコピー。`build_grammar_dailyconv_v1_
  final.py`/`build_shuujuku_v1.py`と同じ「正典は別環境」パターン)。
  CSS・カードテンプレートHTML・`choice()`/`whynot_item()`/`core()`/
  `example_en()`/`example_ja()`ヘルパー関数は記憶から再構築せずこのファイルの
  定義をそのままインポートして使うこと。
  **このファイルはModel定義・CSS・ヘルパー関数のみを提供し、Deck/Noteの
  組み立て(genanki.Deck/genanki.Noteの生成)は呼び出し側の責務**(ファイル末尾に
  「notes_data はこのファイルを流用する各バッチスクリプト側で定義し…」と
  明記されている)。DECK_ID/DECK_NAMEもこのファイル自体には含まれておらず、
  claude.aiプロジェクトのメモリー記録から補った値を`grammar_multi_builder.py`
  側で持つ。

### カード生成ルール(1ノート=1カード、独立ノート3枚が基本)

- 1つの質問から複数の練習問題を作る場合も「1ノートから複数カードを生成する
  方式」は禁止。必ず独立したノートを複数(既定3枚)作成する。
- 3枚は出題形式を分散させる(選択問題/誤り訂正問題/記述式・書き換え問題が
  基本、状況に応じて空所補充等に入れ替えてもよいが3問とも同じ形式にはしない)。
- `Pattern`フィールドには出題形式のラベルのみ(例: 選択問題、誤り訂正問題)。
  文法項目名や正解のヒントになる語は絶対に入れない。`Question`本文も、
  選択肢が出る前に正解を示唆・特定できる書き方をしない。
- 完全な日本語→英語の全文翻訳問題は禁止(パラフレーズのリスクがあるため)。
  多肢選択の穴埋め・誤り訂正形式を優先する。

### 実装

- `gemini_client.generate_grammar_multi_items_from_question(question, api_key,
  model)`: 1回のGemini呼び出しで、上記ルールに従った3ノート分のJSON配列を
  生成させ(`_GRAMMAR_MULTI_PROMPT`、構造化出力ではなく他のgemini_client
  関数と同じ「プロンプトでJSON指示+```json フェンス除去」方式)、
  `choices`/`whynot`/`examples`は`build_grammar_multi_v1_updated`の
  `choice()`/`whynot_item()`/`example_en()`/`example_ja()`でHTML化してから
  item dictに詰める。各itemは`topic_key`(質問文を正規化したもの)・
  `note_index`(0始まりの通し番号)・`source_key`(`("chat_grammar",
  f"{topic_key}::{note_index}")`)を持ち、同じ質問を再度送信すると3件とも
  同じキーになるため重複検出にかかる(`Pattern`フィールドは出題形式ラベルに
  過ぎず内容の識別に使えないため、`shuujuku_stock.py`のようなpattern類似度に
  よる重複検出はここでは行わない。詳細は`grammar_multi_stock.py`の項を参照)。
- `grammar_multi_stock.py`: word_stock.py/shuujuku_stock.pyと全く同じ設計
  (2段階の出力フロー、`path`引数の遅延解決パターン、重複していても常に追加し
  ハイライト+手動削除で対応する方式)。重複判定キーは`topic_key::note_index`。
- `grammar_multi_builder.py`: `build_grammar_multi_v1_updated.GRAMMAR_MODEL`と
  DECK_ID/DECK_NAMEから`genanki.Deck`を組み立てる橋渡し役
  (`deck_builder.py`/`build_shuujuku_v1.build_deck()`と同じ位置づけ)。
  guidは`genanki.guid_for("grammar-multi-v1", topic_key, str(note_index))`。
  `due`は既存デッキの最終due番号から連番、という運用ルールがclaude.ai側の
  手動生成(サンドボックス実行)では使われていたが、このソフトは毎回新規の
  一時apkgをバッチ生成する設計のため、実際のAnkiコレクションの現在のdue値を
  参照する手段がなく、単純にitemsのリスト順(0始まり)を使う(既存の
  word_stock/shuujuku_stockの出力も同様に単純な連番)。
- `tts_gui.py`の「AIに質問」タブ: `on_ai_ask_clicked`→
  `gemini_client.generate_grammar_multi_items_from_question`→
  `grammar_multi_stock.add_pending_items`。「まとめてGrammar Multiとして
  出力」(`on_export_grammar_multi_stock_clicked`)は単語/習熟用タブの
  「まとめて出力」と同じ2段階設計(`self._pending_grammar_multi_stock_items`
  に`(apkg_path, items)`を保持し、`run_generate`が④のapkg出力に成功して
  初めて`mark_exported`を呼ぶ。apkg_pathの完全一致チェックも同様)。

## カード定義エディタ(⚙設定「カード定義」タブ)

2026-07-27に「各タブが出力するカードタイプ・フィールド情報を、コード編集
無しに直接編集・作成したい」との要望を受けて追加。当初は「単語」タブのみを
対象にしていたが、同日中に「既存のタブに使用されるカードタイプを設定内で
網羅してほしい」との追加要望を受け、DailyConversation・習熟用の定義も
一覧に載せるよう拡張した。ただし**実際に編集して出力に反映できるのは
「単語」のみ**で、DailyConversation・習熟用は`"editable": False`を持つ
**参照専用**の定義として登録してある(単純なフィールド値の詰め替えでは
ない複雑な独自レンダリングロジックを持つため、この汎用ビルダー
(`card_def_builder.py`)経由の出力にはまだ移行していない。詳細は
`card_defs.py`のdocstring参照)。

- **一覧**(`self.carddef_listbox`): `card_defs.list_defs()`をkey順に表示
  (`refresh_carddef_listbox`)。選択すると`on_carddef_selected`→
  `_load_carddef_into_form`でフォームに反映される。起動時に
  `seed_default_word_def_if_missing`/`seed_default_daily_def_if_missing`/
  `seed_default_shuujuku_def_if_missing`(いずれも`AnkiTTSApp.__init__`から
  呼ばれる)が、未登録の定義があればそれぞれの`build_*.py`から一度だけ
  自動シードする。
- **参照専用(`editable: False`)の扱い**(2026-07-27追加): DailyConversation・
  習熟用の定義を選択すると、キー欄の下に赤字の警告
  (`self.carddef_readonly_warning`。「編集して保存しても、このタブの実際の
  出力には反映されません」)が表示され、「保存」ボタン(`self.carddef_save_btn`)
  も無効化される(`_load_carddef_into_form`)。`on_carddef_save_clicked`側にも
  `self._carddef_current_editable`が`False`なら保存を拒否する二重チェックを
  入れてある(ボタン無効化を過信しない防御的な実装)。新規作成・apkg読み込みで
  作った定義は既定で`editable: True`。
- **使用タブの明示**(2026-07-27追加): 「このカードタイプがどのタブの機能に
  属するか分かりにくい」という指摘への対応。一覧の各行に`[○○タブ]`または
  `[未接続]`を付記するほか(`refresh_carddef_listbox`)、フォーム上部のキー欄
  直下にも`self.carddef_tab_usage_label`で同じ内容を表示する
  (`_tab_usage_text_for_key`。`card_def["key"]`が`self._source_tab_labels`の
  キーと一致するかどうかで判定する単純なルックアップ)。
- **フィールド編集**(`self.carddef_fields_text`): 1行1フィールドを
  「Ankiフィールド名 = 内部項目名」というテキスト形式で編集する(Treeview等の
  複雑な行編集UIを避け、テキストのparse/joinだけで済ませる設計)。内部項目名は
  AIが生成するitem dictのキー名(例: 単語なら`word`/`reading`/`pos`...)と
  一致させる必要がある。
- **テンプレート編集**: 1つのノートタイプが複数カードテンプレートを持てる
  (「単語」は2つ)ため、`self.carddef_template_combo`で選択中のテンプレートだけ
  を`self.carddef_template_name_var`/`carddef_qfmt_text`/`carddef_afmt_text`に
  表示する方式。テンプレート切り替え時は必ず`_save_current_template_widgets_
  to_memory()`で編集中の内容を`self._carddef_templates`(メモリ上のリスト)へ
  退避してから次のテンプレートを読み込む(でないと切り替えた瞬間に編集内容が
  失われる)。「保存」を押すまでは`card_defs.json`には書き込まれない。
- **「apkgから読み込む...」**(`on_carddef_import_apkg_clicked`): 片桐が
  「単語」ノートタイプ確認時に手動で行った作業(apkgをエクスポート→
  `tts_core.load_collection`で読み込み→フィールド/テンプレート/CSS/デッキ名を
  直接確認)をGUIから直接できるようにしたもの。実際にノートが存在する
  ノートタイプだけを候補にする(Anki標準の`Basic`/`Cloze`等は apkg に自動的に
  同梱されるが対象外にするため)。候補が複数ある場合は`_ask_pick_from_list`
  (簡易モーダル)で選ばせる。フィールドの内部項目名は、同じキーの既存定義が
  あればそれを引き継ぎ、無ければAnkiフィールド名からキャメルケース→
  スネークケースへの機械的変換で仮の値を入れる(片桐が手直しする前提)。
- **新規作成**(`on_carddef_new_clicked`): `tkinter.simpledialog.askstring`で
  キー名だけ聞き、空のテンプレート1枚を持つ雛形をフォームに読み込む。
  model_id/deck_idは`_generate_new_ids()`(現在時刻ミリ秒ベース)で自動採番。
- キー(`self.carddef_key_var`)は常に読み取り専用Entry。既存の定義のキーを
  誤って書き換えて他のタブとの対応が壊れる事故を防ぐため、キーの変更は
  「新規作成」または「apkgから読み込む」経由でのみ行える。
- **テスト時の注意**: `on_carddef_save_clicked`/`on_carddef_new_clicked`等は
  内部で`messagebox.showinfo`等を呼ぶため、他のGUIテストと同様
  `tts_gui.messagebox.*`を事前にモックすること(`test_carddef_editor.py`参照)。
  また`card_defs.DEFS_PATH`も`tts_core.CONFIG_PATH`等と同じく、テスト実行前に
  一時ファイルへ差し替えること(実`card_defs.json`を汚さないため)。

## 実行環境について

- Pythonは `C:\Python314\python.exe`(3.14)を使用。`anki` / `sv-ttk` などは
  `AppData\Roaming\Python\Python314\site-packages` にユーザー単位でインストール
  されている。
- Claude Codeがサンドボックス環境でこのコードを検証する場合、`tkinter` が
  使えない(display無し)ことがある。GUIの目視確認は片桐の実機で行う前提とし、
  Claude Code側では構文チェックや `tts_core.py` の純粋関数のテストに留める。
  (2026-07-24追記: この環境ではtkinterが実際に使え、実ウィンドウでの
  自動テストが可能だった。使えるかどうかは環境依存なので、まず軽く
  `tk.Tk()`を試してから判断すること。)
- **GUIを自動テストする際は、`messagebox.showinfo`/`askyesno`等を必ずモックすること**。
  `on_fetch_from_sheet_clicked`のワーカースレッド経由なら実アプリでは問題ないが、
  `_generate_shuujuku_candidates_from_rows`や`on_export_shuujuku_stock_clicked`
  のような、内部でmessageboxを呼ぶ関数をテストコードから**直接同期呼び出し**すると、
  本物のダイアログが表示されて誰も操作しないため無期限にハングする
  (2026-07-24に実際に踏んだ)。`tts_gui.messagebox.showinfo = lambda *a, **k: None`
  のように上書きしてから呼ぶこと。

## 過去の経緯・注意点(TTS音声関連)

- `[sound:...]` タグを付ける対象は、**その文脈で読み上げるべき1文だけ**に限定する。
  例文+追加解説+和訳をまとめて1フィールドに書き、音声もそこに1つ、という
  作り方は過去に「解説文まで読み上げられる」問題を起こしたため禁止。
- Anki側のレンダリングエンジンは `[sound:]` タグをCSS/JSより先に処理するため、
  CSSで答えを隠していても音声で答えが漏れることがある(表示層での対策は不可)。
  音声が入るフィールドと、隠したい答えが入るフィールドは物理的に分離すること。

## Gitリポジトリ・GitHub連携

2026-07-27に`git init`してGitHub管理下に置いた。**このフォルダはGoogle Drive
同期フォルダの中にある**ため、`.git`ディレクトリ自体もDrive同期対象になる点に
注意(通常は問題ないが、大量の細かいファイルを含む`.git`をDrive側が同期し切る
までに時間がかかることがある)。

- `.gitignore`で以下を除外している(実行時に自動生成される・平文の秘密情報を
  含む・個人の学習内容を含む、のいずれかに該当するため):
  - `config.json`(Google Cloud TTS/Gemini APIキーを平文保存)
  - `shuujuku_stock.json` / `word_stock.json` / `card_defs.json`
    (実行時に生成される片桐の実データ)
  - `*serviceaccount*.json` / `*credentials*.json` / `*-key.json`等の
    認証情報っぽい命名パターン(サービスアカウントキーが万一このフォルダに
    置かれた場合の保険。ただし2026-07-27時点で実際にはこのフォルダの外
    (`【JSON-KEY】ANKI_TTS_GUI`フォルダ)に置かれていることを確認済み)
  - `*.apkg` / `*.row_map.json`(個人の学習内容を含む生成物)
  - `backup/`・`__pycache__/`・`*.anki2`系(作業用の一時ファイル)
  - `.claude/settings.local.json`(Claude Codeのローカル権限設定。慣習的に
    `.local.json`は個人環境向けのためコミット対象外)
  - **意図的に`*.json`の一括除外はしていない**(将来Web版との共有プロンプト
    ファイル等、正当にコミットしたいJSONが増える可能性があるため、上記の
    具体的なファイル名/パターンだけを列挙する方式にしてある)。
- コミットのauthor情報(`user.name`/`user.email`)は、このリポジトリの
  ローカル設定(`git config`に`--global`を付けない)のみに設定してあり、
  PC全体のgit設定は変更していない。
- リモートは設定済み(2026-07-28確認):
  `origin` = `https://github.com/yoimachihime-tech/ANKI-OutputTOOL.git`(**非公開**)。
  この環境に`gh` CLIは無いため、pushは通常の`git push`で行う
  (認証情報が無い場合は片桐がGitHub Desktop等で行う)。
  **非公開リポジトリだが、Web版をGitHub Pages等で公開する場合、公開される
  ページのJavaScriptは誰でも読めるため、APIキーをソースに埋め込んでは
  いけない**(下記「Web版」の項を参照)。

## 今後の拡張候補(未着手)

- **「AIに質問」の回答に関する調査(2026-07-27、片桐の指示により保留中)**:
  「AI質問時に生成される問題の答えがすべて『A』になる」という報告があった。
  コードを調査したが、該当するロジックはこのリポジトリ内に見つかっていない
  ——`build_grammar_dailyconv_v1_final.py`のDailyConversationノートタイプには
  `Choices`/`WhyNot`という多肢選択(A/B/C/D)向けらしきフィールドが定義済みだが、
  実際の`build_deck()`ではどちらも常に空文字が設定されており、選択式の問題は
  そもそも生成されていない。この現象がこのソフトのどの画面で起きているのか
  (またはCLAUDE.md冒頭の「①Googleフォーム→Apps Script→Gemini添削」という
  このプロジェクトの範囲外のパイプライン側の話なのか)、片桐から詳細確認待ち。
  **保留中につき、指示なく調査・修正に着手しないこと。**
- **Web版(2026-07-28に方針確定・実装は未着手)**: 片桐の希望により、
  既存の「それ以外の修正・改修」がすべて終わった後に着手する予定
  (2026-07-28の総点検・バグ修正をもって前提条件は満たされている)。
  - 進め方は「まずAI生成だけの軽量版を作り、後でapkg生成を追加」を採用
    (片桐が選択)。フェーズ1: サーバー不要の静的Webページとして、ブラウザ
    から直接Gemini/Google Cloud TTS APIを呼ぶ(GitHub Pages等の無料
    ホスティングを想定)。フェーズ2: Cloud Run等の無料枠でPython
    バックエンドを追加し、apkg生成(genanki/ankiパッケージ)まで対応。
  - **フェーズ1の対象機能(2026-07-28に片桐が選択)**: 単語カード生成 /
    AIに質問(Grammar Multi 3問生成) / 習熟用(音読)カード生成 /
    TTS音声の試聴 の4つ。いずれもAPI呼び出しだけで完結するため、
    バックエンド無しで実現できる。
  - **DailyConversation(シート連携)はフェーズ1の対象外**。
    `sheets_reader.py`/`sheets_writer.py`は**サービスアカウント方式**の
    認証を使っており、その秘密鍵(JSON)をブラウザに置くことは絶対に
    できない(鍵を持つ者はスプレッドシートを自由に読み書きできてしまう)。
    ブラウザから使うには (a) OAuth 2.0 (PKCE) でGoogleログインさせる、
    (b) Cloud Run等のバックエンドに鍵を置いて中継する、のいずれかが必要。
    どちらを採るかは着手時に片桐へ確認すること。
  - **APIキーの扱い(2026-07-28に片桐が選択)**: 利用者が自分のAPIキーを
    ページ上で入力し、ブラウザの`localStorage`に保存する方式。
    **リポジトリにもページのソースにもAPIキーを一切含めないこと。**
    リポジトリ自体は非公開だが、GitHub Pagesで公開したページのJavaScriptは
    誰でも閲覧できるため、ハードコードは鍵の流出・不正課金に直結する。
  - **配置場所(2026-07-28に片桐が選択)**: 同じリポジトリの`docs/`フォルダ。
    GitHub Pagesは`docs/`をそのまま公開できるため、gh-pagesブランチへの
    コピー等の手間が不要。
  - **プロンプトの共有(2026-07-28に片桐が合意)**: `gemini_client.py`内の
    `_WORD_TO_ITEM_PROMPT`等をリポジトリ内の共有ファイル(`prompts/*.txt`)に
    切り出し、Python側は`open()`で、Web側は`fetch()`で同じファイルを読む。
    プロンプトを改善したときに、片方だけ直して不一致になる事故を防ぐため。

### ブラウザだけでのapkg生成(2026-07-28に実現可能と確認)

「apkgをスマホで完結できないか」という片桐の質問を受けて調査し、
**バックエンド無しでも実現可能**であることを確認した。これが成立するなら
フェーズ2で想定していたCloud Runバックエンドは不要になる。

- 技術構成: `sql.js`(SQLiteのWebAssembly版)でAnkiのSQLite DBを組み立て、
  `JSZip`等でmedia(TTSのmp3)と一緒にzip化すれば`.apkg`になる
  (`.apkg`の実体は「SQLite DB + mediaのJSON対応表 + 連番のメディア
  ファイル」を固めたzip)。
- **guidの互換性は実証済み(最重要)**: `genanki.guid_for()`は
  「SHA256の先頭8バイト→整数→独自base91テーブル」という単純な処理で、
  ブラウザ標準の`crypto.subtle.digest`と`BigInt`だけで再現できる。
  Node.jsで書いた実装とPythonの`genanki.guid_for()`が、片桐の実データの
  行IDを含む4ケースすべてで完全一致することを確認した(2026-07-28)。
  **guidが一致しないと再インポート時に既存カードが更新されず重複が量産され、
  学習履歴が壊れるため、Web版を実装する際は必ずPython側との一致テストを
  用意すること。**
- 未検証の残作業: AnkiのSQLiteスキーマ(genankiが生成するのは旧スキーマ11。
  現行のAnkiはインポート時に自動アップグレードする)の再現、mediaの埋め込み、
  iOS Safari/Androidでのダウンロード→AnkiMobile/AnkiDroidで開く導線。
- **カード定義の共有が前提条件**: Web版が同じ見た目のカードを出すには、
  CSS・テンプレート・model_idをPython版と共有する必要がある。既に
  `card_defs.json`(`card_defs.py`)という汎用の定義形式があるので、
  現在`build_*.py`側にしか無いDailyConversation/習熟用/Grammar Multiの
  定義もここへ寄せていくのが自然(単語タブは既に移行済み)。
  ただしDailyConversation・習熟用は単純なフィールド値の詰め替えではない
  独自レンダリングロジックを持つため、移行には設計検討が必要
  (`card_defs.py`のdocstring参照)。
  - 制約として片桐に伝達済み: Anki本体への直接投入(今の`auto_open_anki_var`
    のような一発連携)はスマホでは再現できず、「.apkgをダウンロード→
    AnkiMobile/AnkiDroidで開く」という一手間が残る。
- 「習熟用」「AIに質問」のGemini仮実装の本実装化: プロンプトの精度検証
  (実際にGemini APIキーを設定して動作確認していない、2026-07-24時点)、
  モデル名(`gemini-2.0-flash`)の妥当性確認、必要ならClaude APIへの切り替え検討
  (TTS音声が英文以外まで読み上げてしまうリスク自体は`extract_shuujuku_tts_text`
  による英文抽出で対応済み、2026-07-24。ただしGeminiが`examples`のen側に
  日本語混じりの文を返すなど、抽出前提が崩れるケースまでは防げないので、
  実データでの検証は引き続き必要)
- `PLACEHOLDER_TOKENS`の1項目の確認(上記「習熟用(ATSU方式)カード生成との関係」
  のローカルコピー注記を参照。低優先度)
- exeの再ビルド: `README_BUILD.txt`/`ANKI出力ツール.spec`は`tts_gui.py`+
  スプレッドシート連携対応に更新済みだが、実際のビルド・動作確認は未実施
  (現状は`ANKI出力ツール.bat`からpythonw起動で運用中のため急ぎではない)
- サービスアカウントJSONキーの保管場所がGoogle Drive同期フォルダ内のまま
  (片桐いわく仮置き。ローカル専用フォルダへの移動と、移動後の
  `SHEETS_WRITER_CREDENTIALS`環境変数の更新が必要)
