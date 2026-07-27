#!/usr/bin/env python3
"""
anki_tts_gui.py
---------------
apkgにGoogle Cloud TTS(Chirp 3: HD対応)で音声を自動追加するGUIツール。

必要なライブラリ:
    pip install anki
    pip install tkinterdnd2   (apkgのドラッグ&ドロップに使用。未インストールでも
                                動作するが、その場合は「参照...」ボタンのみになる)

実行方法:
    python anki_tts_gui.py

APIキーは「このPCに保存する」にチェックしておくと、次回以降は
このスクリプト(または.exe)と同じフォルダの config.json に保存され
自動入力されます(平文で保存されるので、共有PCでは注意してください)。

Windows用の.exeにする方法(README_BUILD.txtも参照):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name AnkiTTSツール anki_tts_gui.py
    -> dist フォルダの中に AnkiTTSツール.exe ができます
"""

import base64
import html
import io
import json
import os
import re
import shutil
import datetime
import subprocess
import sys
import tempfile
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
import wave
from tkinter import filedialog, messagebox, ttk

from anki.collection import Collection, ImportAnkiPackageRequest
import anki.import_export_pb2 as ie

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
    DND_AVAILABLE = True
except ImportError:
    DND_AVAILABLE = False

try:
    import lameenc
    LAMEENC_AVAILABLE = True
except ImportError:
    LAMEENC_AVAILABLE = False

TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"
VOICES_ENDPOINT = "https://texttospeech.googleapis.com/v1/voices"
SOUND_TAG_RE = re.compile(r"\[sound:[^\]]+\]")

# 設定(APIキー等)の保存先。
# .py実行時: このスクリプトと同じフォルダ
# .exe実行時(PyInstaller --onefile): exe本体と同じフォルダ
#   (sys._MEIPASSは実行のたびに変わる一時展開フォルダなので使わない)
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
BACKUP_DIR = os.path.join(BASE_DIR, "backup")

# よく使う言語コードのプリセット(自由入力も可)
COMMON_LANGUAGE_CODES = [
    "en-US", "en-GB", "en-AU", "ja-JP", "ko-KR", "zh-CN", "zh-TW",
    "fr-FR", "de-DE", "es-ES", "es-US", "it-IT", "pt-BR", "vi-VN",
]


def load_config() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_config(cfg: dict) -> None:
    os.makedirs(BASE_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def list_google_voices(language_code: str, api_key: str) -> list:
    url = f"{VOICES_ENDPOINT}?languageCode={language_code}"
    req = urllib.request.Request(url, headers={"X-Goog-Api-Key": api_key})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    names = sorted(v["name"] for v in data.get("voices", []))
    return names

# tkinterdnd2 がある場合は TkinterDnD.Tk を、無ければ通常の tk.Tk をベースクラスにする
_BaseTk = TkinterDnD.Tk if DND_AVAILABLE else tk.Tk


# ---------------------------------------------------------------------------
# バックエンドロジック (CLI版 add_tts_to_apkg.py と同じ処理)
# ---------------------------------------------------------------------------

def strip_html_for_tts(raw: str) -> str:
    text = raw
    text = re.sub(r"<br\s*/?>", ". ", text, flags=re.IGNORECASE)
    text = re.sub(r"</div>", ". ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def strip_sound_tags(text: str) -> str:
    """既存の [sound:xxx] タグと、それに伴う末尾の余分な<br>を取り除く
    (強制再生成時に <br><br> のような重複を残さないため)。"""
    text = SOUND_TAG_RE.sub("", text)
    text = re.sub(r"(<br\s*/?>\s*)+$", "", text, flags=re.IGNORECASE)
    return text.strip()


def split_into_sentences(html_text: str) -> list:
    """フィールドのHTMLを、文ごとの読み上げ単位に分割する。
    <br>や</div>による改行はそのまま文の区切りとして扱い、
    1行に複数文が「. 」で連続している場合も追加で分割する。"""
    normalized = re.sub(r"<br\s*/?>", "\n", html_text, flags=re.IGNORECASE)
    normalized = re.sub(r"</div>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"<[^>]+>", "", normalized)
    normalized = html.unescape(normalized)

    sentences = []
    for line in normalized.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = re.split(r"(?<=[.!?])\s+", line)
        for p in parts:
            p = re.sub(r"\s+", " ", p).strip()
            if p:
                sentences.append(p)
    return sentences


def open_with_default_player(path: str) -> None:
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def load_collection(apkg_path: str, work_col_path: str) -> Collection:
    if os.path.exists(work_col_path):
        os.remove(work_col_path)
    col = Collection(work_col_path)
    req = ImportAnkiPackageRequest(package_path=apkg_path)
    col.import_anki_package(req)
    return col


def call_google_tts(text: str, voice_name: str, language_code: str, api_key: str) -> bytes:
    body = {
        "input": {"text": text},
        "voice": {"languageCode": language_code, "name": voice_name},
        "audioConfig": {"audioEncoding": "MP3"},
    }
    data = json.dumps(body).encode("utf-8")
    # 注意: ?key=... のクエリパラメータ形式は Cloud Text-to-Speech API では
    # "API keys are not supported by this API" エラーになる。
    # 正しくは X-Goog-Api-Key ヘッダーで渡す。
    req = urllib.request.Request(
        TTS_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Goog-Api-Key": api_key,
        },
    )
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                return base64.b64decode(result["audioContent"])
        except urllib.error.HTTPError as e:
            last_err = e.read().decode("utf-8", errors="replace")
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TTS API呼び出しに失敗しました: {last_err}")


def call_google_tts_wav(
    text: str, voice_name: str, language_code: str, api_key: str, sample_rate_hertz: int = 24000
) -> bytes:
    """LINEAR16(WAV)形式で音声を取得する。文と文の間に無音を挟んで結合するために使う。"""
    body = {
        "input": {"text": text},
        "voice": {"languageCode": language_code, "name": voice_name},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": sample_rate_hertz},
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        TTS_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Goog-Api-Key": api_key,
        },
    )
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                return base64.b64decode(result["audioContent"])
        except urllib.error.HTTPError as e:
            last_err = e.read().decode("utf-8", errors="replace")
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"TTS API呼び出しに失敗しました: {last_err}")


def concat_wav_with_silence(wav_chunks: list, gap_seconds: float) -> bytes:
    """複数のWAVバイト列を、指定秒数の無音を挟みながら1つのWAVに結合する。"""
    frames = []
    params = None
    for chunk in wav_chunks:
        with wave.open(io.BytesIO(chunk), "rb") as wf:
            if params is None:
                params = wf.getparams()
            frames.append(wf.readframes(wf.getnframes()))

    sampwidth = params.sampwidth
    framerate = params.framerate
    nchannels = params.nchannels
    silence_frame_count = int(gap_seconds * framerate)
    silence_bytes = b"\x00" * (silence_frame_count * sampwidth * nchannels)

    out_buffer = io.BytesIO()
    with wave.open(out_buffer, "wb") as out:
        out.setnchannels(nchannels)
        out.setsampwidth(sampwidth)
        out.setframerate(framerate)
        for i, fr in enumerate(frames):
            out.writeframes(fr)
            if i != len(frames) - 1 and silence_frame_count > 0:
                out.writeframes(silence_bytes)
    return out_buffer.getvalue()


def wav_bytes_to_mp3(wav_bytes: bytes, bitrate_kbps: int = 64) -> bytes:
    """WAV(LINEAR16)のバイト列をMP3に変換する(lameencを使用、外部ffmpeg不要)。"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        channels = wf.getnchannels()
        sample_rate = wf.getframerate()
        sampwidth = wf.getsampwidth()
        pcm = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise RuntimeError("MP3変換は16bit PCMのみ対応しています。")

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate_kbps)
    encoder.set_in_sample_rate(sample_rate)
    encoder.set_channels(channels)
    encoder.set_quality(2)  # 2=高音質(遅い) 〜 7=低音質(速い)
    mp3_data = encoder.encode(pcm)
    mp3_data += encoder.flush()
    return bytes(mp3_data)


def synthesize_per_sentence(
    raw_field_text: str, voice_name: str, language_code: str, api_key: str
) -> list:
    """文ごとに個別のmp3音声を生成する(結合せず、それぞれ別ファイルとして返す)。
    戻り値は文ごとの音声バイト列のリスト。"""
    sentences = [s for s in split_into_sentences(raw_field_text) if s.strip()]
    if not sentences:
        return []
    return [call_google_tts(sent, voice_name, language_code, api_key) for sent in sentences]


def synthesize_with_gaps(
    raw_field_text: str,
    voice_name: str,
    language_code: str,
    api_key: str,
    gap_seconds: float,
    mp3_bitrate_kbps: int = 64,
) -> tuple:
    """文単位でTTS生成し、間に無音を挟んで結合する。
    戻り値は (音声バイト列, 拡張子)。文が1つしかない、または間隔0の場合は
    mp3のまま単発生成する(無駄なWAV変換・API呼び出し増加を避けるため)。
    複数文を結合する場合、lameencが利用可能ならMP3に圧縮して返す
    (利用不可の場合はWAVのまま返す)。"""
    sentences = [s for s in split_into_sentences(raw_field_text) if s.strip()]

    if len(sentences) <= 1 or gap_seconds <= 0:
        plain_text = strip_html_for_tts(raw_field_text)
        return call_google_tts(plain_text, voice_name, language_code, api_key), "mp3"

    wav_chunks = [
        call_google_tts_wav(sent, voice_name, language_code, api_key) for sent in sentences
    ]
    combined_wav = concat_wav_with_silence(wav_chunks, gap_seconds)

    if LAMEENC_AVAILABLE:
        mp3_bytes = wav_bytes_to_mp3(combined_wav, mp3_bitrate_kbps)
        return mp3_bytes, "mp3"
    return combined_wav, "wav"


# ---------------------------------------------------------------------------
# GUI本体
# ---------------------------------------------------------------------------

class AnkiTTSApp(_BaseTk):
    def __init__(self):
        super().__init__()
        self.title("Anki TTS 音声追加ツール")
        self.geometry("720x960")
        self.minsize(650, 600)
        self.resizable(True, True)

        self._config = load_config()

        self.apkg_path = tk.StringVar()
        self.output_path = tk.StringVar()
        self.notetype_var = tk.StringVar()
        self.source_field_var = tk.StringVar()
        self.target_field_var = tk.StringVar()
        self.api_key_var = tk.StringVar(value=self._config.get("api_key", ""))
        self.remember_key_var = tk.BooleanVar(value=self._config.get("remember_key", True))
        self.voice_var = tk.StringVar(
            value=self._config.get("voice", "en-US-Chirp3-HD-Iapetus")
        )
        self.lang_var = tk.StringVar(value=self._config.get("language_code", "en-US"))
        self.voices_cache = self._config.get("voices_cache", {})  # {言語コード: [音声名,...]}
        self.sentence_gap_var = tk.DoubleVar(value=self._config.get("sentence_gap", 0.5))
        self.per_sentence_var = tk.BooleanVar(value=self._config.get("per_sentence_tags", False))
        self.mp3_bitrate_var = tk.StringVar(value=str(self._config.get("mp3_bitrate", 64)))

        self.notetype_fields = {}  # {notetype名: [フィールド名, ...]}
        self.notetype_notes = {}  # {notetype名: [(note_id, [フィールド値,...]), ...]}
        self.notetype_total_counts = {}  # {notetype名: 全ノート数}

        self.force_regen_var = tk.BooleanVar(value=self._config.get("force_regen", False))
        self.auto_open_anki_var = tk.BooleanVar(value=self._config.get("auto_open_anki", False))
        self.auto_backup_var = tk.BooleanVar(value=self._config.get("auto_backup", True))
        self._cancel_event = threading.Event()

        self._build_widgets()

        # 起動時、保存済みの音声一覧キャッシュがあれば即座にプルダウンへ反映する
        cached = self.voices_cache.get(self.lang_var.get())
        if cached:
            self.voice_combo["values"] = cached

        # APIキーが既にあれば、起動直後にバックグラウンドで音声一覧を自動取得
        # (エラーが出てもポップアップは出さず、ログにのみ記録する)
        if self.api_key_var.get():
            self.after(300, lambda: self.on_fetch_voices(silent=True))

        # APIキー・音声名・言語コード・保存チェックボックスは、変更されるたびに
        # 即座に保存する(TTS生成しなくても次回起動時に残るようにするため)
        self.api_key_var.trace_add("write", self._on_settings_changed)
        self.voice_var.trace_add("write", self._on_settings_changed)
        self.lang_var.trace_add("write", self._on_settings_changed)
        self.remember_key_var.trace_add("write", self._on_settings_changed)
        self.sentence_gap_var.trace_add("write", self._on_settings_changed)
        self.per_sentence_var.trace_add("write", self._on_settings_changed)
        self.per_sentence_var.trace_add("write", self._on_per_sentence_toggled)
        self.mp3_bitrate_var.trace_add("write", self._on_settings_changed)
        self.force_regen_var.trace_add("write", self._on_settings_changed)
        self.auto_open_anki_var.trace_add("write", self._on_settings_changed)
        self.auto_backup_var.trace_add("write", self._on_settings_changed)
        self._on_per_sentence_toggled()  # 起動時の状態を反映

    def _on_per_sentence_toggled(self, *_args):
        # 文ごとに個別タグを付ける場合、「文と文の間隔」は結合しないため無関係になる
        self.gap_spin.configure(state="disabled" if self.per_sentence_var.get() else "normal")

    def _on_settings_changed(self, *_args):
        self._save_current_config()

    # --- UI構築 ---------------------------------------------------------
    def _build_widgets(self):
        pad = {"padx": 10, "pady": 6}

        # --- ウィンドウを小さくしても中身が見えなくならないよう、
        #     全体をCanvas+Scrollbarでラップし、縦横スクロール可能にする ---
        outer = ttk.Frame(self)
        outer.pack(fill="both", expand=True)

        canvas = tk.Canvas(outer, highlightthickness=0)
        vscroll = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        hscroll = ttk.Scrollbar(outer, orient="horizontal", command=canvas.xview)
        canvas.configure(yscrollcommand=vscroll.set, xscrollcommand=hscroll.set)

        canvas.grid(row=0, column=0, sticky="nsew")
        vscroll.grid(row=0, column=1, sticky="ns")
        hscroll.grid(row=1, column=0, sticky="ew")
        outer.grid_rowconfigure(0, weight=1)
        outer.grid_columnconfigure(0, weight=1)

        content = ttk.Frame(canvas)
        content_window = canvas.create_window((0, 0), window=content, anchor="nw")

        def _on_content_configure(event):
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_configure(event):
            # contentの幅をcanvasの表示幅に合わせる(横スクロールは中身が
            # 表示幅より広い時だけ実際に必要になる)
            canvas.itemconfigure(content_window, width=max(event.width, content.winfo_reqwidth()))

        content.bind("<Configure>", _on_content_configure)
        canvas.bind("<Configure>", _on_canvas_configure)

        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        frm_file = ttk.LabelFrame(content, text="① apkgファイルを選択（ドラッグ&ドロップ可）")
        frm_file.pack(fill="x", **pad)
        ttk.Entry(frm_file, textvariable=self.apkg_path, width=50).pack(
            side="left", padx=6, pady=8
        )
        ttk.Button(frm_file, text="参照...", command=self.on_browse_apkg).pack(
            side="left", padx=6
        )

        if DND_AVAILABLE:
            frm_file.drop_target_register(DND_FILES)
            frm_file.dnd_bind("<<Drop>>", self.on_drop_apkg)
            drop_hint = "ここに .apkg ファイルをドラッグ&ドロップできます"
        else:
            drop_hint = "(tkinterdnd2 未インストールのため、ドラッグ&ドロップは無効。「参照...」を使用してください)"
        ttk.Label(frm_file, text=drop_hint, foreground="#666").pack(side="left", padx=6)

        frm_fields = ttk.LabelFrame(content, text="② ノートタイプ・フィールドを選択")
        frm_fields.pack(fill="both", expand=True, **pad)

        ttk.Label(frm_fields, text="ノートタイプ:").grid(row=0, column=0, sticky="w", padx=6, pady=4)
        self.notetype_combo = ttk.Combobox(
            frm_fields, textvariable=self.notetype_var, state="readonly", width=45
        )
        self.notetype_combo.grid(row=0, column=1, padx=6, pady=4)
        self.notetype_combo.bind("<<ComboboxSelected>>", self.on_notetype_selected)

        ttk.Label(frm_fields, text="読み上げ元フィールド (Source):").grid(
            row=1, column=0, sticky="w", padx=6, pady=4
        )
        self.source_combo = ttk.Combobox(
            frm_fields, textvariable=self.source_field_var, state="readonly", width=45
        )
        self.source_combo.grid(row=1, column=1, padx=6, pady=4)
        self.source_combo.bind("<<ComboboxSelected>>", self.update_preview)

        ttk.Label(frm_fields, text="音声タグ追加先フィールド (Target):").grid(
            row=2, column=0, sticky="w", padx=6, pady=4
        )
        self.target_combo = ttk.Combobox(
            frm_fields, textvariable=self.target_field_var, state="readonly", width=45
        )
        self.target_combo.grid(row=2, column=1, padx=6, pady=4)
        self.target_combo.bind("<<ComboboxSelected>>", self.update_preview)

        # --- ノート一覧(複数ノートを一覧表示し、クリックで内容確認) ---
        ttk.Label(frm_fields, text="ノート一覧(行をクリックでプレビュー表示):").grid(
            row=3, column=0, columnspan=2, sticky="w", padx=6, pady=(10, 0)
        )
        tree_frame = ttk.Frame(frm_fields)
        tree_frame.grid(row=4, column=0, columnspan=3, sticky="nsew", padx=6, pady=4)

        self.notes_tree = ttk.Treeview(tree_frame, show="headings", height=7)
        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.notes_tree.yview)
        hsb = ttk.Scrollbar(tree_frame, orient="horizontal", command=self.notes_tree.xview)
        self.notes_tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.notes_tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        tree_frame.grid_columnconfigure(0, weight=1)
        tree_frame.grid_rowconfigure(0, weight=1)
        frm_fields.grid_rowconfigure(4, weight=1)
        frm_fields.grid_columnconfigure(1, weight=1)
        self.notes_tree.bind("<<TreeviewSelect>>", self.on_note_row_selected)

        self.notes_count_label = ttk.Label(frm_fields, text="")
        self.notes_count_label.grid(row=5, column=0, columnspan=2, sticky="w", padx=6)

        ttk.Button(
            frm_fields, text="🔊 選択中ノートを試聴", command=self.on_preview_play_clicked
        ).grid(row=5, column=2, sticky="e", padx=6)

        # --- フィールドプレビュー(選択中ノートの中身を表示) ---
        ttk.Label(frm_fields, text="プレビュー (Source):").grid(
            row=6, column=0, sticky="nw", padx=6, pady=4
        )
        self.source_preview = tk.Text(frm_fields, height=3, width=45, wrap="word", state="disabled")
        self.source_preview.grid(row=6, column=1, padx=6, pady=4, sticky="w")

        ttk.Label(frm_fields, text="プレビュー (Target):").grid(
            row=7, column=0, sticky="nw", padx=6, pady=4
        )
        self.target_preview = tk.Text(frm_fields, height=3, width=45, wrap="word", state="disabled")
        self.target_preview.grid(row=7, column=1, padx=6, pady=4, sticky="w")

        frm_tts = ttk.LabelFrame(content, text="③ TTS設定")
        frm_tts.pack(fill="x", **pad)

        ttk.Label(frm_tts, text="Google Cloud APIキー:").grid(row=0, column=0, sticky="w", padx=6, pady=4)
        ttk.Entry(frm_tts, textvariable=self.api_key_var, width=35, show="*").grid(
            row=0, column=1, padx=6, pady=4, sticky="w"
        )
        ttk.Checkbutton(
            frm_tts, text="このPCに保存する", variable=self.remember_key_var
        ).grid(row=0, column=2, padx=6, pady=4, sticky="w")

        ttk.Label(frm_tts, text="言語コード:").grid(row=1, column=0, sticky="w", padx=6, pady=4)
        self.lang_combo = ttk.Combobox(
            frm_tts, textvariable=self.lang_var, values=COMMON_LANGUAGE_CODES, width=33
        )
        self.lang_combo.grid(row=1, column=1, padx=6, pady=4, sticky="w")
        # 言語コードが変更されたら、自動で音声一覧を再取得する
        self.lang_combo.bind("<<ComboboxSelected>>", lambda e: self.on_fetch_voices(silent=True))
        self.lang_combo.bind("<FocusOut>", lambda e: self.on_fetch_voices(silent=True))

        ttk.Label(frm_tts, text="音声名 (voice):").grid(row=2, column=0, sticky="w", padx=6, pady=4)
        self.voice_combo = ttk.Combobox(
            frm_tts,
            textvariable=self.voice_var,
            values=[self.voice_var.get()],
            width=33,
            state="readonly",
        )
        self.voice_combo.grid(row=2, column=1, padx=6, pady=4, sticky="w")
        ttk.Button(
            frm_tts, text="音声一覧を取得", command=lambda: self.on_fetch_voices(silent=False)
        ).grid(row=2, column=2, padx=6, pady=4, sticky="w")

        ttk.Label(frm_tts, text="文と文の間隔(秒):").grid(row=3, column=0, sticky="w", padx=6, pady=4)
        self.gap_spin = ttk.Spinbox(
            frm_tts,
            from_=0.0,
            to=5.0,
            increment=0.1,
            textvariable=self.sentence_gap_var,
            width=10,
        )
        self.gap_spin.grid(row=3, column=1, padx=6, pady=4, sticky="w")
        ttk.Label(
            frm_tts,
            text="(0.0=間隔なし。文ごとに分割生成して無音を挟むためAPI呼び出しが増えます)",
            foreground="#666",
        ).grid(row=3, column=2, padx=6, pady=4, sticky="w")

        ttk.Label(frm_tts, text="MP3圧縮ビットレート(kbps):").grid(
            row=4, column=0, sticky="w", padx=6, pady=4
        )
        self.bitrate_combo = ttk.Combobox(
            frm_tts,
            textvariable=self.mp3_bitrate_var,
            values=["32", "48", "64", "96", "128", "192"],
            state="readonly",
            width=10,
        )
        self.bitrate_combo.grid(row=4, column=1, padx=6, pady=4, sticky="w")
        bitrate_hint = (
            "(値が小さいほど容量が減ります。話し言葉なら64kbpsで十分な音質です)"
            if LAMEENC_AVAILABLE
            else "(lameenc未インストールのため圧縮できません。WAVのまま出力されます。pip install lameenc)"
        )
        ttk.Label(frm_tts, text=bitrate_hint, foreground="#666").grid(
            row=4, column=2, padx=6, pady=4, sticky="w"
        )

        ttk.Checkbutton(
            frm_tts,
            text="文ごとに音声を分けて、それぞれ別のタグを付ける(結合しない)",
            variable=self.per_sentence_var,
        ).grid(row=5, column=0, columnspan=2, sticky="w", padx=6, pady=4)
        ttk.Label(
            frm_tts,
            text="(ONの場合「文と文の間隔」は使われません。文の数だけタグが並びます)",
            foreground="#666",
        ).grid(row=5, column=2, padx=6, pady=4, sticky="w")

        frm_out = ttk.LabelFrame(content, text="④ 出力ファイル")
        frm_out.pack(fill="x", **pad)
        ttk.Entry(frm_out, textvariable=self.output_path, width=60).pack(
            side="left", padx=6, pady=8
        )
        ttk.Button(frm_out, text="保存先を指定...", command=self.on_browse_output).pack(
            side="left", padx=6
        )

        frm_options = ttk.Frame(content)
        frm_options.pack(fill="x", **pad)
        ttk.Checkbutton(
            frm_options,
            text="既存の音声を上書きして再生成する",
            variable=self.force_regen_var,
        ).pack(side="left", padx=6)
        ttk.Button(
            frm_options, text="処理件数・文字数を確認(ドライラン)", command=self.on_dry_run_clicked
        ).pack(side="left", padx=6)

        frm_options2 = ttk.Frame(content)
        frm_options2.pack(fill="x", **pad)
        ttk.Checkbutton(
            frm_options2,
            text="生成前に元のapkgを自動バックアップする",
            variable=self.auto_backup_var,
        ).pack(side="left", padx=6)
        ttk.Checkbutton(
            frm_options2,
            text="生成完了後、出力apkgを自動でAnkiに渡す(取り込み画面を開く)",
            variable=self.auto_open_anki_var,
        ).pack(side="left", padx=6)
        ttk.Button(
            frm_options2, text="バックアップ管理...", command=self.on_manage_backups_clicked
        ).pack(side="left", padx=6)

        frm_run = ttk.Frame(content)
        frm_run.pack(pady=10)
        self.generate_btn = ttk.Button(
            frm_run, text="⑤ TTS音声を生成する", command=self.on_generate_clicked
        )
        self.generate_btn.pack(side="left", padx=6)
        self.cancel_btn = ttk.Button(
            frm_run, text="キャンセル", command=self.on_cancel_clicked, state="disabled"
        )
        self.cancel_btn.pack(side="left", padx=6)

        self.progress = ttk.Progressbar(content, mode="determinate")
        self.progress.pack(fill="x", padx=10)

        self.log_text = tk.Text(content, height=14, state="disabled", wrap="word")
        self.log_text.pack(fill="both", expand=True, padx=10, pady=10)

    # --- イベントハンドラ -------------------------------------------------
    def log(self, message: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def on_browse_apkg(self):
        path = filedialog.askopenfilename(
            title="apkgファイルを選択", filetypes=[("Anki Package", "*.apkg")]
        )
        if not path:
            return
        self._set_apkg_path(path)

    def on_drop_apkg(self, event):
        # tkinterdnd2 はドロップされたパスを "{path with spaces} another.apkg" のような
        # 形式で渡してくることがあるため、tk.splitlist で安全に分割する
        paths = self.tk.splitlist(event.data)
        if not paths:
            return
        path = paths[0]
        if not path.lower().endswith(".apkg"):
            messagebox.showwarning("ファイル形式エラー", ".apkg ファイルをドロップしてください。")
            return
        self._set_apkg_path(path)

    def _set_apkg_path(self, path: str):
        self.apkg_path.set(path)
        default_out = os.path.splitext(path)[0] + "_tts追加.apkg"
        self.output_path.set(default_out)
        self.load_fields(path)

    def on_browse_output(self):
        path = filedialog.asksaveasfilename(
            title="出力先を指定", defaultextension=".apkg", filetypes=[("Anki Package", "*.apkg")]
        )
        if path:
            self.output_path.set(path)

    MAX_LIST_ROWS = 500  # 一覧表示の上限件数(TTS生成自体には影響しない)

    def load_fields(self, apkg_path: str):
        """apkgを読み込み、ノートタイプ・フィールド一覧・全ノートの中身を取得する。"""
        try:
            self.log(f"読み込み中: {apkg_path}")
            work_col_path = os.path.join(
                os.environ.get("TEMP", "/tmp"), "_anki_tts_gui_inspect.anki2"
            )
            col = load_collection(apkg_path, work_col_path)

            self.notetype_fields = {}
            self.notetype_notes = {}      # {nt名: [(note_id, [フィールド値,...]), ...]} (表示上限あり)
            self.notetype_total_counts = {}  # {nt名: 全ノート数}
            for nt in col.models.all_names_and_ids():
                model = col.models.get(nt.id)
                note_ids = col.find_notes(f'note:"{nt.name}"')
                if not note_ids:
                    continue
                self.notetype_fields[nt.name] = [f["name"] for f in model["flds"]]
                self.notetype_total_counts[nt.name] = len(note_ids)
                notes_data = []
                for nid in note_ids[: self.MAX_LIST_ROWS]:
                    n = col.get_note(nid)
                    notes_data.append((nid, list(n.fields)))
                self.notetype_notes[nt.name] = notes_data
            col.close()

            names = list(self.notetype_fields.keys())
            self.notetype_combo["values"] = names
            if names:
                self.notetype_var.set(names[0])
                self.on_notetype_selected()
            self.log(f"ノートタイプを {len(names)} 件検出しました。")
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("読み込みエラー", str(e))

    def on_notetype_selected(self, event=None):
        nt_name = self.notetype_var.get()
        fields = self.notetype_fields.get(nt_name, [])
        self.source_combo["values"] = fields
        self.target_combo["values"] = fields
        if fields:
            self.source_field_var.set(fields[0])
            self.target_field_var.set(fields[0])
        self.populate_notes_tree(nt_name)

    def populate_notes_tree(self, nt_name: str):
        fields = self.notetype_fields.get(nt_name, [])
        notes_data = self.notetype_notes.get(nt_name, [])

        self.notes_tree.delete(*self.notes_tree.get_children())
        self.notes_tree["columns"] = fields
        for f in fields:
            self.notes_tree.heading(f, text=f)
            self.notes_tree.column(f, width=150, anchor="w", stretch=False)

        for nid, vals in notes_data:
            preview_vals = [strip_html_for_tts(v)[:60] for v in vals]
            self.notes_tree.insert("", "end", iid=str(nid), values=preview_vals)

        total = self.notetype_total_counts.get(nt_name, len(notes_data))
        if total > len(notes_data):
            self.notes_count_label.configure(
                text=f"全 {total} 件中、先頭 {len(notes_data)} 件を表示しています"
            )
        else:
            self.notes_count_label.configure(text=f"全 {total} 件")

        children = self.notes_tree.get_children()
        if children:
            self.notes_tree.selection_set(children[0])
            self.notes_tree.focus(children[0])
        self.update_preview()

    def on_note_row_selected(self, event=None):
        self.update_preview()

    def _fill_preview_widget(self, widget: tk.Text, text: str):
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", text)
        widget.configure(state="disabled")

    def update_preview(self, event=None):
        nt_name = self.notetype_var.get()
        fields = self.notetype_fields.get(nt_name, [])
        notes_data = self.notetype_notes.get(nt_name, [])
        if not fields or not notes_data:
            return

        selected = self.notes_tree.selection()
        current_fields = None
        if selected:
            nid = int(selected[0])
            for n, flds in notes_data:
                if n == nid:
                    current_fields = flds
                    break
        if current_fields is None:
            current_fields = notes_data[0][1]

        src_name = self.source_field_var.get()
        tgt_name = self.target_field_var.get()

        if src_name in fields:
            self._fill_preview_widget(self.source_preview, current_fields[fields.index(src_name)])
        if tgt_name in fields:
            self._fill_preview_widget(self.target_preview, current_fields[fields.index(tgt_name)])

    def _make_backup_path(self, original_path: str) -> str:
        """exe(またはスクリプト)と同じ場所の backup フォルダに、
        タイムスタンプ付きのバックアップファイル名を作る。"""
        os.makedirs(BACKUP_DIR, exist_ok=True)
        base = os.path.splitext(os.path.basename(original_path))[0]
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        return os.path.join(BACKUP_DIR, f"{base}_backup_{timestamp}.apkg")

    def _list_backups(self):
        """backupフォルダ内の.apkgを、新しい順にリストで返す。
        各要素は (フルパス, ファイル名, 更新日時, サイズ) のタプル。"""
        if not os.path.isdir(BACKUP_DIR):
            return []
        entries = []
        for fname in os.listdir(BACKUP_DIR):
            if not fname.lower().endswith(".apkg"):
                continue
            fpath = os.path.join(BACKUP_DIR, fname)
            try:
                stat = os.stat(fpath)
                entries.append((fpath, fname, stat.st_mtime, stat.st_size))
            except OSError:
                continue
        entries.sort(key=lambda e: e[2], reverse=True)
        return entries

    def _save_current_config(self):
        cfg = {
            "remember_key": self.remember_key_var.get(),
            "voice": self.voice_var.get(),
            "language_code": self.lang_var.get(),
            "voices_cache": self.voices_cache,
            "sentence_gap": self.sentence_gap_var.get(),
            "per_sentence_tags": self.per_sentence_var.get(),
            "mp3_bitrate": int(self.mp3_bitrate_var.get()),
            "force_regen": self.force_regen_var.get(),
            "auto_open_anki": self.auto_open_anki_var.get(),
            "auto_backup": self.auto_backup_var.get(),
        }
        if self.remember_key_var.get():
            cfg["api_key"] = self.api_key_var.get()
        try:
            save_config(cfg)
        except Exception as e:  # noqa: BLE001
            self.log(f"設定の保存に失敗しました: {e}")

    def on_fetch_voices(self, silent: bool = False):
        if not self.api_key_var.get():
            if not silent:
                messagebox.showwarning("入力不足", "先にGoogle Cloud APIキーを入力してください。")
            return
        lang = self.lang_var.get().strip()
        if not lang:
            if not silent:
                messagebox.showwarning("入力不足", "言語コードを入力してください(例: en-US)。")
            return

        api_key = self.api_key_var.get()

        def worker():
            try:
                names = list_google_voices(lang, api_key)
                if not names:
                    self.log(f"'{lang}' に該当する音声が見つかりませんでした。")
                    return
                self.voice_combo["values"] = names
                if self.voice_var.get() not in names:
                    self.voice_var.set(names[0])
                # 取得結果をキャッシュに保存し、次回起動時にも即座に使えるようにする
                self.voices_cache[lang] = names
                self._save_current_config()
                self.log(f"'{lang}' の音声を {len(names)} 件取得しました。")
            except Exception as e:  # noqa: BLE001
                self.log(f"音声一覧の取得に失敗しました: {e}")
                if not silent:
                    messagebox.showerror("エラー", f"音声一覧の取得に失敗しました:\n{e}")

        threading.Thread(target=worker, daemon=True).start()

    def _analyze_targets(self, col, nt_name, src_idx, tgt_idx, force_regen):
        """対象ノートを走査し、(処理対象note_idリスト, 音声済みスキップ数, 空欄スキップ数, 合計文字数)を返す。
        実際の生成もドライランも、この関数の結果を共通で使う。"""
        note_ids = col.find_notes(f'note:"{nt_name}"')
        to_process = []
        skip_has_audio = 0
        skip_empty = 0
        total_chars = 0

        for nid in note_ids:
            note = col.get_note(nid)
            target_current = note.fields[tgt_idx]
            has_audio = bool(SOUND_TAG_RE.search(target_current))

            if has_audio and not force_regen:
                skip_has_audio += 1
                continue

            source_raw = strip_sound_tags(note.fields[src_idx])
            text = strip_html_for_tts(source_raw)
            if not text:
                skip_empty += 1
                continue

            to_process.append(nid)
            total_chars += len(text)

        return to_process, skip_has_audio, skip_empty, total_chars

    def on_manage_backups_clicked(self):
        backups = self._list_backups()

        win = tk.Toplevel(self)
        win.title("バックアップ管理")
        win.geometry("620x420")
        win.minsize(500, 350)
        win.resizable(True, True)

        ttk.Label(win, text=f"保存場所: {BACKUP_DIR}", foreground="#666").pack(
            anchor="w", padx=10, pady=(10, 4)
        )

        tree_frame = ttk.Frame(win)
        tree_frame.pack(fill="both", expand=True, padx=10, pady=4)
        tree = ttk.Treeview(
            tree_frame, columns=("name", "mtime", "size"), show="headings", height=12
        )
        tree.heading("name", text="ファイル名")
        tree.heading("mtime", text="更新日時")
        tree.heading("size", text="サイズ")
        tree.column("name", width=320, anchor="w")
        tree.column("mtime", width=140, anchor="w")
        tree.column("size", width=90, anchor="e")
        vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="left", fill="y")

        def populate():
            tree.delete(*tree.get_children())
            for fpath, fname, mtime, size in self._list_backups():
                mtime_str = datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
                size_str = f"{size / 1024:.0f} KB"
                tree.insert("", "end", iid=fpath, values=(fname, mtime_str, size_str))

        populate()

        count_label = ttk.Label(win, text=f"バックアップ数: {len(backups)} 件", foreground="#666")
        count_label.pack(anchor="w", padx=10)

        def refresh_count():
            n = len(tree.get_children())
            count_label.configure(text=f"バックアップ数: {n} 件")

        def on_restore():
            selected = tree.selection()
            if not selected:
                messagebox.showwarning("未選択", "復元したいバックアップを選択してください。", parent=win)
                return
            src_path = selected[0]
            default_name = os.path.basename(src_path).replace("_backup_", "_restored_")
            dest = filedialog.asksaveasfilename(
                parent=win,
                title="復元先を指定",
                initialfile=default_name,
                defaultextension=".apkg",
                filetypes=[("Anki Package", "*.apkg")],
            )
            if not dest:
                return
            try:
                shutil.copy2(src_path, dest)
                self.log(f"バックアップを復元しました: {dest}")
                messagebox.showinfo("復元完了", f"次の場所に復元しました:\n{dest}", parent=win)
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("エラー", f"復元に失敗しました:\n{e}", parent=win)

        def on_delete_all():
            n = len(tree.get_children())
            if n == 0:
                messagebox.showinfo("バックアップなし", "削除するバックアップがありません。", parent=win)
                return
            if not messagebox.askyesno(
                "確認", f"バックアップ {n} 件をすべて削除します。よろしいですか？\n(この操作は取り消せません)",
                parent=win,
            ):
                return
            errors = []
            for fpath, _fname, _mtime, _size in self._list_backups():
                try:
                    os.remove(fpath)
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{os.path.basename(fpath)}: {e}")
            populate()
            refresh_count()
            self.log(f"バックアップを {n - len(errors)} 件削除しました。")
            if errors:
                messagebox.showwarning(
                    "一部失敗", "削除できなかったファイルがあります:\n" + "\n".join(errors), parent=win
                )

        btn_frame = ttk.Frame(win)
        btn_frame.pack(fill="x", padx=10, pady=10)
        ttk.Button(btn_frame, text="選択した項目を復元(名前を付けて保存)", command=on_restore).pack(
            side="left", padx=4
        )
        ttk.Button(btn_frame, text="すべて削除", command=on_delete_all).pack(side="left", padx=4)
        ttk.Button(btn_frame, text="閉じる", command=win.destroy).pack(side="right", padx=4)

    def on_dry_run_clicked(self):
        if not self.apkg_path.get():
            messagebox.showwarning("入力不足", "apkgファイルを選択してください。")
            return

        def worker():
            try:
                work_col_path = os.path.join(
                    os.environ.get("TEMP", "/tmp"), "_anki_tts_gui_dryrun.anki2"
                )
                col = load_collection(self.apkg_path.get(), work_col_path)
                nt_name = self.notetype_var.get()
                nt = col.models.by_name(nt_name)
                field_names = [f["name"] for f in nt["flds"]]
                src_idx = field_names.index(self.source_field_var.get())
                tgt_idx = field_names.index(self.target_field_var.get())

                to_process, skip_audio, skip_empty, total_chars = self._analyze_targets(
                    col, nt_name, src_idx, tgt_idx, self.force_regen_var.get()
                )
                col.close()

                msg = (
                    f"対象ノートタイプ: {nt_name}\n\n"
                    f"新規生成予定: {len(to_process)} 件\n"
                    f"スキップ(既に音声あり): {skip_audio} 件\n"
                    f"スキップ(空欄): {skip_empty} 件\n\n"
                    f"生成予定の合計文字数: {total_chars:,} 文字\n\n"
                    "※ Google Cloud Text-to-Speechの無料枠は音声の種類(Standard/"
                    "WaveNet/Neural2/Chirp3-HDなど)によって異なります。正確な枠は"
                    "Google Cloud Consoleの料金ページでご確認ください。"
                )
                self.log("--- ドライラン結果 ---\n" + msg)
                messagebox.showinfo("ドライラン結果", msg)
            except Exception as e:  # noqa: BLE001
                self.log(f"ドライランに失敗しました: {e}")
                messagebox.showerror("エラー", f"ドライランに失敗しました:\n{e}")

        threading.Thread(target=worker, daemon=True).start()

    def on_preview_play_clicked(self):
        if not self.api_key_var.get():
            messagebox.showwarning("入力不足", "先にGoogle Cloud APIキーを入力してください。")
            return
        voice_name = self.voice_var.get().strip()
        lang_check = self.lang_var.get().strip()
        if not voice_name.lower().startswith(lang_check.lower() + "-"):
            messagebox.showwarning(
                "音声名が不正な可能性があります",
                f"音声名「{voice_name}」が言語コード「{lang_check}」から始まっていません。\n"
                "「音声一覧を取得」でリストから選び直してください。",
            )
            return

        nt_name = self.notetype_var.get()
        fields = self.notetype_fields.get(nt_name, [])
        notes_data = self.notetype_notes.get(nt_name, [])
        selected = self.notes_tree.selection()
        if not selected or not notes_data:
            messagebox.showwarning("未選択", "ノート一覧から試聴したい行を選択してください。")
            return

        nid = int(selected[0])
        current_fields = next((f for n, f in notes_data if n == nid), None)
        src_name = self.source_field_var.get()
        if current_fields is None or src_name not in fields:
            return

        raw_field_text = strip_sound_tags(current_fields[fields.index(src_name)])
        preview_text = strip_html_for_tts(raw_field_text)
        if not preview_text:
            messagebox.showinfo("空欄", "選択したノートのSourceフィールドが空です。")
            return

        voice = self.voice_var.get()
        lang = self.lang_var.get()
        api_key = self.api_key_var.get()
        gap_seconds = self.sentence_gap_var.get()
        bitrate = int(self.mp3_bitrate_var.get())

        def worker():
            try:
                self.log(f"試聴用に音声を生成中: {preview_text[:40]}...")
                audio_bytes, ext = synthesize_with_gaps(raw_field_text, voice, lang, api_key, gap_seconds, bitrate)
                tmp_path = os.path.join(tempfile.gettempdir(), f"anki_tts_preview_{nid}.{ext}")
                with open(tmp_path, "wb") as f:
                    f.write(audio_bytes)
                self.log(f"再生します: {tmp_path}")
                open_with_default_player(tmp_path)
            except Exception as e:  # noqa: BLE001
                self.log(f"試聴に失敗しました: {e}")
                messagebox.showerror("エラー", f"試聴に失敗しました:\n{e}")

        threading.Thread(target=worker, daemon=True).start()

    def on_cancel_clicked(self):
        self._cancel_event.set()
        self.log("キャンセルを要求しました。現在の処理が終わり次第、途中結果を書き出して停止します。")

    def on_generate_clicked(self):
        if not self.apkg_path.get():
            messagebox.showwarning("入力不足", "apkgファイルを選択してください。")
            return
        if not self.api_key_var.get():
            messagebox.showwarning("入力不足", "Google Cloud APIキーを入力してください。")
            return
        if not self.output_path.get():
            messagebox.showwarning("入力不足", "出力先を指定してください。")
            return
        voice_name = self.voice_var.get().strip()
        lang = self.lang_var.get().strip()
        if not voice_name.lower().startswith(lang.lower() + "-"):
            messagebox.showwarning(
                "音声名が不正な可能性があります",
                f"音声名「{voice_name}」が言語コード「{lang}」から始まっていません。\n"
                "「音声一覧を取得」でリストから選び直してください。\n"
                "(例: en-US-Chirp3-HD-Iapetus のように、言語コードを含む完全な名前である必要があります)",
            )
            return

        self._cancel_event.clear()
        self.generate_btn.configure(state="disabled")
        self.cancel_btn.configure(state="normal")
        thread = threading.Thread(target=self.run_generate, daemon=True)
        thread.start()

    def run_generate(self):
        try:
            if self.auto_backup_var.get():
                try:
                    backup_path = self._make_backup_path(self.apkg_path.get())
                    shutil.copy2(self.apkg_path.get(), backup_path)
                    self.log(f"バックアップを作成しました: {backup_path}")
                except Exception as e:  # noqa: BLE001
                    self.log(f"バックアップの作成に失敗しました(処理は続行します): {e}")

            work_col_path = os.path.join(
                os.environ.get("TEMP", "/tmp"), "_anki_tts_gui_generate.anki2"
            )
            col = load_collection(self.apkg_path.get(), work_col_path)

            nt_name = self.notetype_var.get()
            nt = col.models.by_name(nt_name)
            field_names = [f["name"] for f in nt["flds"]]
            src_idx = field_names.index(self.source_field_var.get())
            tgt_idx = field_names.index(self.target_field_var.get())

            force_regen = self.force_regen_var.get()
            to_process, skipped_has_audio, skipped_empty, _total_chars = self._analyze_targets(
                col, nt_name, src_idx, tgt_idx, force_regen
            )

            self.progress["maximum"] = max(len(to_process), 1)
            self.progress["value"] = 0

            processed = 0
            cancelled = False
            api_key = self.api_key_var.get()
            voice = self.voice_var.get()
            lang = self.lang_var.get()
            gap_seconds = self.sentence_gap_var.get()
            bitrate = int(self.mp3_bitrate_var.get())
            per_sentence = self.per_sentence_var.get()
            same_field = self.source_field_var.get() == self.target_field_var.get()

            if not per_sentence and gap_seconds > 0 and not LAMEENC_AVAILABLE:
                self.log(
                    "注意: lameencが未インストールのため、結合音声はMP3ではなくWAVのまま出力されます。"
                    "圧縮したい場合は `pip install lameenc` を実行してください。"
                )

            for i, nid in enumerate(to_process, start=1):
                if self._cancel_event.is_set():
                    cancelled = True
                    self.log(f"\nキャンセルされました。{processed} 件処理した時点で中断します。")
                    break

                note = col.get_note(nid)
                target_current = note.fields[tgt_idx]
                if force_regen:
                    old_filenames = re.findall(r"\[sound:([^\]]+)\]", target_current)
                    if old_filenames:
                        try:
                            col.media.trash_files(old_filenames)
                        except Exception as e:  # noqa: BLE001
                            self.log(f"  (旧音声ファイルの削除に失敗: {e})")
                    target_current = strip_sound_tags(target_current)

                source_raw = strip_sound_tags(note.fields[src_idx])
                preview_text = strip_html_for_tts(source_raw)

                self.log(f"生成中 (note {nid}): {preview_text[:40]}...")

                if per_sentence:
                    audio_list = synthesize_per_sentence(source_raw, voice, lang, api_key)
                    tags = []
                    for idx, audio_bytes in enumerate(audio_list, start=1):
                        fname = f"tts_{nid}_{idx}.mp3"
                        stored_name = col.media.write_data(fname, audio_bytes)
                        tags.append(f"[sound:{stored_name}]")
                    combined_tags = "<br>".join(tags)
                else:
                    audio_bytes, ext = synthesize_with_gaps(
                        source_raw, voice, lang, api_key, gap_seconds, bitrate
                    )
                    fname = f"tts_{nid}.{ext}"
                    stored_name = col.media.write_data(fname, audio_bytes)
                    combined_tags = f"[sound:{stored_name}]"

                if same_field:
                    note.fields[tgt_idx] = (
                        f"{target_current}<br>{combined_tags}" if target_current else combined_tags
                    )
                else:
                    note.fields[tgt_idx] = (
                        f"{target_current} {combined_tags}".strip() if target_current else combined_tags
                    )
                col.update_note(note)
                processed += 1

                self.progress["value"] = i
                self.update_idletasks()

            opts = ie.ExportAnkiPackageOptions(
                with_scheduling=False, with_deck_configs=False, with_media=True, legacy=True,
            )
            col.export_anki_package(out_path=self.output_path.get(), options=opts, limit=None)
            col.close()

            status = "キャンセルにより途中まで" if cancelled else "完了"
            self.log(
                f"\n{status}: 新規生成 {processed} 件 / 既に音声あり(スキップ) {skipped_has_audio} 件 / "
                f"空欄スキップ {skipped_empty} 件"
            )
            self.log(f"出力ファイル: {self.output_path.get()}")
            self._save_current_config()
            if cancelled:
                messagebox.showinfo("中断", f"キャンセルされました。{processed} 件を処理した時点までの内容で出力しました。")
            else:
                if self.auto_open_anki_var.get():
                    try:
                        self.log("出力apkgをAnkiに渡します(取り込み画面を開きます)...")
                        open_with_default_player(self.output_path.get())
                    except Exception as e:  # noqa: BLE001
                        self.log(f"Ankiでの自動オープンに失敗しました: {e}")
                messagebox.showinfo("完了", "TTS音声の追加が完了しました。")
        except Exception as e:  # noqa: BLE001
            self.log(f"エラー: {e}")
            messagebox.showerror("エラー", str(e))
        finally:
            self.generate_btn.configure(state="normal")
            self.cancel_btn.configure(state="disabled")


if __name__ == "__main__":
    app = AnkiTTSApp()
    app.mainloop()
