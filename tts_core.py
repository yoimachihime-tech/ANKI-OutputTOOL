#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tts_core.py
-----------
anki_tts_gui.py からGUI(tkinter)に依存しない部分だけを切り出したバックエンドモジュール。

含まれるもの:
    - 設定ファイル(config.json)の読み書き
    - Google Cloud TTS呼び出し(単発/文単位/WAV結合)
    - HTMLテキストの読み上げ用整形・文分割
    - Ankiコレクション(.apkg)の読み込み・対象ノート走査・TTS書き込みループ
    - バックアップファイルの一覧・パス生成

含まれないもの(tts_gui.py側の責務):
    - tkinterウィジェットの構築・イベントハンドラ
    - ドラッグ&ドロップ、ダイアログ表示、プログレスバー更新などのUI操作

このモジュールは将来的に、CLIツールや sheets_writer.py などGUI以外の
呼び出し元からも再利用できることを想定している。
"""

import base64
import datetime
import html
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
import io

from anki.collection import Collection, ImportAnkiPackageRequest
import anki.import_export_pb2 as ie

try:
    import lameenc
    LAMEENC_AVAILABLE = True
except ImportError:
    LAMEENC_AVAILABLE = False


# ---------------------------------------------------------------------------
# 設定ファイル・定数
# ---------------------------------------------------------------------------

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

TTS_ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize"
VOICES_ENDPOINT = "https://texttospeech.googleapis.com/v1/voices"
SOUND_TAG_RE = re.compile(r"\[sound:[^\]]+\]")


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


# ---------------------------------------------------------------------------
# テキスト整形・文分割
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
    """[sound:xxx] タグを、直前にある<br>も含めて出現位置を問わず取り除く
    (強制再生成時に古い音声タグ・余分な<br>を残さないため)。フィールド末尾に
    まとめて追記する従来方式だけでなく、習熟用ノートで例文ごとにインライン
    挿入する方式(2026-07-27追加、generate_shuujuku_sentence_tts_for_collection
    参照)にも対応するため、文字列中のどこにあっても除去できるようにしている
    (以前は末尾の<br>しか除去できなかった)。"""
    text = re.sub(r"(<br\s*/?>\s*)?\[sound:[^\]]+\]", "", text, flags=re.IGNORECASE)
    return text.strip()


# 「Ex1.」「2.」「Q1.」のような短い見出しラベル1つだけの断片を検出する
# (英字0〜6文字+数字1〜3文字+句点)。少なくとも1桁の数字を要求することで、
# "Yes." "No." のような正当な短文をラベルと誤認して結合してしまうのを防ぐ。
_LABEL_ONLY_RE = re.compile(r"^[A-Za-z]{0,6}\d{1,3}\.$")


def split_into_sentences(html_text: str) -> list:
    """フィールドのHTMLを、文ごとの読み上げ単位に分割する。
    <br>や</div>による改行はそのまま文の区切りとして扱い、
    1行に複数文が「. 」で連続している場合も追加で分割する。

    「Ex1.」「2.」のような短い見出しラベルは、この単純な句点分割だと
    それ単体で1文として切り出されてしまい、TTS生成時にラベルだけの
    極小音声ファイルが大量発生してAnkiコレクションを圧迫する原因になる
    (2026-07-27修正)。そのため、分割結果が`_LABEL_ONLY_RE`にマッチする
    (英字0〜6文字+数字1〜3文字+句点、のような短いラベルのみ)場合は、
    次の断片に結合してから返す。"""
    normalized = re.sub(r"<br\s*/?>", "\n", html_text, flags=re.IGNORECASE)
    normalized = re.sub(r"</div>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"<[^>]+>", "", normalized)
    normalized = html.unescape(normalized)

    sentences = []
    for line in normalized.split("\n"):
        line = line.strip()
        if not line:
            continue
        raw_parts = re.split(r"(?<=[.!?])\s+", line)
        parts = [re.sub(r"\s+", " ", p).strip() for p in raw_parts]
        parts = [p for p in parts if p]

        merged = []
        for p in parts:
            if merged and _LABEL_ONLY_RE.match(merged[-1]):
                merged[-1] = f"{merged[-1]} {p}"
            else:
                merged.append(p)
        sentences.extend(merged)
    return sentences


def html_to_display_text(raw: str) -> str:
    """フィールドのHTMLを、プレビュー表示用の複数行テキストに変換する。
    strip_html_for_tts()と違い、<br>や</div>の改行を保持して読みやすさを優先する
    ([sound:...]タグは表示ノイズになるため除去する)。"""
    text = SOUND_TAG_RE.sub("", raw)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(div|p|li)>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    out = []
    for ln in lines:
        if ln or (out and out[-1]):  # 連続する空行は1つにまとめる
            out.append(ln)
    return "\n".join(out).strip()


# ---------------------------------------------------------------------------
# 習熟用(ATSU方式)ノートのContentフィールド解析
# ---------------------------------------------------------------------------
#
# 習熟用notetypeはNum/Contentの2フィールドしか無く、Contentには
# build_shuujuku_v1.render_item()が生成した「Pattern・Meaning・Examples
# (英文+和訳)・Explanation・Source」を1つにまとめたHTMLが入っている。
# このHTML構造(CSSクラス名)に依存した正規表現でのパースになるため、
# build_shuujuku_v1.py側のテンプレート構造が変わると追従できなくなる点に注意。
# (このモジュールからbuild_shuujuku_v1をimportしていないのは、tts_core.pyを
# tkinter同様「必須ではない周辺モジュール」から独立させる方針のため)

_SHUUJUKU_PATTERN_RE = re.compile(r'<span class="pattern-line">(.*?)</span>', re.DOTALL)
_SHUUJUKU_MEANING_RE = re.compile(r'<div class="gloss-line">(.*?)</div>', re.DOTALL)
_SHUUJUKU_EX_EN_RE = re.compile(r'<div class="ex-en">(.*?)</div>', re.DOTALL)
_SHUUJUKU_EX_JA_RE = re.compile(r'<div class="ex-jp">(.*?)</div>', re.DOTALL)
_SHUUJUKU_EXPL_RE = re.compile(r'<div class="expl-label">[^<]*</div>(.*?)</div>', re.DOTALL)
_SHUUJUKU_SOURCE_RE = re.compile(r'<div class="source-tag">(.*?)</div>', re.DOTALL)


def parse_shuujuku_content_html(content_html: str) -> dict:
    """習熟用(ATSU方式)ノートのContentフィールドを、Pattern/Meaning/Examples/
    expl/source_labelに再分解する。プレビューの構造化表示と、TTS対象を
    英語例文だけに絞る用途(extract_shuujuku_tts_text)の両方で使う。

    戻り値の形式は shuujuku_stock.py の item dict と互換(pattern/meaning/
    examples/expl/source_label のキー)。examples は [(英文, 和訳), ...]。
    """
    def _first(regex):
        m = regex.search(content_html)
        return html_to_display_text(m.group(1)) if m else ""

    en_list = [html_to_display_text(m) for m in _SHUUJUKU_EX_EN_RE.findall(content_html)]
    ja_list = [html_to_display_text(m) for m in _SHUUJUKU_EX_JA_RE.findall(content_html)]

    return {
        "pattern": _first(_SHUUJUKU_PATTERN_RE),
        "meaning": _first(_SHUUJUKU_MEANING_RE),
        "examples": list(zip(en_list, ja_list)),
        "expl": _first(_SHUUJUKU_EXPL_RE),
        "source_label": _first(_SHUUJUKU_SOURCE_RE),
    }


def extract_shuujuku_tts_text(content_html: str) -> str:
    """習熟用ノートのContentフィールドから、TTSで読み上げるべき英語例文
    部分(class="ex-en")だけを抽出する。Contentには英語例文だけでなく
    日本語の意味・和訳・解説・出典も混在しているため、フィールド全体を
    そのままTTSにかけると日本語部分まで英語音声で読み上げようとして
    しまう。patternフィールドもプレースホルダー語(日本語)混じりのため
    読み上げ対象からは除外する。"""
    parsed = parse_shuujuku_content_html(content_html)
    return "<br>".join(en for en, _ja in parsed["examples"] if en)


# ---------------------------------------------------------------------------
# 習熟用ノートの英語例文を1文ずつ個別にTTS化する(2026-07-27追加)
# ---------------------------------------------------------------------------
#
# 通常のanalyze_targets/generate_tts_for_collectionは、1フィールドの内容を
# まとめて1つの音声(またはper_sentence指定時は別々の音声だがタグはフィールド
# 末尾にまとめて追記)にする設計。習熟用ノートでは「例文ごとに個別のMP3を
# 生成し、タグをその例文の直下(<div class="ex-en">...</div>の直後)に
# 配置してほしい」という要望に対応するため、専用の関数を用意する
# (Contentフィールドの構造そのものを書き換える必要があり、通常のフィールド
# 末尾追記方式では実現できないため)。


def analyze_shuujuku_sentence_targets(col, nt_name: str, field_idx: int, force_regen: bool):
    """習熟用ノートのContentフィールド(field_idx)を走査し、英語例文(ex-en)を
    1文ずつ処理対象にする。戻り値は(処理対象(note_id, 例文の連番)ペアのリスト,
    音声済みスキップ数, 空欄スキップ数, 合計文字数)で、analyze_targets()と
    互換の形にしている。「音声済みスキップ」はノート単位の判定(フィールド
    全体に既に[sound:...]が1つでもあれば、そのノートの全例文をまとめて
    スキップする。force_regen時は全て再生成する)。"""
    note_ids = col.find_notes(f'note:"{nt_name}"')
    to_process = []
    skip_has_audio = 0
    skip_empty = 0
    total_chars = 0

    for nid in note_ids:
        note = col.get_note(nid)
        content_html = note.fields[field_idx]
        has_audio = bool(SOUND_TAG_RE.search(content_html))
        if has_audio and not force_regen:
            skip_has_audio += 1
            continue

        sentences = [
            strip_html_for_tts(html_to_display_text(m))
            for m in _SHUUJUKU_EX_EN_RE.findall(content_html)
        ]
        sentences = [s for s in sentences if s]
        if not sentences:
            skip_empty += 1
            continue

        for i in range(len(sentences)):
            to_process.append((nid, i))
        total_chars += sum(len(s) for s in sentences)

    return to_process, skip_has_audio, skip_empty, total_chars


def generate_shuujuku_sentence_tts_for_collection(
    col,
    nt_name: str,
    field_idx: int,
    to_process: list,
    *,
    api_key: str,
    voice: str,
    lang: str,
    bitrate: int,
    force_regen: bool,
    volume_gain_db: float = 0.0,
    log=lambda msg: None,
    on_progress=lambda done, total: None,
    should_cancel=lambda: False,
) -> GenerateResult:
    """習熟用ノートの英語例文(ex-en)を1文ずつ個別にTTS生成し、それぞれの
    タグを対応する例文の直下(<div class="ex-en">...</div>の内側、文の直後)に
    挿入する。通常のgenerate_tts_for_collectionと違い、フィールド全体に
    1つのタグを追記するのではなく、re.subのコールバックで各ex-en divを
    順番に処理しながらタグを埋め込む。

    to_process: analyze_shuujuku_sentence_targets()の戻り値をそのまま渡す
    想定((note_id, 例文の連番)のペア)。実際の処理はノート単位で行うため、
    同じnote_idのエントリはまとめて1回のcol.update_noteで反映する。
    """
    processed = 0
    cancelled = False
    total = len(to_process)
    progress_done = 0

    notes_order = []
    seen = set()
    for nid, _ in to_process:
        if nid not in seen:
            notes_order.append(nid)
            seen.add(nid)
    counts_by_note = {}
    for nid, _ in to_process:
        counts_by_note[nid] = counts_by_note.get(nid, 0) + 1

    for nid in notes_order:
        if should_cancel():
            cancelled = True
            log(f"\nキャンセルされました。{processed} 件処理した時点で中断します。")
            break

        note = col.get_note(nid)
        content_html = note.fields[field_idx]
        if force_regen:
            old_filenames = re.findall(r"\[sound:([^\]]+)\]", content_html)
            if old_filenames:
                try:
                    col.media.trash_files(old_filenames)
                except Exception as e:  # noqa: BLE001
                    log(f"  (旧音声ファイルの削除に失敗: {e})")
            content_html = strip_sound_tags(content_html)

        sentence_counter = [0]

        def _insert_tag(match, _nid=nid):
            inner_html = match.group(1)
            text = strip_html_for_tts(html_to_display_text(inner_html))
            idx = sentence_counter[0]
            sentence_counter[0] += 1
            if not text:
                return match.group(0)
            log(f"生成中 (note {_nid}, 例文 #{idx + 1}): {text[:40]}...")
            audio_bytes, ext = synthesize_with_gaps(
                text, voice, lang, api_key, gap_seconds=0, mp3_bitrate_kbps=bitrate,
                volume_gain_db=volume_gain_db,
            )
            fname = f"tts_{_nid}_{field_idx}_{idx}.{ext}"
            stored_name = col.media.write_data(fname, audio_bytes)
            return f'<div class="ex-en">{inner_html}<br>[sound:{stored_name}]</div>'

        new_content = _SHUUJUKU_EX_EN_RE.sub(_insert_tag, content_html)
        note.fields[field_idx] = new_content
        col.update_note(note)

        note_count = counts_by_note.get(nid, 0)
        processed += note_count
        progress_done += note_count
        on_progress(progress_done, total)

    return GenerateResult(processed=processed, cancelled=cancelled)


# ---------------------------------------------------------------------------
# 日本語文の汎用除外フィルタ(source_transform用、2026-07-27追加)
# ---------------------------------------------------------------------------
#
# extract_shuujuku_tts_text は習熟用ノートのHTML構造(class="ex-en"等)に
# 依存した抽出であり、単語タブの Example フィールドのようにそうした構造を
# 持たないフィールドには使えない。こちらはHTML構造に依存せず、文単位で
# ひらがな・カタカナ・漢字の有無を判定して除外するだけの汎用フィルタ。
# 1文の中に英語と日本語が混在している場合は、その文ごと除外する
# (部分的に日本語だけを取り除くことはしない)。

_JAPANESE_CHAR_RE = re.compile(
    r"[぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]"
)


def contains_japanese(text: str) -> bool:
    """テキストにひらがな・カタカナ・漢字(半角カタカナ含む)が含まれるかを判定する。"""
    return bool(_JAPANESE_CHAR_RE.search(text))


def strip_japanese_sentences(raw_field_text: str) -> str:
    """フィールドの生テキスト(HTML)を文単位に分割し、日本語(ひらがな/
    カタカナ/漢字)を含む文を除外して再結合する。analyze_targets /
    generate_tts_for_collection の source_transform 引数にそのまま渡せる形
    (戻り値はstrip_html_for_tts側でさらに整形される前提のHTML文字列)。"""
    sentences = split_into_sentences(raw_field_text)
    kept = [s for s in sentences if not contains_japanese(s)]
    return "<br>".join(kept)


# ---------------------------------------------------------------------------
# カードプレビュー(ブラウザ表示用HTML生成)
# ---------------------------------------------------------------------------

_TEMPLATE_SECTION_RE = re.compile(r"\{\{([#^])([^}]+)\}\}(.*?)\{\{/\2\}\}", re.DOTALL)
_TEMPLATE_VAR_RE = re.compile(r"\{\{([^#^/][^}]*)\}\}")
_SCRIPT_TAG_RE = re.compile(r"<script\b.*?</script>", re.DOTALL | re.IGNORECASE)


def _render_anki_template(template: str, fields: dict) -> str:
    """Ankiのカードテンプレートを簡易展開する(プレビュー用途の近似であり完全再現ではない)。
    対応: {{Field}} / {{xxx:Field}}(フィルタは無視) / {{#Field}}...{{/Field}} /
    {{^Field}}...{{/Field}} / {{FrontSide}}(fields側に"FrontSide"キーで渡す)。"""
    text = template
    while True:
        m = _TEMPLATE_SECTION_RE.search(text)
        if not m:
            break
        mark, name, body = m.groups()
        value = fields.get(name.strip(), "")
        keep = bool(value.strip()) if mark == "#" else not value.strip()
        text = text[: m.start()] + (body if keep else "") + text[m.end():]

    def replace_var(match):
        name = match.group(1).strip()
        if ":" in name:  # {{type:Field}} や {{hint:Field}} はフィルタを無視して中身だけ出す
            name = name.split(":")[-1].strip()
        return fields.get(name, "")

    return _TEMPLATE_VAR_RE.sub(replace_var, text)


def render_card_preview_html(
    fields: dict, qfmt: str, afmt: str, css: str, night_mode: bool = False
) -> str:
    """ノートのフィールド値とカードテンプレート・CSSから、表面/裏面を並べた
    プレビュー用のHTML文書(文字列)を作る。ブラウザで開いて確認する用途。
    [sound:...]タグと<script>は除去する(プレビューでは不要・自動スクロール防止)。"""
    display_fields = {k: SOUND_TAG_RE.sub("", v) for k, v in fields.items()}
    front = _render_anki_template(qfmt, display_fields)
    back_fields = dict(display_fields)
    back_fields["FrontSide"] = front
    back = _render_anki_template(afmt, back_fields)
    front = _SCRIPT_TAG_RE.sub("", front)
    back = _SCRIPT_TAG_RE.sub("", back)

    night_cls = "night_mode" if night_mode else ""
    page_bg = "#141517" if night_mode else "#f2f2f4"
    label_fg = "#9aa1ab" if night_mode else "#6b7280"
    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Ankiカードプレビュー</title>
<style>{css}</style>
<style>
  body {{ margin: 0; padding: 24px; background: {page_bg}; }}
  .preview-side-label {{
    font-family: sans-serif; font-size: 13px; font-weight: 700;
    color: {label_fg}; letter-spacing: .08em; margin: 20px 0 8px 0;
  }}
</style>
</head>
<body class="{night_cls}">
<div class="preview-side-label">表面 (FRONT)</div>
<div class="card">{front}</div>
<div class="preview-side-label">裏面 (BACK)</div>
<div class="card">{back}</div>
</body>
</html>"""


def open_with_default_player(path: str) -> None:
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _find_app_mode_browser() -> str:
    """Edge/Chromeの実行ファイルパスを探す(--appモードでの小窓プレビュー用)。
    見つからなければ空文字を返す(呼び出し側は既定ブラウザへフォールバックする)。"""
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(program_files_x86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(program_files, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(program_files, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(program_files_x86, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    if local_app_data:
        candidates.append(os.path.join(local_app_data, "Google", "Chrome", "Application", "chrome.exe"))
    for path in candidates:
        if os.path.exists(path):
            return path
    return ""


def open_html_preview_window(path: str, width: int = 480, height: int = 760) -> None:
    """Anki風の、タブ・アドレスバーの無い小さいプレビューウィンドウとして
    HTMLファイルを開く。Edge/Chromeの--appモード(Ankiが内部で使うのと同じ
    Chromiumエンジン)を使うため、新規の依存パッケージは不要で見た目の
    再現度も高い。Edge/Chromeが見つからない場合は既定のブラウザにフォールバックする。"""
    if not sys.platform.startswith("win"):
        open_with_default_player(path)
        return
    browser_exe = _find_app_mode_browser()
    if not browser_exe:
        open_with_default_player(path)
        return
    file_url = "file:///" + os.path.abspath(path).replace("\\", "/")
    subprocess.Popen([browser_exe, f"--app={file_url}", f"--window-size={width},{height}"])


# ---------------------------------------------------------------------------
# Ankiコレクション操作
# ---------------------------------------------------------------------------

def load_collection(apkg_path: str, work_col_path: str) -> Collection:
    if os.path.exists(work_col_path):
        os.remove(work_col_path)
    col = Collection(work_col_path)
    req = ImportAnkiPackageRequest(package_path=apkg_path)
    col.import_anki_package(req)
    return col


def analyze_targets(
    col, nt_name: str, field_indices: list, force_regen: bool, source_transform=None
):
    """対象ノートを走査し、(処理対象(note_id, field_idx)ペアのリスト, 音声済みスキップ数,
    空欄スキップ数, 合計文字数)を返す。実際の生成もドライランも、この関数の結果を共通で使う。

    field_indices: TTSを適用するフィールドのインデックスのリスト(複数フィールド対応、
    2026-07-27)。各フィールドは読み上げ元とタグ追加先が同じ(そのフィールド自身に
    [sound:...]タグを追記する)ため、旧バージョンにあったsrc_idx/tgt_idxの区別は無い。
    1ノートにつき、field_indices内の各フィールドが独立に判定される
    (例: Answerは既に音声ありでスキップ、Exampleは新規生成、ということもありうる)。

    source_transform: 指定すると、各フィールドの生テキスト(sound_tag除去後)に
    対してTTS対象文字列を組み立てる前に適用する(例: 習熟用ノートで英語例文だけを
    抽出するextract_shuujuku_tts_text)。Noneならフィールドの内容をそのまま使う。
    """
    note_ids = col.find_notes(f'note:"{nt_name}"')
    to_process = []
    skip_has_audio = 0
    skip_empty = 0
    total_chars = 0

    for nid in note_ids:
        note = col.get_note(nid)
        for field_idx in field_indices:
            target_current = note.fields[field_idx]
            has_audio = bool(SOUND_TAG_RE.search(target_current))

            if has_audio and not force_regen:
                skip_has_audio += 1
                continue

            source_raw = strip_sound_tags(note.fields[field_idx])
            if source_transform:
                source_raw = source_transform(source_raw)
            text = strip_html_for_tts(source_raw)
            if not text:
                skip_empty += 1
                continue

            to_process.append((nid, field_idx))
            total_chars += len(text)

    return to_process, skip_has_audio, skip_empty, total_chars


# ---------------------------------------------------------------------------
# Google Cloud TTS呼び出し
# ---------------------------------------------------------------------------

def call_google_tts(
    text: str, voice_name: str, language_code: str, api_key: str, volume_gain_db: float = 0.0
) -> bytes:
    body = {
        "input": {"text": text},
        "voice": {"languageCode": language_code, "name": voice_name},
        "audioConfig": {"audioEncoding": "MP3", "volumeGainDb": volume_gain_db},
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
    text: str,
    voice_name: str,
    language_code: str,
    api_key: str,
    sample_rate_hertz: int = 24000,
    volume_gain_db: float = 0.0,
) -> bytes:
    """LINEAR16(WAV)形式で音声を取得する。文と文の間に無音を挟んで結合するために使う。"""
    body = {
        "input": {"text": text},
        "voice": {"languageCode": language_code, "name": voice_name},
        "audioConfig": {
            "audioEncoding": "LINEAR16",
            "sampleRateHertz": sample_rate_hertz,
            "volumeGainDb": volume_gain_db,
        },
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
    raw_field_text: str,
    voice_name: str,
    language_code: str,
    api_key: str,
    volume_gain_db: float = 0.0,
) -> list:
    """文ごとに個別のmp3音声を生成する(結合せず、それぞれ別ファイルとして返す)。
    戻り値は文ごとの音声バイト列のリスト。"""
    sentences = [s for s in split_into_sentences(raw_field_text) if s.strip()]
    if not sentences:
        return []
    return [
        call_google_tts(sent, voice_name, language_code, api_key, volume_gain_db)
        for sent in sentences
    ]


def synthesize_with_gaps(
    raw_field_text: str,
    voice_name: str,
    language_code: str,
    api_key: str,
    gap_seconds: float,
    mp3_bitrate_kbps: int = 64,
    volume_gain_db: float = 0.0,
) -> tuple:
    """文単位でTTS生成し、間に無音を挟んで結合する。
    戻り値は (音声バイト列, 拡張子)。文が1つしかない、または間隔0の場合は
    mp3のまま単発生成する(無駄なWAV変換・API呼び出し増加を避けるため)。
    複数文を結合する場合、lameencが利用可能ならMP3に圧縮して返す
    (利用不可の場合はWAVのまま返す)。"""
    sentences = [s for s in split_into_sentences(raw_field_text) if s.strip()]

    if len(sentences) <= 1 or gap_seconds <= 0:
        plain_text = strip_html_for_tts(raw_field_text)
        return (
            call_google_tts(plain_text, voice_name, language_code, api_key, volume_gain_db),
            "mp3",
        )

    wav_chunks = [
        call_google_tts_wav(sent, voice_name, language_code, api_key, volume_gain_db=volume_gain_db)
        for sent in sentences
    ]
    combined_wav = concat_wav_with_silence(wav_chunks, gap_seconds)

    if LAMEENC_AVAILABLE:
        mp3_bytes = wav_bytes_to_mp3(combined_wav, mp3_bitrate_kbps)
        return mp3_bytes, "mp3"
    return combined_wav, "wav"


# ---------------------------------------------------------------------------
# TTSテスト再生(⚙設定ダイアログの「テスト再生」機能)
# ---------------------------------------------------------------------------

# 固定の短いサンプル文2つ。文と文の間隔(sentence_gap)設定を実際の音声で
# 確認できるよう、意図的に2文構成にしている。
TEST_SAMPLE_SENTENCES = [
    "This is a short test sentence.",
    "Here is a second one to check the pause between sentences.",
]


def synthesize_test_sample_wav(
    voice_name: str,
    language_code: str,
    api_key: str,
    gap_seconds: float,
    volume_gain_db: float = 0.0,
) -> bytes:
    """設定中の音声・言語・文間隔・音量ゲインで、固定の短い2文をWAVとして
    合成する(⚙設定の「テスト再生」用)。常にWAVで返す(mp3変換を挟まず、
    そのままwinsoundで再生できるようにするため)。"""
    wav_chunks = [
        call_google_tts_wav(sent, voice_name, language_code, api_key, volume_gain_db=volume_gain_db)
        for sent in TEST_SAMPLE_SENTENCES
    ]
    return concat_wav_with_silence(wav_chunks, gap_seconds)


def _read_pcm16_samples(wav_bytes: bytes):
    """WAV(LINEAR16)から(サンプル配列, フレーム数, チャンネル数)を読み出す
    共通ヘルパー。16bit以外・無音の場合は(None, 0, 0)を返す。"""
    import struct

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sampwidth = wf.getsampwidth()
        nchannels = wf.getnchannels()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth != 2 or nframes == 0:
        return None, 0, 0

    total_samples = len(raw) // 2
    samples = struct.unpack(f"<{total_samples}h", raw[: total_samples * 2])
    frames_total = total_samples // nchannels
    return samples, frames_total, nchannels


def compute_waveform_minmax(wav_bytes: bytes, buckets: int = 40) -> list:
    """WAV(LINEAR16)の生PCMサンプルから、再生アニメーション用にバケットごとの
    最小値・最大値を-1.0〜+1.0(1.0=16bit PCMのフルスケール)に正規化して返す。
    中心(0点)を挟んで上下に振れる一般的な音声波形ビューア(Audacityなど)と
    同じ見た目にするため、RMS(実効値)ではなく実際のサンプル値の振れ幅
    [min, max]をそのまま使う(2026-07-27、以前のRMSベースの棒グラフ表示から
    変更)。実時間の音声解析は行わず、再生前に全サンプルから概形を事前計算して
    おき、再生経過時間に合わせて描画する方式(compute_peak_amplitudeと同様、
    numpy等は使わず標準ライブラリのwave/structのみで完結させている)。
    戻り値: [(min, max), ...] のリスト(長さ=buckets、先頭が音声の先頭に対応)。"""
    samples, frames_total, nchannels = _read_pcm16_samples(wav_bytes)
    if samples is None or frames_total == 0:
        return [(0.0, 0.0)] * buckets

    bucket_size = max(1, frames_total // buckets)
    result = []
    for b in range(buckets):
        start = b * bucket_size
        end = min(start + bucket_size, frames_total)
        if start >= frames_total:
            result.append((0.0, 0.0))
            continue
        bucket_min = 0
        bucket_max = 0
        for frame_idx in range(start, end):
            base = frame_idx * nchannels
            for ch in range(nchannels):
                v = samples[base + ch]
                if v < bucket_min:
                    bucket_min = v
                if v > bucket_max:
                    bucket_max = v
        result.append((bucket_min / 32768.0, bucket_max / 32768.0))
    return result


def compute_peak_amplitude(wav_bytes: bytes) -> float:
    """WAVの生PCMサンプルのうち最大の絶対振幅を0.0〜1.0(1.0=フルスケール
    =0dBFS)で返す。音量ゲインが強すぎて音割れ(クリッピング)していないかの
    判定に使う。"""
    samples, frames_total, _nchannels = _read_pcm16_samples(wav_bytes)
    if samples is None or frames_total == 0:
        return 0.0
    peak = max((abs(s) for s in samples), default=0)
    return min(1.0, peak / 32768.0)


# 0dBFS(フルスケール)にこれだけ近づいたら「音割れの可能性あり(0dBを超えた)」
# とみなす閾値。ちょうど32768/32767ぴったりでなくても、量子化誤差程度の
# 差で見逃さないよう、わずかに余裕を持たせてある。
CLIPPING_THRESHOLD = 0.999


def is_clipped(wav_bytes: bytes, threshold: float = CLIPPING_THRESHOLD) -> bool:
    return compute_peak_amplitude(wav_bytes) >= threshold


def find_safe_volume_gain_db(
    voice_name: str,
    language_code: str,
    api_key: str,
    gap_seconds: float,
    headroom_db: float = 1.0,
    min_gain_db: float = -20.0,
    max_gain_db: float = 16.0,
    max_iterations: int = 4,
) -> float:
    """0dBFS(フルスケール)を超えない(音割れしない)範囲で、できるだけ音量を
    上げた音量ゲイン(dB)を自動計算する。「デフォルトで自動的に超えない範囲まで
    ゲインを上げたい」という要望への対応。

    手順:
    1. まずゲイン0.0dB(素の音量)でテストサンプルを合成し、基準ピーク振幅を測る。
    2. 基準ピークから、目標ピーク(0dBFSから headroom_db だけ余裕を持たせた値)
       まで引き上げるのに必要なゲイン(dB)を計算する(20*log10比)。
    3. 実際にそのゲインで合成し直し、まだクリッピングしていれば1dBずつ
       下げて再検証する(TTSエンジン内部のAGC等により、ゲインと実際の振幅の
       関係が厳密に線形とは限らないための安全策。最大max_iterations回試行)。

    戻り値: 音割れしないと判断された音量ゲイン(dB)。無音に近い場合は0.0を返す。
    """
    baseline_wav = synthesize_test_sample_wav(voice_name, language_code, api_key, gap_seconds, 0.0)
    baseline_peak = compute_peak_amplitude(baseline_wav)
    if baseline_peak <= 0.0001:
        return 0.0

    target_peak = 10 ** (-headroom_db / 20.0)
    gain_db = 20.0 * math.log10(target_peak / baseline_peak)
    gain_db = max(min_gain_db, min(max_gain_db, gain_db))

    for _ in range(max_iterations):
        wav_bytes = synthesize_test_sample_wav(voice_name, language_code, api_key, gap_seconds, gain_db)
        if not is_clipped(wav_bytes):
            break
        gain_db = max(min_gain_db, gain_db - 1.0)

    return gain_db


def wav_duration_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate() or 1)


# ---------------------------------------------------------------------------
# TTS書き込みメインループ(GUIのrun_generateから抽出)
# ---------------------------------------------------------------------------

class GenerateResult:
    """generate_tts_for_collection() の戻り値。GUI側の表示に必要な情報をまとめる。"""

    def __init__(self, processed: int, cancelled: bool):
        self.processed = processed
        self.cancelled = cancelled


def generate_tts_for_collection(
    col,
    nt_name: str,
    to_process: list,
    *,
    api_key: str,
    voice: str,
    lang: str,
    gap_seconds: float,
    bitrate: int,
    per_sentence: bool,
    force_regen: bool,
    volume_gain_db: float = 0.0,
    source_transform=None,
    log=lambda msg: None,
    on_progress=lambda done, total: None,
    should_cancel=lambda: False,
) -> GenerateResult:
    """to_process内の(note_id, field_idx)ペア全てに対してTTSを生成し、col側の
    ノートを更新する。col のエクスポートは呼び出し側(GUIやCLI)の責務とする
    (このモジュールは col.export_anki_package を呼ばない)。

    to_process: analyze_targets()の戻り値をそのまま渡す想定。各フィールドは
    読み上げ元とタグ追加先が同じ(そのフィールド自身に[sound:...]タグを追記する、
    2026-07-27〜複数フィールド対応)。

    source_transform: analyze_targets()と同じ意味。TTSに渡す前にsourceの
    生テキストを変換する(習熟用ノートで英語例文だけを抽出する用途など)。
    analyze_targets()に渡したものと必ず同じ関数を渡すこと(文字数集計と
    実際の音声化で対象テキストがずれてしまうため)。
    log: 進捗メッセージを受け取るコールバック(GUIならログ欄への追記など)
    on_progress: (処理済み件数, 全体件数) を受け取るコールバック(プログレスバー更新用)
    should_cancel: 呼び出すたびにキャンセル要求の有無を返す関数
    """
    processed = 0
    cancelled = False
    total = len(to_process)

    for i, (nid, field_idx) in enumerate(to_process, start=1):
        if should_cancel():
            cancelled = True
            log(f"\nキャンセルされました。{processed} 件処理した時点で中断します。")
            break

        note = col.get_note(nid)
        target_current = note.fields[field_idx]
        if force_regen:
            old_filenames = re.findall(r"\[sound:([^\]]+)\]", target_current)
            if old_filenames:
                try:
                    col.media.trash_files(old_filenames)
                except Exception as e:  # noqa: BLE001
                    log(f"  (旧音声ファイルの削除に失敗: {e})")
            target_current = strip_sound_tags(target_current)

        source_raw = strip_sound_tags(note.fields[field_idx])
        if source_transform:
            source_raw = source_transform(source_raw)
        preview_text = strip_html_for_tts(source_raw)

        log(f"生成中 (note {nid}, field #{field_idx}): {preview_text[:40]}...")

        if per_sentence:
            audio_list = synthesize_per_sentence(source_raw, voice, lang, api_key, volume_gain_db)
            tags = []
            for idx, audio_bytes in enumerate(audio_list, start=1):
                fname = f"tts_{nid}_{field_idx}_{idx}.mp3"
                stored_name = col.media.write_data(fname, audio_bytes)
                tags.append(f"[sound:{stored_name}]")
            combined_tags = "<br>".join(tags)
        else:
            audio_bytes, ext = synthesize_with_gaps(
                source_raw, voice, lang, api_key, gap_seconds, bitrate, volume_gain_db
            )
            fname = f"tts_{nid}_{field_idx}.{ext}"
            stored_name = col.media.write_data(fname, audio_bytes)
            combined_tags = f"[sound:{stored_name}]"

        note.fields[field_idx] = (
            f"{target_current}<br>{combined_tags}" if target_current else combined_tags
        )
        col.update_note(note)
        processed += 1
        on_progress(i, total)

    return GenerateResult(processed=processed, cancelled=cancelled)


def export_collection(col, output_path: str) -> None:
    opts = ie.ExportAnkiPackageOptions(
        with_scheduling=False, with_deck_configs=False, with_media=True, legacy=True,
    )
    col.export_anki_package(out_path=output_path, options=opts, limit=None)


# ---------------------------------------------------------------------------
# スプレッドシート行対応表(row_map.json)
# ---------------------------------------------------------------------------
#
# カード生成(claude.ai側でgenankiを使って.apkgを作る別工程)の時点で、各ノートの
# guidは genanki.guid_for('dailyconv', シートのID列の値) のように、スプレッドシート
# の「ID」列の値から一方向ハッシュで作られる。ハッシュなので逆算はできないため、
# 生成側が同時に「guid -> シートのID列の値」の対応表(row_map.json)を書き出しておき、
# このツール側はそれを読み込んで突き合わせるだけにする(このモジュールは読み取り専用で、
# シートそのものへは一切アクセスしない)。
#
# row_map.jsonの形式: { "<ノートのguid>": "<シートのID列の値>", ... } という単純な
# JSONオブジェクト。

def load_row_map(path: str) -> dict:
    """row_map.json(ノートのguid -> スプレッドシートのID列の値)を読み込む。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"row_map.jsonの形式が不正です(dict型ではありません): {path}")
    return data


def match_sheet_row_ids(col, note_ids: list, row_map: dict) -> tuple:
    """note_idsの各ノートのguidをrow_mapで引き、対応するスプレッドシートのID列の値を集める。

    戻り値: (見つかったシートID列の値のリスト, row_mapに無かったguidのリスト)
    """
    matched = []
    unmatched_guids = []
    for nid in note_ids:
        note = col.get_note(nid)
        sheet_id = row_map.get(note.guid)
        if sheet_id:
            matched.append(sheet_id)
        else:
            unmatched_guids.append(note.guid)
    return matched, unmatched_guids


# ---------------------------------------------------------------------------
# バックアップ管理
# ---------------------------------------------------------------------------

def make_backup_path(original_path: str) -> str:
    """exe(またはスクリプト)と同じ場所の backup フォルダに、
    タイムスタンプ付きのバックアップファイル名を作る。"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    base = os.path.splitext(os.path.basename(original_path))[0]
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(BACKUP_DIR, f"{base}_backup_{timestamp}.apkg")


def list_backups():
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
