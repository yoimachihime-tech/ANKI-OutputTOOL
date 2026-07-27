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
② [このソフト] シートの「Anki出力済み」が空の行を読み込み、Ankiデッキを生成
③ [このソフト] TTS音声を追加
④ [このソフト] Ankiに直接インポート、成功した行をシートの「Anki出力済み」にマーク
```

②〜④まで一貫してこのソフト内で完結する。②のカード生成ロジック(ノートタイプ・
デッキ定義)は元々別のclaude.aiチャットで行われていたが、実体はLLMを使わない
機械的な変換処理だったため、`build_grammar_dailyconv_v1_final.py`を移植して
このソフトに組み込んだ(詳細は後述)。

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
build_word_v1.py  「単語」ノートタイプ・デッキ定義の実体(2026-07-27時点では
                  card_defs.jsonの初期シード元としてのみ使用。下記「単語カード
                  生成との関係」参照)
card_defs.py      各タブ出力用ノートタイプ定義(フィールド・テンプレート・CSS)の
                  JSON永続化(⚙設定「カード定義」タブから編集、実装済み)
card_def_builder.py
                  card_defsの定義から動的にgenanki Model/Deckを組み立てる
                  汎用モジュール(実装済み)
config.json       APIキー・音声設定などの保存先(平文注意・Git管理対象外)
backup/           自動バックアップされた.apkgの保存先
ANKI出力ツール.bat 起動用バッチファイル(pythonw tts_gui.py を実行)
```

### tts_core.py

TTS呼び出し、HTML→読み上げテキスト整形、文分割、Ankiコレクションの読み込み・
走査・TTSタグ書き込み、バックアップ管理など、**tkinterに一切依存しない**関数群。

- `generate_tts_for_collection(...)` が実際のTTS書き込みメインループ。
  `log` / `on_progress` / `should_cancel` をコールバックとして受け取る設計なので、
  将来CLI化する場合もこの関数をそのまま呼べばよい。
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

- **3ペインレイアウト**(Outlook風): 左=設定列(①入力元/①結果のapkg/②フィールド/
  ③出力・オプション/④実行、縦スクロール)、中央=ノート一覧(#+先頭2フィールドの
  要約)、右=プレビューペイン(選択中ノートの全フィールドを縦に表示、Source/Target
  にはバッジ付き)。下段に進捗バーとログ(トグルボタンで折りたたみ可)。
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
- ②のSource/Target(読み上げ元/タグ追加先)フィールドは、ノートタイプに
  `Answer`フィールドがあればそれを既定選択にする(`on_notetype_selected`。
  Grammar DailyConversationでの主な使い方に合わせた既定値)。無ければ従来通り
  先頭フィールド。
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
  - **AIに質問タブ**(実装済み・仮実装): 質問を入力して「AIに生成させる」を押すと、
    `gemini_client.answer_question_as_shuujuku_item`がGemini APIで回答を生成し、
    その場でapkgは作らず**習熟用ストックに追加するだけ**(`on_ai_ask_clicked`)。
    実際のTTS→Anki出力は、習熟用タブの「まとめて出力」でまとめて行う設計。
  - **習熟用(音読)タブ**(実装済み・仮実装): 下記「習熟用(ATSU方式)カード生成
    との関係」を参照。タブボタン自体に現在のストック件数がバッジ表示される
    (`refresh_shuujuku_stock_view`が`self._source_tab_buttons["shuujuku"]`の
    テキストを「習熟用(音読) (N)」のように更新)。ストック一覧
    (`shuujuku_listbox`。選択すると`on_shuujuku_item_selected`→
    `_show_shuujuku_item_preview`で右のプレビューペインにPattern/Meaning/
    Examples/Explanation/Sourceを表示する)・「まとめて習熟用として出力」
    (`on_export_shuujuku_stock_clicked`。`build_shuujuku_v1.build_deck()`で
    一時.apkgを生成し`self.apkg_path`にセット、成功後に
    `shuujuku_stock.mark_exported`。ボタン文言は2026-07-24に
    「まとめて習熟用として出力(下の①に自動入力)」から「まとめて習熟用として出力」
    へ修正済み — apkg欄が独立した「① 結果のapkg」セクションとして下に
    存在した頃の文言が、apkgインポートタブへの統合後も残っていたため)・
    「ストックをクリア」
    (`on_clear_shuujuku_stock_clicked`。出力済みにはせず破棄、要確認ダイアログ)。
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
    で通知する。「まとめて単語カードとして出力」(`on_export_word_stock_
    clicked`)は`card_defs.get_def("word")` + `card_def_builder.build_deck_
    from_def()`で一時.apkgを生成し`self.apkg_path`にセット、成功後に
    `word_stock.mark_exported`(下記「単語カード生成との関係」の
    card_defs移行の項を参照)。タブボタンのバッジ表示・ストック一覧選択時の
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
ここへ移動した(現在6タブ、`notebook.add()`の順が表示順):

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

「添削結果」シートの「Anki出力済み」列への書き込み**だけ**を行うモジュール。
`mark_rows_as_exported(spreadsheet_id, sheet_name, row_ids, credentials_path, ...)`
を呼ぶと、ID列から対象行を特定し、「Anki出力済み」列に書き込み時刻
(`YYYY-MM-DD HH:MM:SS`)を`batchUpdate`で書き込む(他の列には触れない)。

- 認証は**サービスアカウント**方式のみ(OAuthは未対応)。JSONキーのパスは
  `credentials_path` 引数で渡す。呼び出し側が環境変数
  (`SHEETS_WRITER_CREDENTIALS`)から読んで渡す想定で、このモジュール自体は
  `config.json` や特定の環境変数名に依存しない。`sheets_reader.py`も同じ
  環境変数・同じサービスアカウントJSON(編集者権限)を読み取り専用スコープで使う。
- `dry_run=True` を渡すと実際には書き込まず、書き込み予定の行番号・値を
  `log` コールバックに出すだけ。本番実行前に必ずこれで確認すること。
- 依存パッケージ: `google-api-python-client`, `google-auth`, `genanki`
  (インストール済み。未インストールの場合は各モジュールが専用の例外を送出)。
- `tts_gui.py`の「スプレッドシート連携」セクションから呼ばれる
  (`_update_sheets_export_status`)。

### gemini_client.py

Gemini API(Generative Language API)への呼び出しをまとめたモジュール。
`tts_core.py`のGoogle Cloud TTS呼び出しと同様、`urllib.request`で直接REST APIを
叩く方式で、公式SDKへの依存は持たない。

- `generate_shuujuku_item_from_row(row, api_key, model)`: DailyConversationの
  シート行から、文法パターンの抽象化・新規例文の創作をGeminiにやらせ、
  `build_shuujuku_v1.build_deck()`向けのitem dictを1つ返す。
- `answer_question_as_shuujuku_item(question, api_key, model)`: 「AIに質問」タブの
  質問文から、同じitem dict形式の回答を返す。
- `list_gemini_models(api_key)`: `generateContent`に対応しているモデル名一覧
  (`models/`プレフィックスは除去済み)を返す。`tts_gui.py`の「モデル一覧を取得」
  ボタンから呼ばれる(`on_fetch_gemini_models`)。
- どちらもプロンプトでJSON形式での出力を指示し、`_extract_json`で
  (` ```json ` フェンス付きでも)パースする。パース失敗時は`GeminiClientError`。
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
- 重複防止: `item['source_key']`(`("chat"|"dailyconv", 値)`)を文字列化した
  ものをキーに、現在ストック中・過去に出力済み(`exported_keys`、無期限保持)の
  両方と重複しないようにする。
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

### ストックの重複防止・出力の流れ

`word_stock.py`は`shuujuku_stock.py`と全く同じ設計(2段階の出力フロー、
`path`引数の遅延解決パターンなど)を採用しているが、重複防止キーは
単語テキスト(前後空白除去・小文字化)のみを使う。`card_def_builder.build_guid()`
も同じキー生成ロジック(`genanki.guid_for(card_def["key"], 正規化した値)`。
「単語」の場合`card_def["dedup_key"] == "word"`なので実質
`genanki.guid_for('word', 正規化した単語)`となり、`build_word_v1.build_guid()`
と完全に同じ結果になる)を使っており、同じ単語を複数回生成しても既存ノートの
学習履歴を壊さない。

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
- リモート(GitHub)へのpushはまだ手動("gh" CLIがこの環境に無いため、
  片桐がブラウザ/GitHub Desktop等でリポジトリを作成し、そのURLを教えて
  もらってから`git remote add`→`git push`する運用)。

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
- **Web版(2026-07-27、方針だけ決定・実装は未着手)**: 片桐の希望により、
  既存の「それ以外の修正・改修」がすべて終わった後に着手する予定
  (2026-07-27時点でその前提条件は満たされている)。
  - 進め方は「まずAI生成だけの軽量版を作り、後でapkg生成を追加」を採用
    (片桐が選択)。フェーズ1: 単語カード生成(Gemini呼び出し)のみを行う
    静的Webページ(サーバー不要、ブラウザから直接Gemini/TTS APIを呼ぶ、
    GitHub Pages等の無料ホスティングを想定)。フェーズ2: Cloud Run等の
    無料枠でPythonバックエンドを追加し、apkg生成(genanki/ankiパッケージ)
    まで対応。
  - ソフトウェア版とWeb版のプロンプト同期方法として、`gemini_client.py`内の
    `_WORD_TO_ITEM_PROMPT`をリポジトリ内の共有ファイル(例:
    `prompts/word_card_prompt.txt`)に切り出し、Python側は`open()`で、
    Web側は`fetch()`で同じファイルを読む案を提示済み(片桐はまだ合意も
    却下もしていない。着手前に確認すること)。
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
