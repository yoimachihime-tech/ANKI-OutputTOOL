# -*- coding: utf-8 -*-
"""apkgを読み込んでTTS音声を付ける、それだけを行うローカルツール。

■ このファイルの位置づけ
    PC版(tts_gui.py)の機能のうち「既存のapkgにTTS音声を付ける」だけを取り出し、
    画面をブラウザに移したもの。処理の実体は従来どおり tts_core.py が行う
    (このファイルにTTSのロジックを書かないこと。tts_gui.py と同じ約束)。

■ なぜブラウザから使うのに、画面もこのツールが配信するのか
    GitHub Pages(https://yoimachihime-tech.github.io)のページから
    http://127.0.0.1 を fetch する構成は、Chrome 151 の
    Local Network Access 権限に阻まれる(実測で LocalNetworkAccessPermissionDenied。
    プログラムからの権限付与も効かなかった)。ページ自体をこのツールが配信すれば
    同一オリジンになり、この制限の対象外になる(実測で確認済み)。
    そのためWeb版からは「リンクでこのページへ遷移する」形で繋ぐ
    (トップレベル遷移は制限を受けないことを確認済み)。

■ 使い方
    「apkgにTTS音声を付ける.bat」をダブルクリック
    → コンソールは出ず、ブラウザで http://127.0.0.1:8765/ が開く
    → 終了は画面の「ツールを終了する」ボタンから
    (コンソールを見ながら動かしたい場合は python local_tts_server.py)

■ 待ち受けは 127.0.0.1 のみ。他のPC・スマホからは到達できない(仕様)。
"""

import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

_HERE = os.path.dirname(os.path.abspath(__file__))


def _redirect_output_if_windowless():
    """pythonw.exe で起動すると sys.stdout / sys.stderr が None になり、
    print() が AttributeError で落ちる(_log が print を使っている)。
    コンソール(黒い画面)を出さずに常駐させるため、ログファイルへ向ける。

    **`import tts_core` より前に行うこと**(2026-10-26)。tts_core は anki を
    import するので、anki が入っていない・壊れている場合の ImportError が
    ここより前に起きると、pythonw では何も表示されず「押しても何も起きない」
    状態になっていた。
    """
    if sys.stdout is None or sys.stderr is None:
        log_file = open(os.path.join(_HERE, "local_tts_server.log"),
                        "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log_file
        return True
    return False


_WINDOWLESS = _redirect_output_if_windowless()


def _show_fatal(message):
    """起動できなかった理由を知らせる。pythonw ではコンソールが無いので
    Windows のメッセージボックスで出す(ログにも残す)。"""
    print(message)
    if _WINDOWLESS and os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                None, message, "apkgにTTS音声を付ける", 0x10)  # MB_ICONERROR
        except Exception:  # noqa: BLE001
            pass


try:
    import tts_core
except Exception as _e:  # noqa: BLE001
    traceback.print_exc()
    _show_fatal(
        "TTSツールを起動できませんでした(必要なパッケージを読み込めません)。\n\n"
        "%s: %s\n\n"
        "Ankiを更新した後などは、anki パッケージを入れ直してください:\n"
        "  C:\\Python314\\python.exe -m pip install --user anki\n\n"
        "詳しくは local_tts_server.log を見てください。" % (type(_e).__name__, _e))
    sys.exit(1)

PORT = 8765
OUTPUT_DIR = os.path.join(tts_core.BASE_DIR, "output")


def _work_dir():
    """作業用コレクションの置き場所。

    以前は pending_decks/(Googleドライブの同期フォルダの中)に置いていたが、
    同期中のファイルに SQLite を書くことになり、`WinError 32`(使用中で消せない)の
    一因になっていた(2026-10-26)。再開は書き出した .apkg から行うので、作業
    ファイルはPC内のローカルなフォルダで十分。取れなければ従来の場所を使う。
    """
    base = os.environ.get("LOCALAPPDATA")
    if base and os.path.isdir(base):
        return os.path.join(base, "AnkiTTSTool", "work")
    return os.path.join(tts_core.BASE_DIR, "pending_decks")


WORK_DIR = _work_dir()
DEFAULT_VOICE = "en-US-Chirp3-HD-Iapetus"


def _allowed_hosts():
    return {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}


def _allowed_origins():
    return {"http://" + h for h in _allowed_hosts()}

# 画面で選べる Gemini TTS のモデル(新しい順)
GEMINI_MODEL_CHOICES = [
    {"id": "gemini-3.8-flash-tts", "label": "Gemini 3.8 Flash TTS(最新・高品質)"},
    {"id": "gemini-3.8-flash-lite-tts", "label": "Gemini 3.8 Flash-Lite TTS(最新・高速/低コスト)"},
    {"id": "gemini-3.1-flash-tts-preview", "label": "Gemini 3.1 Flash TTS(プレビュー)"},
    {"id": "gemini-2.5-pro-preview-tts", "label": "Gemini 2.5 Pro TTS(プレビュー)"},
]

# 画面の設定名 → config.json のキー(「この設定を次回も使う」で保存するもの)
SAVABLE_SETTINGS = {
    "voice": "voice",
    "language_code": "language_code",
    "volume_gain_db": "volume_gain_db",
    "sentence_gap": "sentence_gap",
    "mp3_bitrate": "mp3_bitrate",
    "per_sentence_tags": "per_sentence_tags",
    "exclude_japanese": "exclude_japanese_sentences",
    "gemini_style": "gemini_tts_style",
}


def _missing_key_message(settings):
    """選んだ音声に必要なAPIキーが無ければ、その説明を返す(あれば空文字)。"""
    if settings.get("api_key"):
        return ""
    if tts_core.parse_gemini_voice(settings.get("voice", "")):
        return ("Gemini TTS を使うには Gemini のAPIキーが必要です。"
                "config.json の gemini_api_key を確認してください。")
    return ("Cloud Text-to-Speech のAPIキーが未設定です。"
            "config.json の api_key を確認してください。")


def synthesize_test_wav(settings, text=""):
    """テスト再生用の音声(WAV)を作る。文と文の間隔も本番と同じに挟む。

    text が空なら tts_core の固定のサンプル文2つを使う。"""
    tts_core.GEMINI_TTS_STYLE = settings.get("gemini_style", "")
    sentences = [s for s in tts_core.split_into_sentences(text or "") if s.strip()]
    if not sentences:
        sentences = list(tts_core.TEST_SAMPLE_SENTENCES)
    chunks = [
        tts_core.call_google_tts_wav(
            sent, settings["voice"], settings["language_code"], settings["api_key"],
            volume_gain_db=float(settings.get("volume_gain_db") or 0.0))
        for sent in sentences[:5]   # 長い文章を貼られても呼び出しすぎないよう5文まで
    ]
    return tts_core.concat_wav_with_silence(chunks, float(settings.get("sentence_gap") or 0.0))


# ---------------------------------------------------------------------------
# 状態(単一利用者を前提とした、プロセス内の1セットだけ)
# ---------------------------------------------------------------------------
class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.col = None
        self.source_name = ""      # 読み込んだapkgのファイル名
        self.job = None            # 実行中/直近のジョブ(dict)
        self.cancel = False
        # 直近に書き出したapkg。TTS生成でもテンプレート調整でも更新するので、
        # /api/download はこれを見る(どちらの操作の後でもダウンロードできる)。
        self.last_output = ""
        # 読み込んだ後にコレクションへ書き込んだが、まだ書き出していない(2026-10-26)。
        # 書き出しだけが失敗した場合(出力先のファイルが使用中・ディスクがいっぱい等)、
        # 生成した音声はこのコレクションの中にしか無い。もう一度「TTSを生成する」を
        # 押しても対象が0件になって書き出しまで進まないため、書き出しだけを
        # やり直せるようにする目印。
        self.dirty = False
        self.worker = None         # 生成スレッド(終了時に待つため)
        self.shutting_down = False


STATE = State()


def _job_running():
    return bool(STATE.job and STATE.job.get("running"))


def _reset_job():
    return {
        "running": False, "done": 0, "total": 0, "log": [],
        "finished": False, "error": "", "output_path": "", "cancelled": False,
        "interrupted": False, "started_at": time.time(), "api_calls": 0,
    }


def _log(msg):
    job = STATE.job
    if job is not None:
        job["log"].append(msg)
        del job["log"][:-400]   # 際限なく溜めない
    print(msg)


# ---------------------------------------------------------------------------
# apkgの読み込みとフィールドの下調べ
# ---------------------------------------------------------------------------
def _prepare_work_col_path():
    """作業用コレクションのパスを用意する。

    2回目以降の読み込みでは、前回のCollectionが作業ファイルを開いたままだと
    Windowsでは削除できず `WinError 32` になる(実際に踏んだ)。まず前回の
    コレクションを閉じ、それでも消せない場合は別名にして先へ進める。
    """
    with STATE.lock:
        old = STATE.col
        STATE.col = None
        STATE.source_name = ""
        STATE.last_output = ""
        STATE.dirty = False
    if old is not None:
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass

    # 前回までの作業ファイルを片付ける。メディアフォルダ(<名前>.media)には
    # これまでに生成したMP3がすべて残り続けるため、放っておくと際限なく増える
    # (再開は書き出した .apkg から行うので、ここに残しておく必要は無い)。
    if os.path.isdir(WORK_DIR):
        for name in os.listdir(WORK_DIR):
            if not name.startswith("_local_tts_work"):
                continue
            target = os.path.join(WORK_DIR, name)
            try:
                if os.path.isdir(target):
                    shutil.rmtree(target)
                else:
                    os.remove(target)
            except OSError:
                pass   # 使用中などで消せないものは、次の機会に回す

    path = os.path.join(WORK_DIR, "_local_tts_work.anki2")
    if os.path.exists(path):
        path = os.path.join(WORK_DIR, "_local_tts_work_%d.anki2" % int(time.time()))
    return path


def _output_path_for(source_name):
    """書き出し先のパス。

    `deck_TTS.apkg` を読み込んで続きを作った場合も `deck_TTS.apkg` に書き出す
    (以前は `deck_TTS_TTS.apkg` になり、再開するたびに名前が伸びていた)。
    """
    stem = os.path.splitext(os.path.basename(source_name or "deck.apkg"))[0]
    stem = re.sub(r"(_TTS)+$", "", stem) or "deck"
    return os.path.join(OUTPUT_DIR, "%s_TTS.apkg" % stem)


def _export_to_output(col):
    """コレクションを出力先へ書き出す。

    一時ファイルへ書き切ってから置き換える(2026-10-26)。書き出しの途中で
    ツールを終了した・ディスクがいっぱいになった場合に、前回の良い出力が
    中途半端なファイルで上書きされて失われないようにするため。
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = _output_path_for(STATE.source_name)
    tmp_path = out_path[:-len(".apkg")] + ".writing.apkg"
    tts_core.export_collection(col, tmp_path)
    os.replace(tmp_path, out_path)
    STATE.last_output = out_path
    STATE.dirty = False
    return out_path


def _describe_previous_output(source_name):
    """同じ名前の出力が既にあれば、その情報を返す(読み込んだのがその出力自身なら無し)。

    「1日目は上限で300件まで → 2日目にうっかり元のapkgを読み込んで続きを作る」と、
    300件分の出力を50件分で上書きしてしまう。読み込んだ時点で気づけるようにする。
    """
    out_path = _output_path_for(source_name)
    if not os.path.exists(out_path):
        return None
    if os.path.basename(source_name or "") == os.path.basename(out_path):
        return None
    return {"name": os.path.basename(out_path),
            "mtime": time.strftime("%m/%d %H:%M", time.localtime(os.path.getmtime(out_path)))}


def open_apkg(apkg_bytes, filename):
    """apkgを読み込み、ノートタイプとフィールドの一覧(サンプル付き)を返す。

    フィールドごとに「中身のある件数」「既に音声がある件数」「サンプル文字列」を
    返すのは、どのフィールドがTTS対象になりうるかを画面上で判断できるようにするため
    (例: 先頭フィールドがデッキ名だった場合、選ばずに済む)。
    「日本語を含む件数」も返す(2026-10-26)。名前がENで終わっていても、習熟用の
    `I1PatternEN` のように「動詞」「名詞」などのプレースホルダーが混じる
    フィールドがあり、英語の音声で日本語を読み上げてしまうため。
    """
    os.makedirs(WORK_DIR, exist_ok=True)
    tmp_apkg = os.path.join(WORK_DIR, "_local_tts_input.apkg")
    with open(tmp_apkg, "wb") as f:
        f.write(apkg_bytes)

    col = tts_core.load_collection(tmp_apkg, _prepare_work_col_path())

    notetypes = []
    for nt in col.models.all():
        name = nt["name"]
        note_ids = col.find_notes("mid:%d" % nt["id"])
        if not note_ids:
            # apkgには使われていない標準ノートタイプ(Basic等)も入ってくるので除く
            continue

        field_names = [f["name"] for f in nt["flds"]]
        count = len(field_names)
        nonempty = [0] * count
        samples = [""] * count
        has_audio = [0] * count
        japanese = [0] * count
        # 実際の読み上げと同じ変換を通してから日本語を探す(Grammar Multi は
        # 日本語の文を最初から読まないので、そこで数えると誤警告になる)
        transform = tts_core.default_source_transform(name, False)

        for nid in note_ids:
            note = col.get_note(nid)
            for i, raw in enumerate(note.fields):
                if i >= count:
                    break
                if tts_core.SOUND_TAG_RE.search(raw):
                    has_audio[i] += 1
                text = tts_core.strip_html_for_tts(tts_core.strip_sound_tags(raw)).strip()
                if text:
                    nonempty[i] += 1
                    if not samples[i]:
                        samples[i] = text[:60]
                    if tts_core.contains_japanese(_tts_text(raw, transform)):
                        japanese[i] += 1

        notetypes.append({
            "name": name,
            "note_count": len(note_ids),
            "fields": [
                {"index": i, "name": field_names[i], "nonempty": nonempty[i],
                 "has_audio": has_audio[i], "japanese": japanese[i], "sample": samples[i]}
                for i in range(count)
            ],
        })

    notetypes.sort(key=lambda x: -x["note_count"])
    with STATE.lock:
        STATE.col = col
        STATE.source_name = filename or "deck.apkg"
        STATE.job = None
    return {"filename": STATE.source_name, "notetypes": notetypes,
            "template_tts": count_template_tts(col),
            "previous_output": _describe_previous_output(STATE.source_name)}


# カードテンプレートに書かれた Anki 標準のTTSタグ。
# `{{tts en_US:I1BaseEN}}` は Anki 自身が端末の音声で読み上げるボタンを出すもので、
# フィールドに `[sound:...]` が無くてもボタンが表示される。このツールが埋め込む
# Cloud TTS の音声と並ぶと、再生ボタンが2つ出て紛らわしい(片桐から報告)。
# 実データでは `<span class="tts-btn">{{tts ...}}</span>` の形で入っていたので、
# 空のspanが残らないよう、その包みごと消す方を先に試す。
_TEMPLATE_TTS_RE = re.compile(
    r'<span class="tts-btn">\s*\{\{tts[^}]*\}\}\s*</span>|\{\{tts[^}]*\}\}')


def count_template_tts(col):
    """カードテンプレートに書かれた {{tts}} タグの数を数える。"""
    total = 0
    for nt in col.models.all():
        for tmpl in nt["tmpls"]:
            for side in ("qfmt", "afmt"):
                total += len(_TEMPLATE_TTS_RE.findall(tmpl.get(side) or ""))
    return total


def strip_template_tts(col):
    """カードテンプレートから {{tts}} タグを取り除く(ノートの中身は触らない)。

    戻り値は {ノートタイプ名: 取り除いた数}。
    """
    removed = {}
    for nt in col.models.all():
        count = 0
        for tmpl in nt["tmpls"]:
            for side in ("qfmt", "afmt"):
                before = tmpl.get(side) or ""
                after, n = _TEMPLATE_TTS_RE.subn("", before)
                if n:
                    tmpl[side] = after
                    count += n
        if count:
            # 新しいAnkiは update_dict、古いものは save
            if hasattr(col.models, "update_dict"):
                col.models.update_dict(nt)
            else:  # pragma: no cover
                col.models.save(nt)
            removed[nt["name"]] = count
    return removed


def _source_transform_for(options, nt_name=""):
    """TTSに渡す前のテキスト変換。tts_gui._get_source_transform_for と同じ規則
    (tts_core.default_source_transform)。ノートタイプによって変わるので
    (Grammar Multi は日本語を読み上げない)、ノートタイプごとに求めること。"""
    return tts_core.default_source_transform(nt_name, bool(options.get("exclude_japanese")))


def _tts_text(raw_field, transform):
    """TTSに実際に渡すテキストを作る(文字数の見積もり・文数の判定用)。

    `tts_core.analyze_targets` の中でやっている手順と同じにしてあるので、
    向こうを変えたらここも合わせること。
    """
    src = tts_core.strip_sound_tags(raw_field)
    if transform:
        src = transform(src)
    return tts_core.strip_html_for_tts(src)


def _build_plan(col, targets, options):
    """処理対象の一覧を組み立てる(ドライランと本番で同じものを使う)。

    `redo_multi_audio` は「音声が2つ以上入ってしまったフィールドだけ作り直す」
    モード。「文ごとにタグを分ける」がONだと複数文のフィールドに音声が
    複数付き、Anki上で再生ボタンが2つ並ぶ。これを直すのに全件を
    force_regen すると、大半を占める1文だけのフィールドまで作り直して
    無駄に時間と割り当てを使うため、該当分だけを選べるようにしてある。
    """
    redo_multi = bool(options.get("redo_multi_audio"))
    force = True if redo_multi else bool(options.get("force_regen"))
    per_sentence = bool(options.get("per_sentence_tags"))
    try:
        gap = float(options.get("sentence_gap") or 0)
    except (TypeError, ValueError):
        gap = 0.0

    rows = []
    for t in targets:
        name = t["notetype"]
        fields = [int(i) for i in t.get("fields", [])]
        if not fields:
            continue
        transform = _source_transform_for(options, name)

        to_process, skip_audio, skip_empty, chars = tts_core.analyze_targets(
            col, name, fields, force, source_transform=transform
        )

        if redo_multi:
            kept = []
            chars = 0
            for nid, field_idx in to_process:
                raw = col.get_note(nid).fields[field_idx]
                if len(tts_core.SOUND_TAG_RE.findall(raw)) < 2:
                    continue
                kept.append((nid, field_idx))
                chars += len(_tts_text(raw, transform))
            to_process = kept
            skip_audio = 0   # このモードでは「音声済みで飛ばす」の意味が変わるため出さない

        # 「文ごとにタグを分ける」がONのとき、再生ボタンが2つ以上になる件数を予告する。
        # API呼び出し回数の見積もりもここで出す(2026-10-26)。以前は画面に
        # 「件数がそのままAPI呼び出し回数」と書いていたが、2文以上のフィールドは
        # 「文ごとにタグを分ける」か「文と文の間隔」が0より大きいと文の数だけ
        # 呼ぶ(tts_core.synthesize_per_sentence / synthesize_with_gaps)。
        multi_sentence = 0
        api_calls = 0
        for nid, field_idx in to_process:
            # 既存の [sound:] は読み上げないので先に外す(外さないと、作り直す
            # モードでタグが1文として数えられ、見積もりが膨らんでいた)
            raw = tts_core.strip_sound_tags(col.get_note(nid).fields[field_idx])
            if transform:
                raw = transform(raw)
            n = len([s for s in tts_core.split_into_sentences(raw) if s.strip()])
            if n > 1 and per_sentence:
                multi_sentence += 1
            api_calls += n if n > 1 and (per_sentence or gap > 0) else 1

        rows.append({"notetype": name, "items": len(to_process), "chars": chars,
                     "skip_audio": skip_audio, "skip_empty": skip_empty,
                     "multi_sentence": multi_sentence, "api_calls": api_calls,
                     "_to_process": to_process})
    return rows, force


def analyze(targets, options):
    """ドライラン。実際には何も生成せず、対象件数と文字数だけを数える。"""
    col = STATE.col
    if col is None:
        raise RuntimeError("apkgが読み込まれていません。")

    rows, _ = _build_plan(col, targets, options)
    totals = {"total_items": 0, "total_chars": 0, "total_skip_audio": 0,
              "total_skip_empty": 0, "total_multi_sentence": 0, "total_api_calls": 0}
    for r in rows:
        totals["total_items"] += r["items"]
        totals["total_chars"] += r["chars"]
        totals["total_skip_audio"] += r["skip_audio"]
        totals["total_skip_empty"] += r["skip_empty"]
        totals["total_multi_sentence"] += r["multi_sentence"]
        totals["total_api_calls"] += r["api_calls"]
    totals["output_name"] = os.path.basename(_output_path_for(STATE.source_name))

    # _to_process は内部用なので画面へは返さない
    public = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    return dict(totals, rows=public)


# ---------------------------------------------------------------------------
# 生成(バックグラウンドスレッド)
# ---------------------------------------------------------------------------
def _run_generate(targets, options, settings):
    """TTSを生成する。

    **途中で止まっても、そこまでの分は必ず書き出す**(2026-08-19)。
    無料枠を使い切った・割り当てに達した場合、tts_core は待っても回復しない
    種類のエラーをリトライせず即座に投げる。以前はその例外で書き出しごと
    飛ばしていたため、何百件生成した分がまるごと失われ、次回また同じ料金を
    払い直すことになっていた。生成済みのノートは既に col 側へ書き込まれて
    いるので、書き出しさえすれば無駄にならない。

    再開もそのまま効く: `[sound:...]` が入ったフィールドは analyze_targets が
    「音声済み」として飛ばすため、同じ画面でもう一度実行すれば続きから進む
    (書き出したapkgを読み込み直した場合も同じ)。
    """
    job = STATE.job
    col = STATE.col
    error = ""
    # Gemini TTS の「読み方の指示」(3.8以降)。tts_core はモジュール変数で受け取る
    # (既存の関数の引数を増やさずに済ませるため。Cloud TTS では使われない)。
    tts_core.GEMINI_TTS_STYLE = settings.get("gemini_style", "")
    try:
        # 先に全ノートタイプ分の対象を数えてから走る(進捗の分母を最初に確定させるため)。
        # ドライランと同じ _build_plan を使うので、「件数を数える」で見た数と
        # 実際に処理される数が食い違うことはない。
        rows, force = _build_plan(col, targets, options)
        plan = [(r["notetype"], r["_to_process"]) for r in rows]
        total = sum(len(p[1]) for p in plan)

        job["total"] = total
        job["api_calls"] = sum(r["api_calls"] for r in rows)
        if total == 0:
            # 「0件」だけだと原因が分からない。実際に踏んだのは
            # 「apkgを作り直して同じ名前で上書きしたが、ブラウザが同じパスの
            #  選び直しでchangeを発火せず、前回の生成済みコレクションが
            #  残っていた」というケースだったので、その線を最初に案内する。
            skipped = sum(r["skip_audio"] for r in rows)
            hint = "フィールドの選択を確認してください。"
            if skipped:
                hint = ("選んだフィールドのうち %d 件は既に音声が入っているため飛ばしました。\n"
                        "・apkgを作り直した場合: ①でファイルを選び直してください"
                        "(読み込めていれば「既に音声があるフィールド」が0件になります)。\n"
                        "・音声を作り直したい場合: ③の「既存の音声を作り直す」をONにしてください。"
                        % skipped)
            raise RuntimeError("対象が0件です。" + hint)
        _log("合計 %d 件のフィールドにTTSを生成します。" % total)

        base_done = 0
        for name, to_process in plan:
            if STATE.cancel:
                # 直前のノートタイプの最後の1件の処理中にキャンセルされると、
                # generate_tts_for_collection は cancelled=False で戻ってくる。
                # ここで印を付けないと、残りのノートタイプを飛ばしたのに
                # 画面には「完了しました」と出てしまう(2026-10-26修正)。
                job["cancelled"] = True
                _log("キャンセルされました。残りのノートタイプは処理しません。")
                break
            if not to_process:
                continue
            _log("--- %s: %d 件 ---" % (name, len(to_process)))

            def on_progress(done, _total, _base=base_done):
                job["done"] = _base + done
                STATE.dirty = True

            result = tts_core.generate_tts_for_collection(
                col, name, to_process,
                api_key=settings["api_key"],
                voice=settings["voice"],
                lang=settings["language_code"],
                gap_seconds=float(settings["sentence_gap"]),
                bitrate=int(settings["mp3_bitrate"]),
                per_sentence=bool(settings["per_sentence_tags"]),
                force_regen=force,
                volume_gain_db=float(settings["volume_gain_db"]),
                source_transform=_source_transform_for(options, name),
                log=_log,
                on_progress=on_progress,
                should_cancel=lambda: STATE.cancel,
            )
            base_done += result.processed
            job["done"] = base_done
            if result.cancelled:
                job["cancelled"] = True
                break
    except Exception as e:  # noqa: BLE001
        error = str(e)
        job["interrupted"] = True
        _log("中断しました: " + error)
        traceback.print_exc()

    # 成功・キャンセル・エラーのいずれでも、生成できた分は必ず書き出す。
    # (PC版が「キャンセル時も途中状態を保持する」設計なのと同じ考え方を、
    #  エラーで止まった場合にも広げたもの)
    try:
        # 書き出しの直前にテンプレートを調整する。⑤の単独実行だと
        # 「読み込む → 生成 → 書き出し」の後にもう一度押す必要があり、
        # 順番を間違えると元のテンプレートのまま書き出されてしまう
        # (実際に、取り除いたはずのボタンが残ったファイルが出来た)。
        if options.get("strip_template_tts") and job["done"] > 0:
            removed = strip_template_tts(col)
            if removed:
                _log("テンプレートの {{tts}} を %d 個取り除きました(%s)。"
                     % (sum(removed.values()), " / ".join(removed)))

        if job["done"] > 0:
            _log("書き出し中: %s" % _output_path_for(STATE.source_name))
            job["output_path"] = _export_to_output(col)
            _log("完了しました。" if not error and not job["cancelled"] else
                 "ここまでの %d 件を書き出しました。" % job["done"])
    except Exception as e:  # noqa: BLE001
        # 書き出しにも失敗した場合、生成側のエラーを消さずに併記する
        # (原因の切り分けができなくなるため)。生成した音声は作業用の
        # コレクションに残っているので、画面の「書き出しだけやり直す」で救える。
        extra = "書き出しに失敗しました: %s" % e
        error = (error + "\n" + extra) if error else extra
        job["export_failed"] = True
        _log(extra)
        traceback.print_exc()

    job["error"] = error
    job["running"] = False
    job["finished"] = True


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AnkiLocalTTS/1.0"

    def log_message(self, fmt, *args):
        pass

    # -- 補助 ---------------------------------------------------------------
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in _allowed_origins()

    def _host_ok(self):
        """Host ヘッダーが 127.0.0.1 / localhost のときだけ応じる(2026-10-26)。

        待ち受けは 127.0.0.1 だけだが、DNSリバインディング(外部のサイトが
        自分のドメイン名を 127.0.0.1 に向け直す手口)を使われると、GETは
        Origin の検査を通らないため、書き出した .apkg を読み出されうる。
        正規の画面は必ず 127.0.0.1:8765 で開くので、それ以外は断る。
        """
        return (self.headers.get("Host") or "") in _allowed_hosts()

    def _reject_while_running(self, what):
        """生成中に受け付けると壊れる操作を断る(2026-10-26)。"""
        if not _job_running():
            return False
        self._json({"error": "TTSを生成中のため、%sできません。"
                             "④の「キャンセル」で止めてから(止めるとそこまでの分を"
                             "書き出します)もう一度操作してください。" % what, "running": True},
                   409)
        return True

    def _send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_body(self):
        # bytes を += でつなぐと毎回全体をコピーするため、数百MBのapkgでは
        # 非常に遅くなる。bytearray に読み足していく。
        length = int(self.headers.get("Content-Length") or 0)
        buf = bytearray()
        while len(buf) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    # -- ルーティング -------------------------------------------------------
    def do_GET(self):  # noqa: N802
        if not self._host_ok():
            self._json({"error": "許可されていないホスト名です。"}, 403)
            return
        # 失敗しても応答を返す(以前は config.json を読めないなどの例外で接続ごと
        # 切れ、画面には理由が出なかった)。
        try:
            self._route_get(self.path.split("?")[0])
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def _route_get(self, path):
        if path == "/":
            self._send(200, PAGE_HTML.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/api/settings":
            cfg = tts_core.load_config()
            self._json({
                "voice": cfg.get("voice", DEFAULT_VOICE),
                "language_code": cfg.get("language_code", "en-US"),
                "sentence_gap": cfg.get("sentence_gap", 0.5),
                "mp3_bitrate": cfg.get("mp3_bitrate", 64),
                "per_sentence_tags": cfg.get("per_sentence_tags", False),
                "volume_gain_db": cfg.get("volume_gain_db", 0.0),
                "exclude_japanese": cfg.get("exclude_japanese_sentences", False),
                "gemini_style": cfg.get("gemini_tts_style", ""),
                "force_regen": False,
                # キーそのものは画面へ出さない(あるかどうかだけ)
                "has_api_key": bool(cfg.get("api_key")),
                "has_gemini_key": bool(cfg.get("gemini_api_key")),
                # Gemini TTS の音声を .apkg 用の MP3 にするのに要る。無いと
                # 1件目を(料金を払って)作った後で失敗するので、先に画面で知らせる。
                "has_lameenc": bool(tts_core.LAMEENC_AVAILABLE),
                # 画面の選択肢(2026-10-05追加)
                "prebuilt_voices": tts_core.PREBUILT_VOICE_NAMES,
                "gemini_models": GEMINI_MODEL_CHOICES,
                "cloud_voice_cache": cfg.get("voices_cache", {}),
                "output_dir": OUTPUT_DIR,
            })
        elif path == "/api/progress":
            # 画面を開き直したとき(再読み込み・バッチの二重起動で開いた別タブ)に、
            # 実行中のジョブへつなぎ直せるよう、読み込み中のファイル名なども返す。
            payload = dict(STATE.job or _reset_job())
            payload.update({
                "source_name": STATE.source_name,
                "loaded": STATE.col is not None,
                "needs_export": bool(STATE.dirty and STATE.col is not None
                                     and not _job_running()),
                "last_output": STATE.last_output,
                "elapsed": time.time() - payload.get("started_at", time.time()),
            })
            self._json(payload)
        elif path == "/api/download":
            out = STATE.last_output or (STATE.job or {}).get("output_path")
            if not out or not os.path.exists(out):
                self._json({"error": "生成された.apkgがありません。"}, 404)
                return
            with open(out, "rb") as f:
                data = f.read()
            name = urllib.parse.quote(os.path.basename(out))
            self._send(200, data, "application/octet-stream",
                       {"Content-Disposition": "attachment; filename*=UTF-8''%s" % name})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        # 本文は先に読み切る(読まずに 403 を返すと、keep-alive の接続に
        # 読み残しが残って次のリクエストが壊れる)
        body = self._read_body()
        if not self._host_ok() or not self._origin_ok():
            self._json({"error": "許可されていないオリジンです。"}, 403)
            return
        path = self.path.split("?")[0]
        try:
            if path == "/api/open":
                # 生成中に読み込むと、生成スレッドが使っているコレクションを
                # 閉じて作業ファイルを消してしまい、それまでの生成分が書き出されずに
                # 失われていた(2026-10-26修正)。
                if self._reject_while_running("別のapkgを読み込むことは"):
                    return
                filename = urllib.parse.unquote(self.headers.get("X-Filename", ""))
                self._json(open_apkg(body, filename))
                return

            payload = json.loads(body.decode("utf-8")) if body else {}

            if path == "/api/analyze":
                self._json(analyze(payload.get("targets", []), payload.get("options", {})))
            elif path == "/api/generate":
                if _job_running():
                    self._json({"error": "すでに生成中です。", "running": True}, 409)
                    return
                if STATE.shutting_down:
                    self._json({"error": "ツールを終了しているところです。"}, 409)
                    return
                if STATE.col is None:
                    self._json({"error": "apkgが読み込まれていません。"}, 400)
                    return
                settings = self._merged_settings(payload.get("settings", {}))
                missing = _missing_key_message(settings)
                if missing:
                    self._json({"error": missing}, 400)
                    return
                if (tts_core.parse_gemini_voice(settings["voice"])
                        and not tts_core.LAMEENC_AVAILABLE):
                    self._json({"error": "Gemini TTS の音声を .apkg に入れるには lameenc が"
                                         "必要です(C:\\Python314\\python.exe -m pip install"
                                         " --user lameenc)。"}, 400)
                    return
                STATE.cancel = False
                STATE.job = _reset_job()
                STATE.job["running"] = True
                # daemon にしない(2026-10-26)。daemon だと、ツールの終了で
                # 書き出しの途中でも打ち切られ、生成分が失われうる。
                STATE.worker = threading.Thread(
                    target=_run_generate,
                    args=(payload.get("targets", []), payload.get("options", {}), settings),
                )
                STATE.worker.start()
                self._json({"ok": True})
            elif path == "/api/test-tts":
                # テスト再生(2026-10-05追加)。いまの画面の設定で短い文を読み上げ、
                # WAV をそのまま返す(画面の <audio> で再生する)。
                # 生成中は断る: Gemini の「読み方の指示」はモジュール変数で
                # 渡しているため、テスト再生で書き換えると実行中の生成の
                # 残りの分まで変わってしまう。
                if self._reject_while_running("テスト再生は"):
                    return
                settings = self._merged_settings(payload.get("settings", {}))
                missing = _missing_key_message(settings)
                if missing:
                    self._json({"error": missing}, 400)
                    return
                wav = synthesize_test_wav(settings, payload.get("text", ""))
                peak = tts_core.compute_peak_amplitude(wav)
                self._send(200, wav, "audio/wav", {
                    "X-Peak": "%.4f" % peak,
                    "X-Duration": "%.3f" % tts_core.wav_duration_seconds(wav),
                })
            elif path == "/api/voices":
                # Cloud TTS の音声一覧(言語ごと)。config.json の voices_cache にも
                # 保存するので、PC版と同じ一覧を共有できる。
                lang = (payload.get("language_code") or "en-US").strip()
                cfg = tts_core.load_config()
                if not cfg.get("api_key"):
                    self._json({"error": "config.json に api_key(Cloud TTS)がありません。"}, 400)
                    return
                names = tts_core.list_google_voices(lang, cfg["api_key"])
                cache = cfg.get("voices_cache") or {}
                cache[lang] = names
                cfg["voices_cache"] = cache
                tts_core.save_config(cfg)
                self._json({"language_code": lang, "voices": names})
            elif path == "/api/save-settings":
                # 画面の設定を config.json に保存する(次回の既定にする)。
                # APIキーには触れない。
                incoming = payload.get("settings", {})
                cfg = tts_core.load_config()
                for key, cfg_key in SAVABLE_SETTINGS.items():
                    if key in incoming:
                        cfg[cfg_key] = incoming[key]
                tts_core.save_config(cfg)
                self._json({"ok": True})
            elif path == "/api/strip-template-tts":
                if STATE.col is None:
                    self._json({"error": "apkgが読み込まれていません。"}, 400)
                    return
                if self._reject_while_running("テンプレートの調整は"):
                    return
                removed = strip_template_tts(STATE.col)
                if not removed:
                    self._json({"removed": {}, "output_path": "",
                                "message": "テンプレートに {{tts}} タグはありませんでした。"})
                    return
                STATE.dirty = True
                out_path = _export_to_output(STATE.col)
                self._json({"removed": removed, "output_path": out_path})
            elif path == "/api/export":
                # 書き出しだけやり直す(2026-10-26)。書き出しが失敗した場合
                # (出力先が使用中・ディスクがいっぱい等)、生成した音声は
                # 作業用コレクションにしか残っていない。
                if STATE.col is None:
                    self._json({"error": "apkgが読み込まれていません。"}, 400)
                    return
                if self._reject_while_running("書き出しは"):
                    return
                out_path = _export_to_output(STATE.col)
                self._json({"output_path": out_path})
            elif path == "/api/open-folder":
                # 書き出し先のフォルダをエクスプローラーで開く(2026-10-26)
                os.makedirs(OUTPUT_DIR, exist_ok=True)
                target = STATE.last_output if (payload.get("select")
                                               and os.path.exists(STATE.last_output or "")) else ""
                if target and os.name == "nt":
                    subprocess.Popen(["explorer", "/select,", os.path.normpath(target)])
                elif hasattr(os, "startfile"):
                    os.startfile(OUTPUT_DIR)  # noqa: S606
                self._json({"ok": True, "path": OUTPUT_DIR})
            elif path == "/api/cancel":
                STATE.cancel = True
                self._json({"ok": True})
            elif path == "/api/shutdown":
                # コンソールを出さずに起動する(pythonw)ため、画面から終了できる
                # 手段が要る。応答を返し切ってから別スレッドで止める
                # (serve_forever を回しているスレッドから shutdown() を呼ぶと
                #  自分自身を待って固まるため)。
                # 生成中(キャンセル後の書き出し中も含む)は断る。以前はそのまま
                # 止めてしまい、生成分が書き出されずに失われることがあった。
                if self._reject_while_running("ツールを終了"):
                    return
                # 確認してから止まるまでの間に、別のタブから生成を始められないようにする
                STATE.shutting_down = True
                self._json({"ok": True})
                if SERVER is not None:
                    threading.Thread(target=SERVER.shutdown, daemon=True).start()
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def _merged_settings(self, incoming):
        """画面で変更した値を config.json の値に重ねる(APIキーは常にconfigのもの)。

        APIキーだけは画面から送らせない。ブラウザ側に持ち出す必要が無く、
        持ち出さなければ漏れようが無いため。
        """
        cfg = tts_core.load_config()
        voice = incoming.get("voice") or cfg.get("voice", DEFAULT_VOICE)
        return {
            # Gemini TTS("gemini:..." の音声)なら Gemini のキーを使う
            "api_key": tts_core.tts_api_key_for_voice(voice, cfg),
            "voice": voice,
            "gemini_style": incoming.get("gemini_style", cfg.get("gemini_tts_style", "")),
            "language_code": incoming.get("language_code") or cfg.get("language_code", "en-US"),
            "sentence_gap": incoming.get("sentence_gap", cfg.get("sentence_gap", 0.5)),
            "mp3_bitrate": incoming.get("mp3_bitrate", cfg.get("mp3_bitrate", 64)),
            "per_sentence_tags": incoming.get("per_sentence_tags",
                                              cfg.get("per_sentence_tags", False)),
            "volume_gain_db": incoming.get("volume_gain_db", cfg.get("volume_gain_db", 0.0)),
        }


class QuietServer(http.server.ThreadingHTTPServer):
    """ブラウザ側が接続を切っただけ(タブを閉じた・再読み込みした)のときに、
    ログへ長いトレースバックを残さない(2026-10-05)。本物のエラーは従来どおり出す。

    SO_REUSEADDR は使わない(2026-10-26)。HTTPServer の既定(allow_reuse_address)
    だと、Windows では使用中のポートにもう1つ bind できてしまい、バッチを素早く
    2回押す・バッチとWeb版のボタンを両方押すと2つのツールが同じポートで動き、
    リクエストが両者に振り分けられて「apkgが読み込まれていません」になっていた。
    SO_EXCLUSIVEADDRUSE までは付けない(終了直後の TIME_WAIT の接続が残っていると
    bind できなくなり、終了してすぐ起動し直したときに失敗するため)。
    """

    allow_reuse_address = False

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


PAGE_HTML = ""  # main() で local_tts_page.html を読み込んで差し替える
SERVER = None   # /api/shutdown から止めるための参照


def _port_owner():
    """ポートの持ち主を調べる。"ours"(このツール)/ "other"(別のプログラム)/ None(空き)。

    以前は「つながるか」だけを見ていたため、別のプログラムが同じポートを
    使っていると、それをこのツールだと思い込んで画面だけ開き、何も言わずに
    終わっていた。応答の Server ヘッダーで見分ける。
    """
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            pass
    except OSError:
        return None
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/settings" % PORT, timeout=3) as res:
            server = res.headers.get("Server") or ""
    except urllib.error.HTTPError as e:
        # このツールでも、設定の読み込みに失敗すると 500 を返す。応答の
        # Server ヘッダーで見分ける(エラー=別のプログラム、とは限らない)。
        server = (e.headers.get("Server") if e.headers else "") or ""
    except Exception:  # noqa: BLE001
        return "other"
    return "ours" if server.startswith("AnkiLocalTTS") else "other"


def _open_existing(url):
    print("既に起動しています。画面だけ開きます: " + url)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    return 0


def _port_busy_message():
    return ("ポート %d が別のプログラムに使われているため、TTSツールを起動できません。\n"
            "そのプログラムを終了してから、もう一度起動してください。" % PORT)


def main():
    global PAGE_HTML, SERVER

    if not _WINDOWLESS:
        # 出力をファイルへリダイレクトして起動すると、日本語Windowsでは cp932 に
        # なり、起動時の表示(「—」など)で UnicodeEncodeError になって落ちていた
        # (2026-10-05修正)。表示できない文字は置き換えて続行する。
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (AttributeError, ValueError):
                pass

    url = "http://127.0.0.1:%d/" % PORT

    # 二重起動しても「ポートが使用中」で失敗させない。既に動いているものを
    # 使えばよいので、画面だけ開いて終わる(バッチを何度押しても安全にする)。
    owner = _port_owner()
    if owner == "ours":
        return _open_existing(url)
    if owner == "other":
        _show_fatal(_port_busy_message())
        return 1

    with open(os.path.join(_HERE, "local_tts_page.html"), "r", encoding="utf-8") as f:
        PAGE_HTML = f.read()

    server = None
    for attempt in range(5):
        try:
            server = QuietServer(("127.0.0.1", PORT), Handler)
            break
        except OSError:
            # 調べてから bind するまでの間に、もう1つのツールが先に起動した
            # (バッチの二度押しなど)。そちらを使う。
            owner = _port_owner()
            if owner == "ours":
                return _open_existing(url)
            if owner == "other":
                _show_fatal(_port_busy_message())
                return 1
            # 誰も待ち受けていないのに使えない(終了した直後で、まだ解放されて
            # いない等)。少し待ってやり直す。
            time.sleep(1.0 + attempt)
    if server is None:
        _show_fatal("ポート %d をまだ使えませんでした。少し待ってから、もう一度起動してください。" % PORT)
        return 1
    SERVER = server
    print("=" * 62)
    print("  ANKI出力ツール — apkgにTTS音声を付ける(ローカル)")
    print("=" * 62)
    print("  ブラウザで開いてください:  " + url)
    print("  終了するには、画面のいちばん下の「ツールを終了する」を押すか Ctrl+C")
    print()

    if "--no-browser" not in sys.argv:
        # 既に待ち受けは始まっている(bindはコンストラクタで完了している)ので、
        # serve_forever より前に開いても取りこぼさない。
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
        STATE.cancel = True
    finally:
        # 生成中に Ctrl+C された場合も、そこまでの分を書き出してから終わる
        # (生成スレッドはキャンセルを受けると書き出してから終了する)。
        if STATE.worker is not None and STATE.worker.is_alive():
            # 終了の操作より後に始まった生成が残っていた場合も、止めて書き出してから終わる
            STATE.cancel = True
            print("生成中の分を書き出してから終了します…")
            STATE.worker.join()
        if STATE.col is not None:
            try:
                STATE.col.close()
            except Exception:  # noqa: BLE001
                pass
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
