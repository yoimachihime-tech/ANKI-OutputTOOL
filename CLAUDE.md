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
  system_instruction/responseSchemaはApps Script側の
  実装と意味的に同一になるよう保つこと**(Apps Script側が変更された場合は
  片桐に確認の上、このコピーも追従させる。position的には
  `build_grammar_dailyconv_v1_final.py`の「正典はclaude.ai側」と同種の
  「正典は別システム側」パターン)。2026-07-29のWeb版対応時に、両者は
  他のプロンプトと同じ理由(Web版と片方だけ直して不一致になる事故を防ぐ)で
  `docs/shared/correction_system_instruction.txt` /
  `docs/shared/correction_response_schema.json`へ切り出し済み。
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
- **TTS APIエラーの分類(`_classify_tts_error` / `TtsApiError`、2026-07-28追加)**:
  以前は`call_google_tts` / `call_google_tts_wav`がHTTPエラーを一律3回
  リトライし、生のJSONを`RuntimeError`で投げていた。(a)割り当て超過・課金
  停止・キー設定ミスは待っても回復しないのにリトライで無駄に割り当てを
  消費する、(b)何が起きたか利用者に伝わらない、の2点を解消するため、
  HTTPステータスと本文から原因を判定して日本語の説明を返すようにした
  (`gemini_client._post_gemini_request`と同じ考え方)。
  リトライするのは「短期のレート制限」と「5xx(Google側の一時障害)」だけで、
  それ以外(429の長期割り当て超過・403の課金停止/リファラー制限/API未有効/
  APIの制限/キー無効)は**1回で打ち切る**。
  実際のHTTP呼び出しは`_call_tts_api()`に一本化してあり、mp3版・WAV版の
  どちらも同じ経路を通る(以前は同じリトライ処理が2箇所に重複していた)。
  `TtsApiError`は`str(e)`で「利用者向けの説明 + 詳細(生のレスポンス)」を
  返すため、`tts_gui.py`側は従来どおり`str(e)`をそのまま表示すればよい。
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
- **503(一時的な過負荷)時のリトライ**(2026-07-28追加): 片桐の環境で
  `"This model is currently experiencing high demand. Spikes in demand are
  usually temporary. Please try again later."`(503 UNAVAILABLE)が発生した際、
  それまで429しかリトライしておらず生のJSONエラーがそのまま表示されていた
  ことへの対応。`_post_gemini_request()`(`gemini_client.py`)・
  `callGemini()`(`docs/lib/gemini.js`)の両方に、429と同じ`_MAX_RETRIES`回数
  だけ短い固定間隔(2秒×試行回数)でリトライする分岐を追加した。429と違い
  長期の割り当て超過ではなく数秒〜数十秒で解消することが多いため、
  `retryDelay`の抽出は行わず単純な固定間隔にしてある。リトライしても解消
  しない場合は「Gemini APIが一時的に混雑しています」という分かりやすい
  メッセージで打ち切る。Web版の検証は`tools/test_gemini.mjs`(新設、
  `npm run test:gemini`)がfetchモックで行う(503リトライ成功/リトライ尽き、
  および429の既存挙動に回帰が無いことを確認)。
- `correct_english_text(text, api_key, model)`(2026-07-27追加): DailyConversation
  タブへの直接入力機能向け。片桐から提供を受けたApps Script
  (`onFormSubmit`→`callGeminiForCorrection`)の`system_instruction`・
  `responseSchema`をそのまま移植した。**2026-07-29のWeb版対応時に、この2つは
  他のプロンプトと同じ理由(Web版と片方だけ直して不一致になる事故を防ぐ)で
  `docs/shared/correction_system_instruction.txt` /
  `docs/shared/correction_response_schema.json`へ切り出した**
  (Python側は`_load_shared_prompt()`/`_load_shared_json()`、Web側は
  `docs/lib/gemini.js`の`correctEnglishText()`が同じ2ファイルを読む。
  以前あったモジュール定数`CORRECTION_SYSTEM_INSTRUCTION`/
  `CORRECTION_RESPONSE_SCHEMA`は廃止し、パス定数
  `CORRECTION_SYSTEM_INSTRUCTION_PATH`/`CORRECTION_RESPONSE_SCHEMA_PATH`に
  置き換えてある)。他の関数と違い、プロンプトでJSON出力を
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
- **Questionフィールドの改行位置検出に連番ラベル「(1)」「(2)」を追加
  (2026-07-29修正)**: `_format_question_html`(`gemini_client.py`)/
  `formatQuestionHtml`(`docs/lib/gemini.js`)は、日本語の指示文と英文の間・
  英文が複数文にわたる場合の文と文の間に`<br>`を挿入する処理だが、
  次の断片の先頭が引用符または英大文字であることしか境界として認識して
  いなかった。「記述式・書き換え問題」でGeminiが引用符を使わず
  「(1) Good lighting helps. (2) It makes the room look spacious.」の
  ように連番ラベルだけで複数文を並べて返すケースがあり、この形式だと
  日本語指示文・(1)・(2)がすべて改行なしの1段落として出力されてしまう
  不具合が実機で報告された。`_SENTENCE_BOUNDARY_LOOKAHEAD`(Python)/
  `SENTENCE_BOUNDARY_LOOKAHEAD`(JS)という共通の先読みパターンに切り出し、
  引用符・英大文字に加えて`\(\d+\)`(半角括弧+数字+半角括弧)も境界として
  マッチするよう両実装に追加した。`tools/verify_grammar_multi_parity.mjs`
  の記述式・書き換え問題フィクスチャに、この実例をそのまま追加してPython版・
  Web版の一致を固定してある。
- **Questionフィールドが全文英語になり改行も入らない不具合(2026-07-29修正)**:
  片桐から「問題文の改行が入らない、指示文まで含めてすべて英文になっている」
  との報告。原因は`_format_question_html`/`formatQuestionHtml`側ではなく
  `docs/shared/grammar_multi_prompt.txt`(Python/Web共有プロンプト)側にあった
  ——questionフィールドを「日本語の指示文+英語の対象文」の2部構成にする
  という前提を、規則として明文化しておらず、JSON出力例のquestion値も
  すべて`"..."`のプレースホルダーのままで具体例を示していなかったため、
  Geminiが指示文まで含めて英語だけで書いてしまうことがあった(指示文が
  日本語の句読点「。」を含まなければ、`_JA_EN_BOUNDARY_RE`が改行位置を
  検出できないのは仕様どおりで、後処理ロジック自体にバグは無い)。
  対応として、新規ルール(「questionフィールドは日本語の指示文+単一引用符
  `'...'`で囲んだ英語の対象文の2部構成にすること、質問文全体を英語だけで
  書くのは禁止」)を追加し、JSON出力例の3問すべてのquestion値を
  (`_JA_EN_BOUNDARY_RE`/`_EN_SENTENCE_BREAK_RE`が実際に改行できる)
  具体的な日本語+英語混在の例文に置き換えた。後処理ロジックのコード変更は
  無し(プロンプトのみの修正)。共有ファイルのため、この修正はデスクトップ版・
  Web版の両方に自動的に効く。プロンプト内容の変更のみで`_format_question_html`
  等の入出力契約に変更は無いため、`npm test`(6本)は無変更で通過する
  (`verify_grammar_multi_parity.mjs`は固定の生JSONで後処理だけを検証して
  いるため、プロンプトの文面自体はテスト対象外。実際にGeminiがこの新しい
  指示に従って改善された出力を返すかは実機での確認が必要)。

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

## 次にやること(2026-07-29時点の引き継ぎ)

**Web版フェーズ1は完了**(2026-07-28)。単語カード生成・AIに質問
(Grammar Multi)・習熟用(音読)・**TTS音声の自動埋め込み**のすべてが実装・
push済みで、GitHub Pagesで公開・片桐による実機確認も完了している。URL:
`https://yoimachihime-tech.github.io/ANKI-OutputTOOL/`

**2026-07-29: DailyConversation(シート連携)のWeb対応も実装完了**
(下記「Web版のDailyConversation(スプレッドシート連携)」を参照)。
`npm test`(6本、190アサーション)は全て通過している。**片桐の実機確認は
ログイン(GISテストユーザー追加後)・シート読み込み・英文添削→シート追記・
apkg出力→Anki出力済みマークすべて完了済み**(2026-07-29)。一覧の
スクロール化・重複/誤りなしフィルターも同日追加済み(下記「実装上の注意」
参照)。同日さらに、単語・AIに質問・DailyConversationの3タブに
「出力済みタグ管理」(出力済みカードを削除せず`✓ 出力済み`タグを付けて
残し、フィルターで隠す/リセットできる機能。単語・AIに質問では
`.apkg`の出力対象が「まだ出力していない項目だけ」になるよう変更した)を
追加(下記「出力済みタグ管理」参照)。

### 片桐側で完了済み

- Google Cloud のAPIキー構成(Gemini用/TTS用、開発用/本番用)の作成と、
  「アプリケーションの制限」「APIの制限」の設定
- Cloud Text-to-Speech の割り当て(All requests per minute /
  Chirp3-HD voices per minute)の引き下げ
- 単語カード生成・AIに質問(Grammar Multi)の実機動作確認(生成→apkg出力→
  Ankiへの取り込みまで確認済み)
- **TTS音声の自動埋め込みの実機動作確認**(2026-07-28、正常動作を確認)
- リポジトリを公開(Public)に変更し、GitHub Pagesを有効化(Settings → Pages
  → Source「Deploy from a branch」、Branch `master` / `/docs`)
- **本番用Gemini APIキーは、AI Studioで新しいプロジェクトを作って発行し直した
  もの**を使用(それ以前のキーは前払いクレジット切れの429エラーが出たため。
  詳細は下記「Gemini APIキーの運用に関する注意」を参照)。ウェブサイト制限
  (`https://yoimachihime-tech.github.io/*`)・APIの制限(Gemini APIのみ)
  とも設定済み

### 未実施(次にやること、どれを先にやるかは片桐に確認すること)

- **Web版DailyConversationの実機確認は完了**(2026-07-29、ログイン・シート
  読み込み・英文添削→シート追記・apkg出力→Anki出力済みマークまで確認済み)。
- **習熟用(ATSU方式)カードの様式改修は不要と判断された(2026-07-29)**:
  片桐から「DailyConversationでカードを作った場合も習熟用に追加してほしい、
  ただしその前に習熟用カードの様式(ATSU方式)自体を改修したい」との要望が
  あったが、現行apkgの実データ確認結果(下記)を踏まえ、「DailyConversationの
  類似問題がATSU式カードタイプになって習熟用に入ることが前提となっている
  ならば、それで問題無い」との回答を得た。**様式は現状維持のままでよい**、
  という結論。
  - **現行フォーマットの実データ確認(2026-07-29)**: 片桐が実機の習熟用デッキを
    エクスポートしたapkg(`【TemporaryFile】\02.単語・MindTips__習熟用.apkg`、
    Google Drive同期フォルダ内・リポジトリ外)を`tts_core.load_collection`で
    読み込んで確認した。ノートタイプ名・フィールド(`Num`/`Content`/
    `EnglishText`/`JapaneseText`、後2つは常に空欄で未使用)・カードテンプレート
    (`カード 1`、表裏とも`{{Content}}`のみで裏面に追加情報無し)・CSS
    (`deck-title`/`item-card`/`item-head`/`item-num`/`pattern-line`/
    `gloss-line`/`ex-row`/`ex-en`/`ex-jp`/`expl-box`/`expl-label`/
    `source-tag`)いずれも、このフォルダの`build_shuujuku_v1.py`(正典コピー)の
    定義と完全に一致しており、ローカルコピーの乖離は無い。
- **Web版のDailyConversation→習熟用連携を実装完了(2026-07-29)**: 上記の
  結論を受け、デスクトップ版が既に持つ連携
  (`_generate_shuujuku_candidates_from_rows`、①シートから読み込む→採用された
  行ごとにGemini APIを呼び習熟用ストックへ追加)をWeb版にも追加した。
  詳細は下記「Web版のDailyConversation→習熟用連携」を参照。
- exeの再ビルド、サービスアカウントJSONキーの保管場所移動(下記「今後の
  拡張候補」を参照)
- **デスクトップ版にあってWeb版に無かった機能(TTS試聴・日本語除外オプション・
  自動ゲイン調整・波形表示)は2026-07-29にすべて実装完了**(下記「Web版の
  TTS試聴・日本語除外オプション」「Web版のTTS波形表示・自動音量調整」を参照)。

### Web版TTS音声の埋め込み(2026-07-28実装・実機確認・push済み)

`docs/lib/tts.js`(新設)がGoogle Cloud Text-to-SpeechをブラウザからCall
する(`tts_core.py`の`call_google_tts`/`split_into_sentences`/
`_classify_tts_error`の移植)。⚙設定に「Cloud Text-to-Speech APIキー」欄を
追加し、**設定されている場合のみ**、単語/AIに質問/習熟用(音読)/
DailyConversationいずれの
`.apkg`出力時にも自動で音声を合成して埋め込む(未設定なら従来どおり音声
無しで出力する、他のAI呼び出しと同じ「未設定なら黙ってスキップ」方針)。

- **音声の分割単位(2026-07-28、片桐の指示で確定。当初は全タブで文ごとに
  分けていたのを修正した)**:
  - 単語 / AIに質問 / DailyConversation … **フィールド全体で1つのMP3・
    1つの`[sound:]`タグ**
    (`synthesizeFieldWithTags`)。複数文が含まれていても文ごとには分けない。
  - 習熟用(音読) … **例文ごとに個別のMP3・タグ**
    (`synthesizeExampleAudioTags`)。音読練習で1文ずつ再生したいため、この
    タブだけ細かく分ける。
  この変更に伴い、`tts_core.split_into_sentences()`の移植だった
  `splitIntoSentences`はどの経路からも使われなくなったため`tts.js`から削除
  した(将来「文と文の間に無音を挟んで1つの音声にする」機能を足す場合は
  再度移植が必要。「Ex1.」等の見出しラベルを次の文へ結合する処理を含むため
  単純な句点分割では代用できない点に注意)。
- **デスクトップ版との方式の違い**: デスクトップ版が持つ「複数文を無音で
  結合し1つの音声にする」方式(`synthesize_with_gaps`)は、WAVで受け取って
  結合しlameencでMP3へ再エンコードする実装で、ブラウザに同等のエンコーダが
  無いため実装していない。Web版はデスクトップ版の`gap_seconds <= 0`のときと
  同じく、平文をそのまま1回のTTS呼び出しに渡す(文間隔の調整は未対応)。
- 対象フィールドはデスクトップ版の既定選択("Answer"+"Example"がある場合は
  その2つ、単語のように"Answer"が無ければ"Example"のみ)と揃えた
  (`app.js`の`TTS_FIELD_KEYS`。DailyConversationは添削後の文(Answer)と
  類似表現(Example)の2つ)。習熟用(音読)は例文(`ex-en`)ごとの
  個別音声を各例文の直下に挿入する(デスクトップ版の
  `generate_shuujuku_sentence_tts_for_collection()`と同じ挿入位置。
  `docs/lib/shuujuku.js`の`renderItem`/`buildContentHtml`/
  `buildFieldsReadyItems`に`exampleAudioTags`引数を追加して対応、省略時は
  従来どおり音声無しで動くため既存呼び出しは無変更)。
- ストックの生item自体は変更せず、`buildApkg()`に渡す直前のコピーにのみ
  音声タグを追記する(`app.js`の`embedTtsAudioIntoItems()`/
  `embedShuujukuTtsAudio()`。再エクスポート時に二重タグが付くのを防ぐため)。
- 詳細・音声名/言語コードの既定値は`docs/README.md`の「TTS音声の自動埋め込み」
  節を参照。
- **テスト**: `tools/test_tts.mjs`(新設、`npm run test:tts`)が`lib/tts.js`を
  fetchモックで単体検証する(詳細は上記「引き継ぎ時の注意」のテスト一覧を
  参照)。`tools/test_web_ui.mjs`にはTTS APIキーを設定した場合の通しテスト
  (実際に音声タグがapkgに埋め込まれるか)はまだ追加していない
  (`test_tts.mjs`側でfetchモックによる音声埋め込みの単体検証は済み)。
- **実機確認済み(2026-07-28)**: 片桐の環境で、実際のCloud Text-to-Speech
  APIキーを設定してカード生成→apkg出力まで行い、**TTS音声が問題なく生成
  された**ことを確認済み。上記の「フィールド全体で1つのMP3」への変更後にも
  改めて確認し、**正常に動作している**(=Web版フェーズ1のTTS埋め込みは
  実装・実機確認とも完了)。
- **未検証**: 音量ゲイン・音声名の既定値がスマホ実機で妥当か。

### Web版のTTS試聴・日本語除外オプション(2026-07-29実装)

デスクトップ版にあってWeb版に無かった機能のうち2つを追加した(片桐の指示で
「1〜2個」実装候補として選定、⚙設定のTTSセクションに追加)。

- **テスト再生(`docs/lib/tts.js`の`synthesizeTestSample`/`TEST_SAMPLE_SENTENCES`、
  `app.js`の`onTestPlay`)**: `tts_core.synthesize_test_sample_wav`+
  デスクトップ版の`winsound`再生に対応するWeb版。実装当初(2026-07-29)は
  `<audio>`要素で再生するだけの簡略版だったが、同日中に波形表示・
  0dBクリッピング検出・自動音量調整を追加したため、現在は「デスクトップ版が
  持つ「文と文の間隔を空けて結合」(`synthesize_with_gaps`、WAV結合+lameenc
  再エンコード)だけがWeb版に無い」という状態になっている
  (ブラウザにlameenc相当のエンコーダが無く、そもそもWeb版のTTS埋め込み自体が
  「文と文の間隔調整は未対応」の設計であるため、テスト再生だけこれに対応する
  意味が薄いと判断。それ以外の機能は下記「Web版のTTS波形表示・自動音量調整」
  を参照)。固定の2文(`TEST_SAMPLE_SENTENCES`)を1回のTTS呼び出しでMP3化する
  部分は変更なし。連打時は前の再生を止めてからやり直す。
- **日本語除外オプション(`docs/lib/tts.js`の`splitIntoSentences`/
  `containsJapanese`/`stripJapaneseSentences`、⚙設定の
  「TTSで日本語を含む文を除外する」チェックボックス`tts-exclude-japanese`、
  既定OFF)**: `tts_core.split_into_sentences`(見出しラベル結合ロジック
  `_LABEL_ONLY_RE`込み)/`contains_japanese`/`strip_japanese_sentences`を
  そのまま移植した。`getTtsOptions()`が返すopts経由で
  `synthesizeFieldWithTags()`に伝わり、ONの場合はTTS対象テキストを組み立てる
  直前(`stripHtmlForTts`より前)にフィールドの生HTMLへ適用する
  (`[sound:...]`タグの追記先である元のフィールド自体は変更しない)。
  **単語/AIに質問/DailyConversationタブの音声生成にのみ効く**
  (`synthesizeFieldWithTags`経由のもの)。**習熟用(音読)タブは対象外**:
  `synthesizeExampleAudioTags`(例文ごとの個別音声)には配線していない。
  習熟用の例文(`ex-en`)はAI生成時点から英日を構造的に分離した別々の文字列
  (`examples`配列)であり、デスクトップ版の`extract_shuujuku_tts_text`
  (HTML構造ベースの抽出)に相当する分離が既になされているため、文単位の
  日本語除外を重ねて適用する必要性がデスクトップ版ほど高くないと判断した。
- 実装は`docs/lib/tts.js`・`docs/app.js`・`docs/index.html`のみ(共有カード
  定義・apkg組み立てには影響しないため`tools/export_shared_card_defs.py`の
  再実行は不要)。`tools/test_tts.mjs`の既存テストに変更は加えていないが、
  `npm test`(6本)全てがこの変更後も通過することを確認済み(2026-07-29)。

### Web版のTTS波形表示・自動音量調整(2026-07-29実装)

デスクトップ版にあってWeb版に無かった残り2機能(波形表示・自動ゲイン調整)を
同日中に追加実装した(片桐から続けて依頼を受けたため)。

- **波形デコードの方式がデスクトップ版と異なる**: デスクトップ版は
  `call_google_tts_wav`でCloud TTSから直接WAV(LINEAR16)を取得しPCMを
  `wave`/`struct`で解析するが、Web版のテスト再生はMP3合成のみの設計
  (`synthesizeTestSample`)なので、代わりにWeb Audio APIの
  `AudioContext.decodeAudioData()`でMP3をデコードし、`AudioBuffer`
  (チャンネルごとに既に-1.0〜+1.0へ正規化されたFloat32Array)を得る方式にした
  (`docs/lib/tts.js`の`decodeAudioSamples()`)。16bit PCMの32768除算のような
  正規化が不要な分、デスクトップ版よりむしろ単純になっている。
- **`computeWaveformMinMax(audioBuffer, buckets=40)`** /
  **`computePeakAmplitude(audioBuffer)`** / **`isClipped(peak)`**
  (`CLIPPING_THRESHOLD = 0.999`、いずれも`docs/lib/tts.js`)が、それぞれ
  `tts_core.compute_waveform_minmax` / `compute_peak_amplitude` / `is_clipped`
  に対応する。`AudioBuffer.getChannelData(0)`を受け取る形にしてあるため、
  `tools/test_tts.mjs`では`{getChannelData: () => samples}`という最小限の
  フェイクで単体テストできる(実ブラウザのFloat32Arrayでなく普通の配列を
  渡しても、添字アクセスと`.length`しか使わないため動作は同一。丸め誤差を
  避けるためテストでは意図的にFloat32Arrayを使っていない)。
- **再生は`<audio>`要素、波形解析だけWeb Audio API(2026-07-29、実機で
  「テスト音声が再生されない」と報告されすぐ修正)**: 実装当初は
  `AudioBufferSourceNode`で再生も行う設計にしていたが、`AudioContext`は
  生成直後「suspended」状態になることがあり、ユーザー操作(クリック)と
  `source.start()`の間に`await`(TTS合成・デコード)を挟むと、ブラウザに
  よっては「ユーザー操作起因」と見なされず自動でrunning状態に遷移しない
  (=無音のまま何も鳴らない、エラーも出ない)ことが実機で判明した。
  `<audio>`要素の`play()`は同様のオートプレイ制限があっても失敗時に
  明確にPromiseがrejectされる(=エラーとして検知できる)ため、再生自体は
  `<audio>`要素+`URL.createObjectURL`に戻した(`playTestWaveform()`)。
  波形解析(`decodeAudioSamples`等)は再生の成否と無関係にWeb Audio APIの
  デコード機能だけを使うため変更なし(結果としてMP3を「解析用」
  `decodeAudioData`と「再生用」`<audio>`要素の2つのデコーダで二重に
  デコードすることになるが、テスト再生というたまにしか使わない機能の
  ための小さなオーバーヘッドとして許容している)。波形アニメーションは
  `<audio>`要素の`currentTime`(0〜`audioBuffer.duration`)を
  `requestAnimationFrame`ループで参照して進める(デスクトップ版の
  `self.after(40,...)`+`time.monotonic()`に相当)。
- **`findSafeVolumeGainDb(opts, {...})`**(`docs/lib/tts.js`)が
  `tts_core.find_safe_volume_gain_db`に対応する。アルゴリズムは同一
  (ゲイン0dBでの基準ピークを測る→目標ピーク(0dBFSから既定1.0dBの余裕)まで
  引き上げるゲインを20*log10比で計算→実際にそのゲインで再合成しまだ
  クリッピングしていれば1dBずつ下げて最大4回再検証)。デスクトップ版と違い
  `gap_seconds`(文間隔)引数は無い(Web版のテスト再生に文間隔調整機能が
  無いため、`synthesizeTestSample`と同じ理由)。⚙設定の音量ゲイン入力の隣の
  「自動調整」ボタン(`app.js`の`onAutoGain()`)から呼ばれ、結果はスライダーの
  値とlocalStorageの両方に即座に反映される。
  **`findSafeVolumeGainDb`自体の単体テストは無い**(内部で実際のTTS合成+
  Web Audio APIデコードを行うため、fetchモックだけでは完結せずjsdomに
  無い`AudioContext`が必要になる。デスクトップ版の
  `find_safe_volume_gain_db`にも同様の理由でPython側の単体テストが無く、
  実機での動作確認に委ねる方針と揃えてある)。
- 実装は`docs/lib/tts.js`・`docs/app.js`・`docs/index.html`・`docs/style.css`
  (`.waveform`キャンバスのスタイル)のみ。`tools/test_tts.mjs`に
  `computeWaveformMinMax`/`computePeakAmplitude`/`isClipped`の単体テストを
  追加し、`npm test`(6本)全てが通過することを確認済み(2026-07-29)。
- **未検証**: 実機(特にモバイルSafari)でのWeb Audio API・
  オートプレイポリシー周りの挙動。

#### テスト再生が無音になる不具合の追加修正(2026-07-29〜2026-07-30)

`<audio>`要素方式に切り替えた後も、モバイル実機で問題が2段階で見つかり
それぞれ対応した。

1. **NotAllowedErrorで再生自体が拒否される(2026-07-29)**: クリックから
   TTS合成完了(ネットワーク待ちで数秒かかることがある)までの間に
   「ユーザー操作起因」の許可の有効期限が切れ、その後の`audio.play()`が
   `NotAllowedError`で拒否されることが判明。対策として、クリックハンドラの
   同期部分(await前)でまず無音WAVを即座に再生開始してその`<audio>`要素を
   "解禁"しておき、TTS合成後は同じ要素のsrcを実際の音声に差し替えて
   再度`play()`するだけにする方式(`onTestPlay`/`playTestWaveform`)にした。
2. **エラーは出ないが依然無音のまま(2026-07-30、片桐から「波形は表示される
   ようになったが音声はまだ再生されない」と再報告)**: 上記1の対策を入れても
   まだ鳴らない場合があった。原因は無音WAV(`createSilentWavBlobUrl`)が
   サンプル1個(8000Hzで約0.125ミリ秒)しかなく、再生を開始した端から
   即座に「再生終了」してしまうため、TTS合成待ちの数秒間"再生中"の状態を
   維持できていなかったことだと考えられる(ブラウザによっては、短すぎる
   音声が一瞬で終わった時点で「ユーザー操作起因」の解禁状態を失効させる
   ことがある)。対応として、(a) 無音WAVを0.25秒に伸ばした上で
   `audio.loop = true`でTTS合成が終わるまでループさせ続け、常に"再生中"の
   状態を保つようにし、(b) `new Audio()`で作った要素がDOMツリーに
   属していないと一部のモバイルブラウザで再生が不安定になることがあるため
   `document.body`へ明示的に追加するようにした(`controls`属性が無いため
   画面上には何も表示されない。`stopTestPlayback()`が後片付けとして
   `parentNode`から取り除く)。`playTestWaveform()`側で本番の音声へsrcを
   差し替える際は`audio.loop = false`に戻す。
   - この時点では実機での再検証はまだ行っていない(次回片桐に確認して
     もらう)。もし依然として鳴らない場合、iPhone本体の「着信/サイレント」
     物理スイッチがオンになっている可能性を疑うこと(`<audio>`要素は
     iOS上でこのスイッチの影響を受けるのが仕様上の既定動作であり、
     アプリ側のコードでは制御できない)。

### Web版のDailyConversation→習熟用連携(2026-07-29実装)

デスクトップ版の`_generate_shuujuku_candidates_from_rows`(①シートから
読み込む→採用された行ごとにGemini APIを呼び習熟用ストックへ追加)に対応する
機能をWeb版にも追加した。上記「習熟用(ATSU方式)カードの様式改修は不要と
判断された」を受けて着手。

- **プロンプトの共有化**: 従来`gemini_client.py`内にのみあったインライン
  プロンプト`_ROW_TO_ITEM_PROMPT`を、他の共有プロンプトと同じ理由
  (Web版と片方だけ直して不一致になる事故を防ぐ)で
  `docs/shared/shuujuku_dailyconv_prompt.txt`へ切り出した。Python側は
  `gemini_client.ROW_TO_ITEM_PROMPT_PATH`(旧`_ROW_TO_ITEM_PROMPT`定数を
  置き換え)経由で`_load_shared_prompt()`+`_fill_placeholders()`で読み、
  Web側の`docs/lib/gemini.js`の`generateShuujukuItemFromRow({row, apiKey,
  model, promptTemplate})`が同じファイルを読む。既存の
  `shuujuku_prompt.txt`(「AIに質問」タブの4問目用、質問文ベース)とは
  プレースホルダが異なる別ファイル(`{{original}}`/`{{corrected}}`/
  `{{explanation}}`、行ベース)であり、混同しないこと。
- **トリガーのタイミング(2026-07-29、実装当日中に片桐の指示で変更)**:
  当初は④の`.apkgをダウンロード`(`onDailyExport()`)時点で発火する実装に
  していたが、「AIに質問タブは生成させた時点で習熟用タブに飛ばしている」
  ことと足並みを揃えたいとの指示を受け、**②「AIに添削させてシートに追加」
  (`onDailyCorrect()`)の成功直後**に変更した。これはデスクトップ版の
  実質的な挙動(直接入力→①シートから読み込むへの自動連鎖)にも一致する
  タイミングであり、「AIに質問」タブの4問目生成(`onAiAskGenerate()`が
  3問生成の直後に習熟用4問目も生成する)と同じ即時性になった。
  `generateShuujukuCandidatesFromRows(rows, status)`(`app.js`)は
  `onDailyCorrect()`内、`correctEnglishText()`→`appendCorrectionRows()`→
  `refreshDailyPending()`の後に呼ばれ、対象行は「今回シートへ追記した行
  (`corrections`と`appendCorrectionRows()`が返す`newIds`をゼップして
  組み立てる)のうち`category !== '誤りなし'`のもの」(誤りが無ければ
  抽出すべき文法パターンが無いため)。`onDailyExport()`側の呼び出しは
  削除済み(重複呼び出しにしない。1つのイベントでのみ発火する設計)。
- **非ブロッキング**: Gemini APIキー未設定、または行ごとの生成失敗があっても
  シート追記自体は成功として扱う(「AIに質問」タブの4問目生成と同じ設計)。
  成功件数・失敗件数はステータス文言に追記される。
- **重複の扱いはデスクトップ版と同じく「常に追加、一覧で警告表示」方式**:
  `app.js`の`shuujukuDuplicateIndices()`(source_topic基準)が既存の仕組みで
  検出・⚠表示する(pattern類似度によるファジー重複検出はデスクトップ版のみで
  Web版には元々無く、これは今回のスコープ外)。
- **テスト**: `tools/test_web_ui.mjs`のセクション[17](②添削→シート追記)に、
  シート追記成功直後にGeminiが呼ばれ、習熟用(音読)ストックに
  `source_kind: 'dailyconv'` / `source_topic: 追記した行のID`を持つ項目が
  追加されることを検証するアサーションを追加した(`FAKE_SHUUJUKU_FROM_ROW`)。
  **添削(`correctEnglishText`)と習熟用候補生成(`callGemini`)は同一tick内で
  連続して発火しうるため、`geminiCalls`(全体の呼び出し回数)を経過観察する
  poll中に「添削は1回だけ」を検証しようとすると値のスナップショットが
  レースする(実際に一度このレースで誤って失敗させてしまった)。添削の
  リクエストボディだけが`system_instruction`(構造化出力)を含むことを目印に
  `correctionCalls`という別カウンタで区別するようにした**。`npm test`
  (6本)全てが通過することを確認済み(2026-07-29)。

### Web版のDailyConversation(スプレッドシート連携、2026-07-29実装)

Web版から「添削結果」スプレッドシートを直接読み書きできるようにしたもの。
デスクトップ版のDailyConversationタブと同じ①〜④の流れをブラウザだけで行う
(①Googleログイン → ②英文入力→AI添削→シートへ追記 → ③未出力行の一覧 →
④.apkg出力→「Anki出力済み」マーク)。実装・自動テストは完了しており、
**①②(ログイン・シート読み込み)は片桐の実機で動作確認済み**(2026-07-29)。
③④(添削→シート追記、apkg出力→Anki出力済みマーク)の実機確認はまだ。

#### 認証方式: GIS token client(**PKCEではない**)

CLAUDE.mdには当初「OAuth 2.0 (PKCE)が必要」と書いていたが、調査の結果
**静的サイトではPKCEだけでは完結しない**ことが分かった: Googleの
「ウェブ アプリケーション」型クライアントは、認可コード→トークン交換に
client_secretを要求する(client_secretをブラウザに置くことはできない)。
「Desktop/Installed app」型ならPKCEのみで交換できるが、リダイレクトURIが
localhostに限られるためGitHub Pagesでは使えない。

そのため、client_secret不要でバックエンドも不要な唯一の正規ルートである
**Google Identity Services (GIS) の token client**
(`google.accounts.oauth2.initTokenClient`)を採用した(2026-07-29、片桐が選択)。

- **アクセストークンはメモリ上にのみ保持する**(`docs/lib/sheets.js`の
  モジュールスコープ変数)。localStorageに置くとXSSで持ち出されうるため。
  有効期限は約1時間、リフレッシュトークンはこの方式では発行されない。
  期限の1分前(`EXPIRY_MARGIN_MS`)には切れたものとして扱う。
- 一度同意していれば`prompt: ''`での再取得は基本的に無操作で通る。
  既にログイン済みの状態でログインボタンを押した場合は「アカウントを
  選び直したい」ケースとみなし`prompt: 'consent'`にする
  (`app.js`の`onDailySignIn`。ボタン文言も
  「別のアカウントでログイン」に変わる)。
- **OAuthクライアントIDは秘密情報ではない**ため公開ページに置いて問題ないが、
  他のAPIキーと同じく⚙設定の入力欄+localStorageにしてある
  (コード変更・再デプロイ無しに差し替えられるようにするため)。
- スコープは`https://www.googleapis.com/auth/spreadsheets`(readonlyでは
  ないのは、添削結果の追記と「Anki出力済み」のマークを行うため)。
- **片桐側の事前準備**(未実施): (a) Google Sheets APIの有効化、
  (b) OAuthクライアントID(種類「ウェブ アプリケーション」、承認済みの
  JavaScript生成元に`https://yoimachihime-tech.github.io`)の作成、
  (c) OAuth同意画面が「テスト」ステータスならテストユーザーへの
  自分のアカウント追加。手順は`docs/README.md`に記載。

#### 実装(Web版DailyConversation)

- `docs/lib/sheets.js`: 認証部(GIS)とAPI部を明確に分けてある。API部
  (`fetchPendingRows`/`appendCorrectionRows`/`markRowsAsExported`)は
  accessTokenを引数で受け取る純粋な関数なので、`test_sheets.mjs`が
  GISを一切読み込まずにfetchモックだけで検証できる。
  **デスクトップ版と同じ責務分担を守ること**: このモジュールは読み取りと
  「Anki出力済み」列の書き込み・新規行の追記だけを行い、行の削除・他の列の
  書き換えは一切しない。
- `docs/lib/dailyconv.js`: `processSheetRows()`(「誤りなし」除外+ID重複
  除去)・`buildFieldsReadyItems()`(9フィールドへの合成)と、ローカル除外
  リスト(`daily_pending_exclusions.py`のWeb版、保存先はlocalStorage)。
- `docs/lib/gemini.js`: `correctEnglishText()`/
  `consolidateNoErrorCorrections()`を追加。この対応で、リトライ・エラー
  日本語化を担う`postGeminiRequest()`を`callGemini()`から切り出し、
  構造化出力(system_instruction+responseSchema)のリクエストも同じ経路を
  通るようにした。
- `docs/app.js`: DailyConversationタブは**他タブと共通の
  `TAB_CONFIG`/`onExport`/`onDeleteSelected`の枠組みに載せていない**。
  候補の実体がlocalStorageのストックではなくシートそのものであり、
  「削除」の意味(ローカル除外)も「出力」の後処理(シートへのマーク)も
  他タブと異なるため。デスクトップ版のtts_gui.pyが同じ理由で
  DailyConversationタブだけ別実装を持っているのと同じ判断。
- **共有カード定義に`daily`を追加**(`tools/export_shared_card_defs.py`の
  `build_daily_def()`)。guidは`genanki.guid_for('dailyconv', シートのID列)`
  で**値を正規化しない**ため、word等の`dedup_key`方式(小文字化+trimする)
  ではなくcompound方式(`item_keys: ["id"]`)で表現している。
  またこのカード種別だけがノートにタグ(`source::gemini_dailyconv`)を持つ
  ため、`card_def.tags`という項目を新設して`docs/lib/apkg.js`の
  `tagsFieldFor()`がデータ駆動で読むようにした(JS側にカード種別ごとの
  分岐を持ち込まないため。guid_scheme/due_schemeと同じ考え方)。

#### 注意点(Web版DailyConversation)

- **`.apkg`の生成に成功してから「Anki出力済み」をマークする**(デスクトップ版
  と同じ2段階設計)。順序を入れ替えると、生成に失敗した行が出力済みになって
  二度と一覧に出てこなくなる。
- `tools/dump_python_apkg.py`は`--card-def daily`のときだけ、標準入力で
  受け取るのが「生成済みのitem」ではなく**シートの生の行**になる
  (`process_sheet_rows`による除外もPython側で行われる)。そのため
  `verify_web_parity.mjs`の`verifyCardDef()`には、ラベル表示用の配列を
  別に渡す`labelItems`引数を追加してある(ノートiと入力items[i]が
  1対1に対応しないため)。
- `process_sheet_rows()`はID重複時に`print()`で警告を出すため、
  `dump_python_apkg.py`は`contextlib.redirect_stdout(sys.stderr)`で
  囲んでいる(でないと出力するJSONが壊れる)。
- **実機確認(2026-07-29)でログイン・シート読み込みまで動作することを
  確認した**。片桐から「一覧の物量が増えるのでスクロール可能にしたい、
  重複や誤りなしなどをフィルターできるようにしたい」という追加要望を
  受け、以下を実装した:
  - **一覧のスクロール化**: `.stock`クラス(単語/AIに質問/習熟用/
    DailyConversationの4タブが共有する`<ul>`)に`max-height`+
    `overflow-y: auto`を追加。1箇所の変更で4タブ全てに効く。
  - **原文重複の検出とフィルター**: `app.js`の`dailyDuplicateOriginalIds()`
    が、「原文」を正規化(trim+空白圧縮+小文字化)して複数行に一致する
    ものを検出する(IDはuuid4のため通常重複しないが、Googleフォーム経由・
    直接入力経由で同じ英文が二重投稿されることがあるための対応、
    `daily_pending_exclusions.py`が対処している問題と同種)。一覧上部の
    チェックボックス2つ(「誤りなしを隠す」「重複の可能性がある行のみ
    表示」、既定は両方OFF)で表示だけを絞り込める(シート・除外登録には
    一切影響しない、`renderDailyPending()`内で毎回再計算)。
  - **選択のID化**: フィルターで表示行が絞られると描画順序と
    `dailyPendingRows`のインデックスが一致しなくなるため、
    `buildStockRow`の各行チェックボックスに`data-row-id`を持たせ、
    `checkedRowIdsOf()`(新設)でID経由で選択項目を特定するよう
    `onDailyExcludeSelected()`を変更した。**2026-07-29に単語/AIに質問タブへも
    出力済みフィルターを追加した際、同じ問題(フィルターで表示行が絞られると
    位置ベースでは壊れる)がこの2タブにも波及したため、位置ベースだった
    `checkedIndicesOf`は廃止し、`onDeleteSelected()`(単語/AIに質問/習熟用
    共通)も含め全タブを`checkedRowIdsOf()`に統一した**(習熟用はフィルターを
    持たないが、統一のため`rowId`は付与している)。

### 出力済みタグ管理・フィルター永続化・リセット(2026-07-29追加)

片桐から「単語・AIに質問タブでは`.apkg`出力してもストックからカードが
消えず、次に別の単語・質問を生成して再度出力すると既出力分と新規分が
毎回一緒にバンドルされて紛らわしい」との指摘を受けて追加した
(習熟用タブは出力成功時にストックを空にする既存の2段階設計のままでよいとの
回答だったため変更していない)。

- **`onExport(tabKey)`の変更(単語/AIに質問、核心の修正)**: 出力対象を
  `cfg.stock`全体ではなく`cfg.stock.filter(item => !item.exported_at)`
  (まだ出力していない項目)に変更した。`buildApkg()`が成功した後、対象に
  なった項目(`.filter()`が返す同一オブジェクト参照の`Set`で判定、
  インデックス計算は不要)へ`exported_at`(ISO文字列)を設定して
  `cfg.setStock()`→`cfg.render()`する2段階設計(デスクトップ版の
  `mark_exported`と同じ考え方。生成に失敗した項目は次回も出力対象に残る)。
  カード自体は削除しない。
- **`buildStockRow()`の`tags`を拡張**: 従来は文字列配列(すべて警告色
  `.dup-tag`)だったが、`{text, kind: 'done'}`形式も受け付けるようにし、
  `kind === 'done'`のときは警告色ではない`.done-tag`(`--sub`系の配色)を
  使う。「✓ 出力済み」は問題ではなく単なる状態表示のため、既存の
  「⚠ 重複」等と視覚的に区別している。
- **「出力済みを隠す」フィルター**(単語/AIに質問、既定ON): `item.exported_at`が
  真の項目を`render*Stock()`で非表示にする。全件フィルターに隠れた場合は
  「すべて出力済みです。」という専用の空表示メッセージを出す(でないと
  理由不明の空リストになる)。
- **「出力済み履歴をリセット」ボタン**(`onResetExported(tabKey)`): 確認の後
  ストック内全項目の`exported_at`を消す(分割代入`const {exported_at,
  ...rest} = item`)。カードは削除しない。
- **DailyConversationの3つ目のフィルター**: シート側の「Anki出力済み」列
  マーク(④のチェックボックス、`markRowsAsExported`)とは独立に、
  「このブラウザで少なくとも一度は`.apkg`に含めて出力した」ことを
  `dailyconv.js`の`loadExportedIds`/`addExportedIds`/`clearExportedIds`
  (localStorageキー`anki_tool_daily_exported_ids`、既存の除外リストと
  並行する実装)でローカル記録する。④のチェックボックスをOFFにして
  出力した場合やシート書き込みが失敗した場合でも、③の一覧に残り続ける
  行のうち「実は既に一度カード化した」ものを「出力済み(このブラウザで
  記録)を隠す」フィルター(既定ON)で見分けられるようにするための保険。
  `onDailyExport()`は`.apkg`生成に成功した直後、④のチェックボックスの
  状態に関わらず必ずこの記録を行う。「出力済み履歴をリセット」ボタンは
  このローカル記録だけを消し、シートの「Anki出力済み」列には一切触れない。
- **フィルターチェックボックスの永続化(全タブ共通)**: 新設の
  `bindPersistentCheckbox(id, defaultValue, onChange)`(`app.js`)が
  localStorageキー`anki_tool_filter_<id>`で状態を保存・復元する。
  `bindEvents()`内、各タブの初回描画(`render*Stock`/`renderDailyPending`)
  より前に呼ぶ必要がある(復元した値を初回描画に反映させるため)。
  **`FILTER_STORAGE_PREFIX`定数は`init()`呼び出し(モジュール読み込み直後に
  即時実行される`init().catch(...)`)より前、モジュール先頭側に置くこと**
  (`const`のTDZにより、`init()`から同期的に呼ばれる`bindEvents()`内で
  参照する時点で未初期化だと`ReferenceError`になる。実際にこの順序を
  誤って一度踏んでいる)。

### Gemini APIキーの運用に関する注意(2026-07-28)

#### 「前払いクレジットが尽きている」(429)が出たら、まずキーを作り直す

`"Your prepayment credits are depleted. Please go to AI Studio ... to manage
your project and billing."`(429 RESOURCE_EXHAUSTED)というエラーが出ることが
ある。文面は課金を促す内容だが、**課金は必須ではない**。

**対処: `https://aistudio.google.com/apikey`で「APIキーを作成」する際、
既存のプロジェクトではなく新しいプロジェクトを選んでキーを作り直す。**
これで解決する(2026-07-28、片桐の環境で実証済み。クレジットカードは
一切登録していない)。キーはlocalStorage(Web版)/config.json(デスクトップ版)
に保存するだけなので、コード変更・再デプロイは不要。

**経緯・注意点**:

- 片桐の環境では、AI Studioが自動生成した"Default Gemini Project"が、
  請求先アカウント「My Billing Account」に紐づいた「有料1」ティア
  (階層の上限$250)・支払い方式は前払い(プリペイド)・クレジット残高¥0、
  という状態になっており、このプロジェクトのキーが常にこのエラーを返した。
  **片桐はクレジットカードを登録した記憶が無く、なぜこの状態になったのかは
  未解明**(新規プロジェクトでは起きなかったため、このプロジェクト固有の
  問題と考えられる)。
- **調査時にAI Studioの「利用額」ページの表示を信用しないこと**。このページ
  では「無料枠」バッジ+「このプロジェクトには現在、請求先が設定されて
  いません」と表示されていたが、「請求額」ページを見ると実際には請求先
  アカウントが紐づいていた。2つのページで表示が食い違うため、判断は
  「請求額」ページ側で行う。
- 発行元(Google Cloud Console / AI Studio)による違いは**無い**。以前は
  「AI Studio発行のキーなら無料枠で問題なく動く」と記録していたが、
  実際にはAI Studio発行の本番キーでもこのエラーが発生した。**問題は
  発行元ではなくプロジェクト**。
- アプリ側のエラーメッセージ(`gemini_client._is_billing_error` /
  `docs/lib/gemini.js`の`isBillingError`)は、Google側が返す
  `"prepayment credits are depleted"`を正しく検出して専用メッセージを
  表示できており、コードの不具合ではない。

#### APIキーの制限設定(新しいキーを作ったら毎回設定すること)

AI Studio発行のキーも実体はCloud ConsoleのAPIキーであり、
「アプリケーションの制限」「APIの制限」による保護を同様に設定できる。
Web版公開用のキーには次を設定する:

- アプリケーションの制限 → ウェブサイト: `https://yoimachihime-tech.github.io/*`
- APIの制限: Gemini APIのみ

ただしAI Studioが自動的にキーを紐づけるプロジェクトは、Cloud Console側で
普段使っているプロジェクトとは別(例: "Default Gemini Project"のような
自動生成プロジェクト)になっていることがあり、Cloud Console側で見当たらない
場合は`https://console.cloud.google.com/apis/credentials?project=<AI Studio
のプロジェクト一覧に表示されているID>`のように**プロジェクトIDを直接URLに
指定してアクセスする**と確実(Cloud Console右上のアカウントが、AI Studioで
使っているGoogleアカウントと一致しているかも合わせて確認すること)。

なお、Gemini APIキーは他のAPIと組み合わせた制限ができないため、
**Gemini用とCloud Text-to-Speech用でキーを分ける必要がある**。

### 引き継ぎ時の注意

- **`docs/`配下を変更したら必ず`cd tools && npm test`を通すこと**
  (初回のみ`npm install`)。guidやフィールドがズレると、再インポート時に
  既存カードが更新されず重複が量産され、学習履歴が壊れる。
- Cloud TTSの割り当ては**すべて「1分あたり」**で、総額の上限にはならない。
  「一定額で自動停止」を実現するには予算アラート+Cloud Functionで課金自体を
  切る構成が必要(未実施)。現状は予算アラートで気付く運用。
- Gemini APIキーが「前払いクレジット(prepayment credits)」切れで429を
  返すことがある(片桐の環境で実際に発生)。レート制限とは違い待っても
  回復しないが、**課金は必須ではなく、AI Studioで新しいプロジェクトを選んで
  APIキーを作り直せば解決する**(上記「Gemini APIキーの運用に関する注意」を
  参照)。デスクトップ版(`gemini_client._is_billing_error`)・Web版
  (`docs/lib/gemini.js`の`isBillingError`)の両方で判定済みで、専用の
  エラーメッセージを表示する。

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
- **Web版(2026-07-28に方針確定。フェーズ1は完了・push済み)**:
  以下は方針決定時の記録。実装状況は上記「Web版の実装状況」と
  「次にやること」を参照。
  - 進め方は「まずAI生成だけの軽量版を作り、後でapkg生成を追加」を採用
    (片桐が選択)。フェーズ1: サーバー不要の静的Webページとして、ブラウザ
    から直接Gemini/Google Cloud TTS APIを呼ぶ(GitHub Pages等の無料
    ホスティングを想定)。フェーズ2: Cloud Run等の無料枠でPython
    バックエンドを追加し、apkg生成(genanki/ankiパッケージ)まで対応。
  - **フェーズ1の対象機能(2026-07-28に片桐が選択)**: 単語カード生成 /
    AIに質問(Grammar Multi 3問生成) / 習熟用(音読)カード生成 /
    TTS音声の試聴 の4つ。いずれもAPI呼び出しだけで完結するため、
    バックエンド無しで実現できる。
  - **DailyConversation(シート連携)は当初フェーズ1の対象外だったが、
    2026-07-29に実装した**(下記「Web版のDailyConversation(スプレッドシート
    連携)」を参照)。当時の記録: `sheets_reader.py`/`sheets_writer.py`は
    **サービスアカウント方式**の認証を使っており、その秘密鍵(JSON)を
    ブラウザに置くことは絶対にできない(鍵を持つ者はスプレッドシートを
    自由に読み書きできてしまう)。ブラウザから使うには (a) OAuthで
    Googleログインさせる、(b) Cloud Run等のバックエンドに鍵を置いて中継する、
    のいずれかが必要 → **2026-07-29に片桐が(a)を選択**。
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

### Web版の実装状況(2026-07-29、単語+AIに質問+習熟用+TTS+DailyConversation)

`docs/`配下に静的Webページとして実装済み。詳細は`docs/README.md`を参照。
**単語入力→AI生成→プレビュー→apkgダウンロード**、**AIに質問(3問生成)→
プレビュー→apkgダウンロード**、**習熟用(音読、AIに質問の4問目として自動
追加)→プレビュー→apkgダウンロード**、**DailyConversation(Googleログイン→
英文入力→AI添削→シートへ追記→未出力行一覧→apkgダウンロード→
「Anki出力済み」マーク)**のいずれもブラウザだけで完結し、バックエンドは不要。
⚙設定でCloud Text-to-SpeechのAPIキーを設定していれば、どのタブのapkg出力でも
**TTS音声を自動で合成して埋め込む**(上記「Web版TTS音声の埋め込み」の項を
参照)。画面はタブ切り替え式
(単語 / AIに質問 / 習熟用(音読) / DailyConversation)。既定の表示タブは
「単語」のままにしてある(DailyConversationは最後のタブとして追加した)。

```text
docs/
  index.html / style.css / app.js   画面・UI(タブ切替、ストックはlocalStorage)
  lib/gemini.js                     Gemini呼び出し(gemini_client.pyのWeb版)。
                                     単語カード生成・Grammar Multi(3問生成)の
                                     後処理(改行整形・正解記号付与・HTML化)・
                                     習熟用4問目の生成(generateShuujukuItem)・
                                     英文添削(correctEnglishText)を持つ
  lib/guid.js                       genanki.guid_for()と同一のguid生成。
                                     card_def.guid_scheme(dedup_key方式/
                                     compound方式)を読んで計算方法を切り替える
                                     (下記参照)
  lib/apkg.js                       .apkgの組み立て(sql.js + JSZip)。
                                     card_def.due_scheme(fixed_zero/index/field)・
                                     card_def.tagsもデータ駆動にしてある
  lib/shuujuku.js                    習熟用(音読)のContentフィールド組み立て
                                     (build_shuujuku_v1.render_item()のWeb版)+
                                     続き番号(Num)管理(localStorage)
  lib/tts.js                        Cloud Text-to-Speech呼び出し(tts_core.pyの
                                     call_google_tts/strip_html_for_tts/
                                     _classify_tts_errorのWeb版)+ apkgへの
                                     [sound:]タグ埋め込み
  lib/sheets.js                     Googleログイン(GIS token client)+
                                     「添削結果」シートの読み書き
                                     (sheets_reader.py/sheets_writer.pyのWeb版、
                                     2026-07-29追加)
  lib/dailyconv.js                  シートの行→DailyConversationの9フィールドへの
                                     変換 + ローカル除外リスト
                                     (build_grammar_dailyconv_v1_final.pyの
                                     process_sheet_rows/build_deckと
                                     daily_pending_exclusions.pyのWeb版、
                                     2026-07-29追加)
  lib/sync.js                       複数端末間の同期のマージロジック(id単位の
                                     和集合+打ち消し記録、通信は持たない純粋
                                     関数のみ、2026-07-30追加。詳細は下記
                                     「Web版の複数端末間の同期」を参照)
  shared/                           デスクトップ版と共有する資産
tools/
  export_shared_card_defs.py        docs/shared/*.json を生成
                                     (word/grammar_multi/shuujuku/daily)
  dump_python_apkg.py               検証用にPython版のapkg中身を出力
                                     (--card-def word|grammar_multi|shuujuku|daily)
  verify_web_parity.mjs             両者のapkgが一致するか検証(npm run verify)
  verify_grammar_multi_parity.mjs   Grammar Multiの後処理(改行整形・正解記号)が
                                     一致するか検証(npm run verify:grammar-multi)
  test_web_ui.mjs                   jsdom上でUI操作を通しで検証(npm run test:ui)
  test_tts.mjs                      lib/tts.jsの単体テスト(npm run test:tts)
  test_gemini.mjs                   lib/gemini.jsのリトライ・エラー処理の
                                     単体テスト(npm run test:gemini)
  test_sheets.mjs                   lib/sheets.js / lib/dailyconv.jsの単体テスト
                                     (npm run test:sheets、2026-07-29追加)
  test_sync.mjs                     lib/sync.js(マージロジック)+ lib/sheets.jsの
                                     同期用関数(隠しタブの読み書き・自動作成)の
                                     単体テスト(npm run test:sync、2026-07-30追加)
```

- **共有資産を`docs/shared/`に置いている理由**: GitHub Pagesは`docs/`配下
  しか配信しないため。リポジトリ直下の`prompts/`等に置くとWeb版から
  `fetch()`できない。プロンプト(`word_card_prompt.txt`/
  `grammar_multi_prompt.txt`/`shuujuku_prompt.txt`)はPython側の
  `gemini_client._load_shared_prompt()`も同じファイルを読む。プレース
  ホルダは`str.format()`ではなく`{{word}}`形式の単純置換にしてある
  (format()だとJSON例の波括弧を`{{`にエスケープする必要があり、JS側と
  文面が一致しなくなるため)。
- **`docs/shared/card_defs.json` / `anki_schema.json`は自動生成物**。
  ⚙設定「カード定義」タブでノートタイプを編集したら
  `python tools/export_shared_card_defs.py`を実行して再生成すること
  (でないとWeb版とデスクトップ版でカードの見た目がズレる)。
  ノートタイプJSON(`req`やfldsのord/font等を含む)はgenankiに組み立てさせた
  結果をそのまま運ぶ設計で、JS側では再構築しない。
- **guid/dueの計算方法をカード種別ごとにハードコードせず、共有JSON側に
  記述させる設計(2026-07-28、AIに質問追加時に導入、習熟用追加時に
  due_schemeへ第3のパターンを追加)**: word(単語)は
  `card_def_builder.build_guid()`(1フィールドの正規化値からguid、
  due常に0)、grammar_multi(AIに質問)は`grammar_multi_builder.build_guid()`
  (`topic_key`+`note_index`の複合キーからguid、dueはitemsのリスト内
  インデックス)、shuujuku(習熟用)は`build_shuujuku_v1.build_guid()`
  (`source_kind`+`source_topic`の複合キーからguid、dueはNumフィールドと
  同じ続き番号)と、Python側の生成経路自体がカード種別ごとに異なる
  (grammar_multi・shuujuku とも`card_defs.json`を経由しない独立実装、
  「Grammar Multiカード生成との関係」「習熟用(ATSU方式)カード生成との
  関係」の項を参照)。この違いをWeb側の`lib/guid.js`/`lib/apkg.js`が種別
  ごとに分岐するのではなく、`card_def.guid_scheme`
  (`{"type": "dedup_key", ...}` または `{"type": "compound", ...}`)・
  `card_def.due_scheme`(`{"type": "fixed_zero"}` / `{"type": "index"}` /
  `{"type": "field", "key": ...}`)という形で`tools/export_shared_card_defs.py`
  が共有JSONに埋め込み、Web側はそれを読んで計算する。新しいカード種別を
  追加する際も、この2ファイルを直接編集する必要は基本的にない
  (実際、shuujuku追加時は`due_scheme`に`"field"`タイプを1つ足しただけで
  word/grammar_multiのコードは無変更のまま通った)。
- **習熟用(shuujuku)だけはguid/due以外にも特殊事情がある**:
  Contentフィールドはitemの1値をそのまま流し込むのではなく、
  pattern/meaning/examples/expl/source_labelを`build_shuujuku_v1.render_item()`
  相当のロジックでHTMLに合成した結果であり、しかもNum/dueは出力時点で
  払い出す続き番号(Ankiのソートフィールド衝突を避けるため)に依存する。
  そのためWeb側は生のitem(ストックに貯める形)をそのまま`buildApkg()`に
  渡すのではなく、`docs/lib/shuujuku.js`の`buildFieldsReadyItems(items,
  startNum)`で先にNum/Contentを確定させてから渡す
  (`docs/app.js`の`onExportShuujuku()`を参照)。続き番号は
  `getNextNum()`/`advanceNextNum()`がlocalStorageで管理し、apkg生成が
  実際に成功した時点で初めて進める(デスクトップ版の
  `shuujuku_stock.get_next_num()`/`mark_exported()`と同じ2段階設計)。
- **習熟用タブには直接の入力欄が無い**。デスクトップ版と同じく、
  「AIに質問」タブで質問を送信すると、Grammar Multiの3問生成
  (`generateGrammarMultiItems`)に続けて習熟用4問目の生成
  (`generateShuujukuItem`)が呼ばれ、成功すれば習熟用ストックへ1件追加
  される。この4問目生成の失敗は3問の生成成功を無効にしない(非ブロッキング、
  `docs/app.js`の`onAiAskGenerate()`を参照)。
- **`docs/`配下を変更したら必ず`cd tools && npm test`を通すこと**
  (初回のみ`npm install`。`tools/node_modules/`はGit管理外)。中身は7本:
  - `npm run verify`(`verify_web_parity.mjs`): 同じ入力からデスクトップ版
    (genanki)とWeb版それぞれでapkgを生成し(word・grammar_multi・shuujuku・
    dailyの4種別)、guid・フィールド・タグ・カード構成・ノートタイプ定義を
    突き合わせる。
    実装中に実際に複数の差異(cards.dueの採番、models.modの扱い)を検出して
    おり、これを省くと気付かないまま学習履歴を壊す変更が入る。shuujukuは
    Python側の生item(`source_key`が`[kind, topic]`の2要素配列)と、
    Web側の`buildApkg()`に渡すitem(`buildFieldsReadyItems()`済み、
    `source_kind`/`source_topic`がフラット)の形が異なるため、
    `verifyCardDef()`に`webItems`引数(省略時は`items`をそのまま使う)を
    追加して吸収している。
  - `npm run verify:grammar-multi`(`verify_grammar_multi_parity.mjs`):
    Grammar Multi固有の後処理(`_format_question_html`相当の改行整形、
    `_prefix_answer_with_correct_opt`相当の正解記号付与、choices/whynot/
    exampleのHTML化)が、固定した生のGemini応答JSONに対してPython版と
    一致するかを検証する。
  - `npm run test:ui`(`test_web_ui.mjs`): jsdom上で`index.html`+`app.js`を
    実際に動かし、単語タブ・AIに質問タブ(3問+習熟用4問目)・習熟用(音読)
    タブそれぞれで 生成→一覧→プレビュー→apkg出力→削除 の通し動作を
    確認する(タブ切り替え自体も検証する)。習熟用タブの出力確認では、
    apkg生成成功後にストックが空になること・続き番号カウンタが進むこと
    (`localStorage`の`anki_tool_shuujuku_next_num`)も検証している。
    **Gemini APIはfetchをモックするのでAPIキー・割り当てを消費しない**
    (その代わり、実際のGeminiが期待どおりのJSONを返すかはこのテストの
    対象外で、実機確認が必要)。生成中のローディング表示(スピナー)は
    fetchモックの応答が速すぎるため、`.click()`が同期的に実行する
    最初のawait直前(showLoading呼び出し)の時点、つまりclick()直後に
    確認する必要がある(sleepを挟むと生成そのものが終わってしまう)。
    sql.jsのwasmはブラウザではCDNから読むが、Nodeではローカルパスとして
    解決しようとして失敗するため、テスト側で`locateFile`を無視させている。
  - `npm run test:tts`(`test_tts.mjs`): `lib/tts.js`の単体テスト。
    `stripHtmlForTts`の変換結果、Cloud Text-to-Speechのエラー分類
    (429のQuota超過・5xxのリトライ・403のリファラー制限)、
    **音声の分割単位**(単語/AIに質問はフィールド全体で1つのMP3・タグ、
    習熟用は例文ごとに個別)をfetchモックで固定しているほか、
    2026-07-29に`computeWaveformMinMax`/`computePeakAmplitude`/`isClipped`
    (波形表示・0dBクリッピング検出)の単体テストを追加した(`AudioBuffer`は
    `{getChannelData: () => samples}`という最小限のフェイクで代用。
    `findSafeVolumeGainDb`は実際のWeb Audio APIデコードを要するためこの
    ファイルでは検証していない、上記「Web版のTTS波形表示・自動音量調整」
    参照)。
  - `npm run test:gemini`(`test_gemini.mjs`): `lib/gemini.js`の
    `callGemini()`のリトライ・エラー処理の単体テスト(503の自動リトライ、
    429の既存挙動の回帰確認)をfetchモックで行う。
  - `npm run test:sheets`(`test_sheets.mjs`、2026-07-29追加):
    `lib/sheets.js`(未出力行の取得・添削結果の追記・「Anki出力済み」列の
    マーク・401/403のエラー分類)と`lib/dailyconv.js`のローカル除外リストを
    fetchモックで単体テストする。**実際のスプレッドシートにもGoogle
    アカウントにも一切アクセスしない**。特に「シートの実ヘッダー行の並びに
    合わせて列を配置する(固定の列順を決め打ちしていない)」ことと、
    「markRowsAsExportedがAnki出力済み列のセルだけを対象にする」ことを
    固定している。
  - `npm run test:sync`(`test_sync.mjs`、2026-07-30追加): `lib/sync.js`の
    `mergeStock`(id単位の和集合、updated_at基準のLWW、tombstoneによる
    削除の伝播)・`ensureItemIds`(既存ストックへの移行)・`capacityPercent`と、
    `lib/sheets.js`の`readSyncState`/`writeSyncState`(隠しタブ`_AppSync`が
    無ければ`hidden:true`で自動作成し、固定レンジ`A1:B6`で読み書きすること)を
    fetchモックで検証する。詳細は下記「Web版の複数端末間の同期」を参照。
  - **`verify`系2本は`execFileSync('python3', ...)`とハードコードしている**
    ため、`python3`という名前で起動できるPythonが無い環境ではこの2本だけ
    失敗する(2026-07-28のClaude Code検証環境がこれに該当し、
    `C:\Python314\python.exe`しか無く実行できなかった)。片桐の実機で
    同様のエラーが出る場合は、この2ファイルの`'python3'`を実際に使える
    コマンド(`'python'`やフルパス)に直すこと。
- 実装時に判明した注意点:
  - `card_def_builder.build_deck_from_def()`は`due`を指定しないため、
    全カードの`due`は0になる(due_scheme: `{"type": "fixed_zero"}`)。
  - `grammar_multi_builder.build_deck()`は`due`にitemsのリスト内インデックス
    を使う(due_scheme: `{"type": "index"}`)。
  - `build_shuujuku_v1.build_deck()`は`due`にNumフィールドと同じ続き番号を
    使う(due_scheme: `{"type": "field", "key": "num"}`)。
  - `models.mod`はgenankiが書き出し時刻で埋める値。共有JSONには固定値
    (0)で入っているので、apkg生成時に現在時刻で上書きしている。
  - 日本語Windowsでは標準入出力の既定がcp932になるため、検証スクリプトは
    いずれもPython呼び出し時に`PYTHONUTF8=1`を渡している。

### Web版の複数端末間の同期(2026-07-30実装)

「作業内容(単語/AIに質問/習熟用の各ストック)を別のPC・スマホ間で同期したい」
という要望への対応。片桐から「今のGoogleログインの流用でなんとかならないか」
と聞かれ、調査の結果、**DailyConversation機能で既に使っている`spreadsheets`
スコープのGoogleログインをそのまま流用する形で実現した**(Drive APIへの
スコープ追加・再同意は不要)。保存先は「添削結果」スプレッドシート内に
自動作成する、片桐の目に触れない隠しタブ`_AppSync`(`docs/lib/sheets.js`の
`SYNC_SHEET_NAME`)。

**同期対象は単語/AIに質問/習熟用の3ストックのみ**。DailyConversationの
「未出力行」はシートそのものが実体のため、この3つと違って端末間で既に
自動的に同じ内容が見える(そもそもローカルに複製していない)。ローカルの
除外リスト(`daily_pending_exclusions`相当)・出力済み記録は端末ごとの
表示フィルターに過ぎず「作業内容」ではないと判断し、今回のスコープからは
意図的に外した。

#### トレードオフの緩和(単純な「後勝ち上書き」にしなかった理由)

同期を「リモートの内容で丸ごと上書き」する設計だと、同期し忘れた端末が
古いスナップショットで上書きし、他端末が追加した内容を消してしまう
リスクがある。これを緩和するため、**id単位の和集合マージ**
(`docs/lib/sync.js`の`mergeStock`)にした:

- 各ストック項目に生成時点で`id`(`newSyncId()`、UUID)と`updated_at`を
  持たせる(既存データには移行処理`ensureItemIds`が初回読み込み時に
  1回だけ付与する)。
- 同期のたびに「ローカルの内容」と「シートから読んだ内容」をidをキーに
  和集合で結合する。同じidが両側にあれば`updated_at`(無ければ
  `generated_at`)が新しい方を採用する単純なLast-Write-Wins。
  **フィールド単位の3-wayマージまでは行わない**(片桐一人が順番に
  端末を使う想定であれば実用上十分と判断)。
- 削除(選択削除・ストッククリア・習熟用の出力成功によるクリア)は
  「打ち消し記録(tombstone)」としてidを記録し(`onDeleteSelected`/
  `onClearStock`/`onExportShuujuku`が`addTombstoneIds`を呼ぶ)、
  同期時にローカル・リモート双方のtombstoneの和集合を取ってから
  マージ後の項目を除外する。**これが無いと、削除前の古いスナップショットを
  持つ端末が同期するたびに削除済み項目が復活してしまう**。
- 出力済み(`exported_at`)フラグのリセット(`onResetExported`)・出力成功時の
  `exported_at`付与(`onExport`)は、単なるフィールド変更として
  `updated_at`を打ち直すことで「新しい変更」として優先されるようにしてある
  (tombstoneは使わない。項目自体は消えないため)。
- 単語/AIに質問/習熟用ストックが既に持つ「重複していても常に追加→一覧で
  ⚠表示→手動で選んで削除」という設計と相性が良く、同期の衝突が起きても
  基本的にデータ消失ではなく「一覧に一時的に重複して見える」形に倒れ、
  既存の重複検出・手動削除UIでそのまま解消できる。

#### セル容量%の表示

片桐から「シートの1セルあたりの文字数上限(50,000文字)にどれだけ近づいて
いるか可視化したい」との要望があり、`docs/lib/sync.js`の
`capacityPercent(jsonString)`が同期のたびに各ストックのJSON文字列長を
50,000文字に対する割合(%)として計算し、同期完了時のステータス表示
(⚙設定「複数端末間の同期」)に「単語 x% / AIに質問 y% / 習熟用 z%」の形で出す。

#### 実装(複数端末間の同期)

- `docs/lib/sync.js`(新設): `mergeStock`/`ensureItemIds`/`capacityPercent`/
  `parseIdArray`/`newSyncId`。通信を一切持たない純粋関数のみで、
  `tools/test_sync.mjs`が単体テストする。
- `docs/lib/sheets.js`: `readSyncState`/`writeSyncState`(+ 内部の
  `ensureSyncSheetExists`)を追加。`_AppSync`タブが無ければ
  `spreadsheets.batchUpdate`の`addSheet`(`hidden: true`)で自動作成し、
  固定レンジ`A1:B6`(`SYNC_ROW_KEYS`、3ストック×items/tombstonesの6行)を
  1回のAPI呼び出しでまとめて読み書きする(往復回数・書き込みレースの窓を
  小さくするため)。
- `docs/app.js`: ⚙設定の「🔄 今すぐ同期」ボタン(`onSyncNow`)が
  ログイン→`readSyncState`→3ストックそれぞれ`mergeStock`→ローカル反映・
  再描画→`writeSyncState`を1回の操作で行う(pull-merge-pushをまとめることで
  レースの窓を小さくする設計。真の同時書き込みは想定していない)。
  単語/AIに質問/習熟用の生成箇所(`onWordGenerate`/`onAiAskGenerate`の
  3問生成・4問目の習熟用生成/`generateShuujukuCandidatesFromRows`)は
  すべて生成時に`id`/`updated_at`を付与するよう修正した。
  一覧のチェックボックスの`data-row-id`(`checkedRowIdsOf`が読む)も、
  この3タブについては配列インデックス(`String(i)`)からこの`id`に
  切り替えた(tombstone記録にそのまま使うため)。
- 同期は**自動実行ではなく手動ボタン**(端末を切り替える前後に押す運用を
  ⚙設定の説明文で案内している)。
- **Googleログインの窓口をヘッダーに一本化(2026-07-30)**: 同期機能を追加した
  当初、Googleログインの導線がDailyConversationタブの中にしか無く、他のタブ・
  ⚙設定を開いた状態から同期するにはわざわざDailyConversationタブを
  開いてログインし直す必要があった。片桐の指摘を受け、まずヘッダー
  (`⚙設定`ボタンの左)に常設のログインボタン(`header-signin`)を追加。
  さらに続けて「DailyConversationタブ側のログインUIは(ヘッダーと二重に
  なって)無駄なので削除、ただしログインしないと使えないことは明示してほしい」
  との指示を受け、DailyConversationタブの「① Googleにログイン」カード
  (ボタン2つ+ステータス表示)を完全に削除し、ログイン/ログアウトとも
  ヘッダー(`header-signin`/`header-signout`)だけに一本化した。
  - タブ削除に伴い見出し番号を繰り上げた: 旧②(英文入力)→①、
    旧③(未出力行一覧)→②、旧④(apkg出力)→③。本文中の相互参照
    (「②の一覧」「③のチェックボックス」等)もこれに合わせて修正した。
  - タブの先頭に警告色(`--warn-bg`、`.login-required-hint`)の注意書きを
    常設し、「ログインが必要」であることを明示した(削除前は「① Google
    にログイン」という見出し自体がその役割を兼ねていたため、単純に節を
    消すだけだと明示性が失われてしまう)。
  - ログイン状態の管理は`updateGoogleAuthStatus()`(旧`updateDailyAuthStatus`
    から改名。もうDailyConversationタブの要素を一切触らないため)に
    一本化してあり、`onHeaderSignIn`/`onHeaderSignOut`/
    `requireSheetsAccess`/`onSyncNow`等、ログイン状態が変わりうる箇所は
    全てこれを呼ぶだけでよい。
- **同期ボタンもヘッダーに追加(2026-07-30)**: ⚙設定を開かなくても同期できる
  よう、ログインボタンと同じ列に「🔄 同期」ボタン(`header-sync-now`)を
  追加した。⚙設定内の既存ボタン(`sync-now`、容量%の説明文と一緒に置いて
  あるため、そちらは削除せず残した)と実処理を共有できるよう、
  `onSyncNow`の中身を`runSync(statusEl, btnEl)`に切り出し、
  `onSyncNow`/`onHeaderSyncNow`はそれぞれ自分の表示先(`sync-status`/
  `header-sync-status`)を渡すだけにしてある。
- **既存のDailyConversationの認証・スプレッドシート設定(クライアントID・
  スプレッドシートID)をそのまま流用する**ため、同期専用の新しい設定項目は
  無い(シート名の設定は同期には使わない。`_AppSync`という固定タブ名を使う)。
- テスト: `tools/test_sync.mjs`(新設、`npm run test:sync`)が
  `mergeStock`の和集合・LWW・tombstone除外・`ensureItemIds`の移行・
  `capacityPercent`の計算・`readSyncState`/`writeSyncState`の隠しタブ
  自動作成をfetchモックで検証する。既存の`test_web_ui.mjs`等6本も
  この変更後に全て通過することを確認済み(2026-07-30)。

#### 出力済みカードの削除(セル容量対策、2026-07-30追加)

片桐から「AIに質問のセル使用率が19.6%とかなり高い」と報告を受けて対応した。
**原因**: `onExport`(単語/AIに質問の`.apkg`出力)は出力後もカードを削除せず
`exported_at`を付けてストックに残し続ける設計(2026-07-29、「出力済みタグ
管理」の項を参照)だが、`runSync`は出力済みも含めた**ストック全体**を
`_AppSync`タブへ書き込むため、出力済みカードが積み上がるほど同期のセル
使用率も際限なく増えていく。特にGrammar Multi(AIに質問)は
Question/Choices/Answer/Example/ExampleJA/Why/WhyNotと単語よりフィールド数・
HTML量が多く、影響を受けやすい。

- **対応**: 単語/AIに質問タブに「出力済みを削除」ボタン
  (`word-delete-exported`/`ai-ask-delete-exported`→`onDeleteExported(tabKey)`)
  を追加した。既存の「出力済み履歴をリセット」(`exported_at`フラグだけを
  消す、カードは残る)とは別物で、こちらは`exported_at`が付いたカードを
  **ストックから完全に削除**する。削除したidは`onClearStock`/
  `onDeleteSelected`と同じく打ち消し記録(tombstone)に残すため、次回の同期で
  リモート側からも取り除かれ、実際にセル使用率が下がる。
- **バックアップに関する検討(片桐からの指摘を受けた設計判断)**: 「デスクトップ版は
  `backup/`フォルダに生成apkgを自動保存しているが、Web版はどうなっているか」
  という指摘を受け調査した。**Web版には自動バックアップの仕組みが無い**
  ——`downloadBlob()`がブラウザの通常のダウンロード機構を呼ぶだけで、
  アプリ側は生成物を一切保持しない(File System Access APIで保存先フォルダを
  固定する案も検討したが、モバイルブラウザでの対応状況が不安定なため
  見送った。この点はデスクトップ版に対する明確な弱点として残る)。
  つまり「ストックの項目」こそが、Ankiへ取り込む前の内容を再現できる
  唯一のコピーであり、削除すると復元できない。この非対称性を踏まえ、
  `onDeleteExported`は**片桐が明示的にボタンを押した場合のみ**実行され、
  確認ダイアログで「ダウンロードした.apkgが実際にAnkiへ取り込み済みで
  あることを確認してから実行すること」「取り消せないこと」を明示する
  (`onResetExported`のように自動連鎖では絶対に呼ばない)。
- 習熟用(音読)タブには同種のボタンを追加していない。習熟用は元々
  `onExportShuujuku`が出力成功時にストック全体を空にする設計
  (2026-07-27時点の既存仕様、出力済みを残さない)のため、この問題自体が
  発生しない。
- テスト: `tools/test_web_ui.mjs`の単語タブのセクション[6.9]に、削除後に
  ストックが空になること・削除したidが打ち消し記録
  (`anki_tool_word_tombstones`)に残ることを検証するアサーションを追加した。

#### 未検証・既知の限界

- 片桐の実機での動作確認(実際にPC/スマホ間でシートを介した同期が
  意図通り動くか)はまだ行っていない。
- 真に同時(秒未満)に複数端末が同じ項目を編集した場合のフィールド単位の
  3-wayマージまでは行わない(item全体を`updated_at`で比較するだけ)。
- 打ち消し記録(tombstone)のidリストは無期限に増え続ける(デスクトップ版の
  `exported_keys`と同じ設計判断)。セル容量%の表示があるため、将来
  上限に近づいた場合は片桐が気づける想定だが、現時点で圧縮・古い記録の
  刈り込みは実装していない。

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
