#!/usr/bin/env python3
"""
tts_gui.py
----------
apkgにGoogle Cloud TTS(Chirp 3: HD対応)で音声を自動追加するGUIツール。
バックエンド処理は tts_core.py に分離されており、このファイルは
tkinterウィジェットの構築・イベント処理・見た目(テーマ)だけを担当する。

必要なライブラリ:
    pip install anki
    pip install sv-ttk              (モダンな丸みのあるダーク/ライトテーマ)
    pip install tkinterdnd2         (apkgのドラッグ&ドロップに使用。任意)
    pip install lameenc              (MP3圧縮に使用。任意)

実行方法:
    python tts_gui.py

APIキーは「このPCに保存する」にチェックしておくと、次回以降は
tts_core.CONFIG_PATH (config.json) に保存され自動入力されます
(平文で保存されるので、共有PCでは注意してください)。

Windows用の.exeにする方法(README_BUILD.txtも参照):
    pip install pyinstaller
    pyinstaller --onefile --windowed --name AnkiTTSツール tts_gui.py
    -> dist フォルダの中に AnkiTTSツール.exe ができます
"""

import datetime
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

import card_def_builder
import card_defs
import deck_builder
import gemini_client
import sheets_reader
import sheets_writer
import shuujuku_stock
import tts_core
import word_stock

try:
    import build_shuujuku_v1
    SHUUJUKU_AVAILABLE = True
except ImportError:
    SHUUJUKU_AVAILABLE = False

try:
    import build_word_v1
    WORD_AVAILABLE = True
except ImportError:
    WORD_AVAILABLE = False

# 習熟用(ATSU方式)notetypeの正式名称。build_shuujuku_v1が無い環境でも
# 判定(TTS対象の絞り込み・プレビュー構造化表示)ができるよう定数化しておく。
SHUUJUKU_NOTETYPE_NAME = "ATSU方式 (PDF再現・音読用)"

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
    DND_AVAILABLE = True
except ImportError:
    DND_AVAILABLE = False

try:
    import sv_ttk
    SV_TTK_AVAILABLE = True
except ImportError:
    SV_TTK_AVAILABLE = False

try:
    import winsound
    WINSOUND_AVAILABLE = True
except ImportError:
    # Windows専用(標準ライブラリ)。⚙設定の「テスト再生」機能でのみ使う
    # (アプリ内で再生位置を把握できる方式が必要なため、os.startfileでの
    # 外部プレイヤー起動には切り替えられない。非Windows環境では機能を
    # 無効化するだけで、アプリ自体は起動できる)。
    WINSOUND_AVAILABLE = False


# tkinterdnd2 がある場合は TkinterDnD.Tk を、無ければ通常の tk.Tk をベースクラスにする
_BaseTk = TkinterDnD.Tk if DND_AVAILABLE else tk.Tk


class AnkiTTSApp(_BaseTk):
    def __init__(self):
        super().__init__()
        self.title("Anki TTS 音声追加ツール")
        self.geometry("1380x860")
        # ペイン縮小時はウィンドウ幅も連動して狭くなるため、最小幅は
        # 「設定列+縦タブ2本」が収まる程度まで許容する(この値がペイン両方を
        # 縮小したときの実際の幅より大きいと、minsizeでウィンドウが強制的に
        # 広げられてしまい、縮小タブの幅がずれる原因になる)
        self.minsize(480, 640)
        self.resizable(True, True)

        self._config = tts_core.load_config()

        # --- 見た目(テーマ) -------------------------------------------------
        self.theme_var = tk.StringVar(value=self._config.get("theme", "dark"))
        self._apply_theme(self.theme_var.get(), initial=True)

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
        # 音量ゲイン(dB)。Google Cloud TTSのaudioConfig.volumeGainDbにそのまま
        # 渡す(-96.0〜+16.0が有効範囲だが、UIでは実用的な範囲に絞ってある)。
        # 「TTSの音声が小さい場合がある」への対応として2026-07-27に追加。
        self.volume_gain_db_var = tk.DoubleVar(value=self._config.get("volume_gain_db", 0.0))

        self.notetype_fields = {}  # {notetype名: [フィールド名, ...]}
        self.notetype_notes = {}  # {notetype名: [(note_id, [フィールド値,...]), ...]}
        self.notetype_total_counts = {}  # {notetype名: 全ノート数}
        self.notetype_styling = {}  # {notetype名: {"qfmt":…, "afmt":…, "css":…}} カードプレビュー用
        self._preview_source = None  # 右プレビュー欄の表示元({"kind": "note"|"shuujuku", ...})

        self.force_regen_var = tk.BooleanVar(value=self._config.get("force_regen", False))
        self.auto_open_anki_var = tk.BooleanVar(value=self._config.get("auto_open_anki", False))
        self.auto_backup_var = tk.BooleanVar(value=self._config.get("auto_backup", True))

        self.row_map_path = tk.StringVar()
        self._current_row_map = None  # スプレッドシートから直接読み込んだ場合の {guid: シートのID} (メモリ上)
        # ペイン縮小時に「表示に戻したときの幅」を覚えておく(configにも保存)
        self._mid_saved_width = int(self._config.get("notes_pane_width", 320))
        self._right_saved_width = int(self._config.get("preview_pane_width", 480))
        self.sheets_update_var = tk.BooleanVar(value=False)
        self.sheets_spreadsheet_id_var = tk.StringVar(
            value=self._config.get("sheets_spreadsheet_id", "")
        )
        self.sheets_sheet_name_var = tk.StringVar(
            value=self._config.get("sheets_sheet_name", "添削結果")
        )

        # --- 習熟用(ATSU方式)・AIに質問 関連(2026-07-24〜、Gemini APIを仮選定) ---
        self.gemini_api_key_var = tk.StringVar(value=self._config.get("gemini_api_key", ""))
        self.gemini_model_var = tk.StringVar(
            value=self._config.get("gemini_model", "gemini-2.0-flash")
        )
        self.gemini_models_cache = self._config.get("gemini_models_cache", [])
        self.ai_ask_generating_var = tk.BooleanVar(value=False)

        self._cancel_event = threading.Event()

        # 「単語」タブのカード定義(card_defs.json)が無ければ、build_word_v1.pyの
        # 内容を初期値として一度だけ登録する(2026-07-27の統合当初はPython
        # ハードコードだったため。以降は⚙設定の「カード定義」タブで編集できる)。
        if WORD_AVAILABLE:
            try:
                card_defs.seed_default_word_def_if_missing()
            except Exception:  # noqa: BLE001
                pass

        self._build_widgets()
        self.refresh_shuujuku_stock_view()
        self.refresh_word_stock_view()
        self.refresh_carddef_listbox()

        # ペインのchrome(サッシ等の占有幅)を、まだ何もトグルしていない
        # 安定した初期状態のうちに測定してキャッシュする。
        # update_idletasks()だけではPanedWindowの子ペインがまだ実際の幅を
        # 得ていないことがあるため、update()で完全にレイアウトを確定させる。
        self.update()
        self._measure_pane_chrome()

        # タイトルバーの配色をテーマに合わせる(ウィンドウが表示されてから)
        self.after(150, lambda: self._apply_titlebar_theme(self.theme_var.get()))

        # 前回縮小していたペインの状態を復元する(幅の調整はwindow_geometryに任せる)
        if not self._config.get("show_notes_pane", True):
            self._toggle_mid_pane(initial=True)
        if not self._config.get("show_preview_pane", True):
            self._toggle_right_pane(initial=True)

        # 前回終了時のウィンドウサイズ・位置を復元する
        # (モニター構成が変わった等で画面外の座標だった場合は位置を復元しない
        #  ―― サイズだけ復元し、位置はOSの既定に任せる)
        saved_geometry = self._config.get("window_geometry")
        if saved_geometry:
            try:
                m = re.match(r"(\d+)x(\d+)(?:\+(-?\d+)\+(-?\d+))?", saved_geometry)
                if m:
                    w, h, x, y = m.groups()
                    if x is not None and self._is_on_screen(int(x), int(y)):
                        self.geometry(saved_geometry)
                    else:
                        self.geometry(f"{w}x{h}")
            except tk.TclError:
                pass

        # 終了時に最新の状態(ペイン表示・ウィンドウサイズ等)を保存する
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # 起動時、保存済みの音声一覧キャッシュがあれば即座にプルダウンへ反映する
        cached = self.voices_cache.get(self.lang_var.get())
        if cached:
            self.voice_combo["values"] = cached

        # APIキーが既にあれば、起動直後にバックグラウンドで音声一覧を自動取得
        # (エラーが出てもポップアップは出さず、ログにのみ記録する)
        if self.api_key_var.get():
            self.after(300, lambda: self.on_fetch_voices(silent=True))
        # Gemini APIキーが既にあれば、同様にモデル一覧を自動取得する。
        # config.jsonに保存されているモデル名が実在しない/廃止された場合でも、
        # ここで自動的に実在するモデルへ補正される(on_fetch_gemini_models内の
        # 「現在の値が一覧に無ければ先頭を選び直す」ロジックによる)。
        if self.gemini_api_key_var.get():
            self.after(300, lambda: self.on_fetch_gemini_models(silent=True))

        # 設定は変更されるたびに即座に保存する
        self.api_key_var.trace_add("write", self._on_settings_changed)
        self.voice_var.trace_add("write", self._on_settings_changed)
        self.lang_var.trace_add("write", self._on_settings_changed)
        self.remember_key_var.trace_add("write", self._on_settings_changed)
        self.sentence_gap_var.trace_add("write", self._on_settings_changed)
        self.per_sentence_var.trace_add("write", self._on_settings_changed)
        self.per_sentence_var.trace_add("write", self._on_per_sentence_toggled)
        self.mp3_bitrate_var.trace_add("write", self._on_settings_changed)
        self.volume_gain_db_var.trace_add("write", self._on_settings_changed)
        self.force_regen_var.trace_add("write", self._on_settings_changed)
        self.auto_open_anki_var.trace_add("write", self._on_settings_changed)
        self.auto_backup_var.trace_add("write", self._on_settings_changed)
        self.sheets_spreadsheet_id_var.trace_add("write", self._on_settings_changed)
        self.sheets_sheet_name_var.trace_add("write", self._on_settings_changed)
        self.gemini_api_key_var.trace_add("write", self._on_settings_changed)
        self.gemini_model_var.trace_add("write", self._on_settings_changed)
        self._on_per_sentence_toggled()  # 起動時の状態を反映

    # --- テーマ(ダークモード/ライトモード) --------------------------------
    def _apply_theme(self, mode: str, initial: bool = False):
        """sv_ttk があれば丸みのあるモダンなFluent風テーマを適用する。
        未インストールの場合は既定のttkテーマのまま動作する(機能に支障はない)。"""
        if SV_TTK_AVAILABLE:
            sv_ttk.set_theme(mode)
        else:
            style = ttk.Style(self)
            try:
                style.theme_use("clam")
            except tk.TclError:
                pass
            if not initial:
                messagebox.showinfo(
                    "sv-ttk未インストール",
                    "モダンなテーマを使うには `pip install sv-ttk` を実行してください。\n"
                    "現在は標準テーマで動作しています。",
                )

    def _apply_titlebar_theme(self, mode: str):
        """Windowsのタイトルバーをダーク/ライトに切り替える(Windows 10 1809以降)。
        tkinter標準ではタイトルバーが常に白のままなので、DWM APIを直接呼ぶ。
        失敗しても機能に影響はないため黙って無視する。"""
        if not sys.platform.startswith("win"):
            return
        try:
            import ctypes

            self.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            value = ctypes.c_int(1 if mode == "dark" else 0)
            # 20 = DWMWA_USE_IMMERSIVE_DARK_MODE (古いWindows 10ビルドでは19)
            for attr in (20, 19):
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                    hwnd, attr, ctypes.byref(value), ctypes.sizeof(value)
                ) == 0:
                    break
            # 即時反映のため、ウィンドウサイズを1pxだけ揺らして戻す
            w, h = self.winfo_width(), self.winfo_height()
            if w > 1 and h > 1:
                self.geometry(f"{w}x{h + 1}")
                self.update_idletasks()
                self.geometry(f"{w}x{h}")
        except Exception:  # noqa: BLE001
            pass

    def on_theme_setting_changed(self):
        """設定ダイアログ「全般」タブのテーマRadiobuttonから呼ばれる。
        Radiobuttonがcommand実行前に既にtheme_varを新しい値へセットしているため、
        ここでは現在のtheme_varの値をそのまま適用するだけでよい
        (以前の「ヘッダーのボタンで反転させる」on_toggle_themeから置き換え)。"""
        mode = self.theme_var.get()
        self._apply_theme(mode)
        self._apply_titlebar_theme(mode)
        self._style_text_widgets(mode)
        self._save_current_config()

    def _style_text_widgets(self, mode: str):
        """tk.Text/tk.Listbox はttkテーマ(sv-ttk)の適用対象外で、ダークモードでも
        白いまま残ってしまうため、配色を手動でテーマに合わせる。
        新しくtk.Text/tk.Listboxを足す場合はここに登録すること。"""
        if mode == "dark":
            bg, fg = "#1c1c1c", "#f0f0f0"
        else:
            bg, fg = "#ffffff", "#1a1a1a"
        for widget in (
            getattr(self, "log_text", None),
            getattr(self, "preview_text", None),
            getattr(self, "ai_ask_text", None),
        ):
            if widget is not None:
                widget.configure(bg=bg, fg=fg, insertbackground=fg)
        listbox = getattr(self, "shuujuku_listbox", None)
        if listbox is not None:
            listbox.configure(bg=bg, fg=fg)  # Listboxにはinsertbackgroundが無い

    def _toggle_log(self):
        if self._log_visible:
            self.log_text.pack_forget()
            self.log_toggle_btn.configure(text="表示")
        else:
            self.log_text.pack(fill="x", pady=(2, 0))
            self.log_toggle_btn.configure(text="隠す")
        self._log_visible = not self._log_visible

    def _reflow_panes(self):
        """表示状態に合わせてペインを並べ直す。縮小した縦タブは左側(設定列の
        すぐ右)にまとめて格納する(ノート一覧タブ→プレビュータブの順)。"""
        for w in (self._mid_frame, self._right_frame, self._mid_tab, self._right_tab):
            try:
                self._main_pane.forget(w)
            except tk.TclError:
                pass
        if not self._mid_visible:
            self._main_pane.add(self._mid_tab, weight=0)
        if not self._right_visible:
            self._main_pane.add(self._right_tab, weight=0)
        if self._mid_visible:
            self._main_pane.add(self._mid_frame, weight=1)
        if self._right_visible:
            self._main_pane.add(self._right_frame, weight=2)

    def _tab_px(self, tab) -> int:
        """縦タブの幅(px)。固定幅(COLLAPSED_TAB_WIDTH)でpack_propagateを切って
        いるため、常に一定(両タブとも同じ幅になる)。"""
        return self.COLLAPSED_TAB_WIDTH

    def _snapshot_pane_widths(self):
        """表示中のペインの現在幅を保存幅に反映する(サッシをドラッグして
        調整した幅を、縮小/再表示をまたいで維持するため)。"""
        if self._mid_visible and self._mid_frame.winfo_width() > 1:
            self._mid_saved_width = self._mid_frame.winfo_width()
        if self._right_visible and self._right_frame.winfo_width() > 1:
            self._right_saved_width = self._right_frame.winfo_width()

    def _measure_pane_chrome(self):
        """設定ペイン+ノート一覧+プレビューの合計幅と、実際のウィンドウ幅との
        差(サッシの占有幅・枠など)を測定してキャッシュする。トグルのたびに
        直前の(まだ完全に確定していないことがある)描画状態から再計測すると
        誤差が積み重なるため、起動直後の安定した状態で1度だけ測定する。"""
        panes = self._main_pane.panes()
        pane_sum = sum(self.nametowidget(p).winfo_width() for p in panes)
        self._pane_chrome = max(self.winfo_width() - pane_sum, 0)

    def _pane_layout_refresh(self):
        """表示状態に合わせてペインを並べ直し、ウィンドウ幅と各ペインの幅を
        決定的に再計算する。差分(delta)の足し引きではなく毎回合計から求めるため、
        トグルを繰り返しても誤差が蓄積しない。chromeは起動時にキャッシュした
        値を使う(_measure_pane_chrome参照)。"""
        panes = self._main_pane.panes()
        settings_w = self.nametowidget(panes[0]).winfo_width()
        chrome = self._pane_chrome

        self._reflow_panes()

        # 望ましい各ペイン幅(左から順)。設定列は現状維持、縮小分は縦タブ幅のみ。
        widths = [settings_w]
        if not self._mid_visible:
            widths.append(self.COLLAPSED_TAB_WIDTH)
        if not self._right_visible:
            widths.append(self.COLLAPSED_TAB_WIDTH)
        if self._mid_visible:
            widths.append(self._mid_saved_width)
        if self._right_visible:
            widths.append(self._right_saved_width)

        new_width = chrome + sum(widths)
        self.geometry(f"{new_width}x{self.winfo_height()}")
        self.update()  # 実リサイズを反映させてからサッシ位置を確定する

        # サッシ位置を左から順に固定する(最後のペインが残り幅を受け取る)。
        # ttk.PanedWindowはサッシの占有幅を隣接ペインのどちらかに数px程度
        # 上乗せ/差し引きすることがあり、指定した位置と実際の描画幅が
        # 数px単位でずれることがある。そのため、一度設定して終わりにはせず、
        # 実測→誤差分だけサッシを再調整、を数回繰り返して収束させる。
        try:
            pos = [0] * len(widths)
            cum = 0
            for i, w in enumerate(widths):
                cum += w
                pos[i] = cum

            for _ in range(4):
                for i in range(len(widths) - 1):
                    self._main_pane.sashpos(i, pos[i])
                self.update()

                panes_now = self._main_pane.panes()
                settled = True
                cum = 0
                for i, target_w in enumerate(widths[:-1]):
                    actual_w = self.nametowidget(panes_now[i]).winfo_width()
                    if actual_w != target_w:
                        settled = False
                        pos[i] += target_w - actual_w  # 次の試行で境界位置を補正
                        for j in range(i + 1, len(pos) - 1):
                            pos[j] += target_w - actual_w  # 後続の境界も同じ分だけ押す
                if settled:
                    break
        except tk.TclError:
            pass

    def _toggle_mid_pane(self, initial: bool = False):
        """ノート一覧ペインの表示/縮小(縦タブ化)を切り替える。
        縮小時はウィンドウ幅も縮小分だけ狭め、再表示時は元に戻す。
        initial=True(起動時の状態復元)ではウィンドウ幅は変えない
        (幅は window_geometry の復元に任せる)。"""
        if initial:
            self._mid_visible = not self._mid_visible
            self._reflow_panes()
            return
        self.update()  # 未処理のリサイズを反映させてから現在幅を測る
        self._snapshot_pane_widths()
        self._mid_visible = not self._mid_visible
        self._pane_layout_refresh()
        self._save_current_config()

    def _toggle_right_pane(self, initial: bool = False):
        """プレビューペインの表示/縮小(縦タブ化)を切り替える(動作は_toggle_mid_paneと同様)。"""
        if initial:
            self._right_visible = not self._right_visible
            self._reflow_panes()
            return
        self.update()
        self._snapshot_pane_widths()
        self._right_visible = not self._right_visible
        self._pane_layout_refresh()
        self._save_current_config()

    def _on_per_sentence_toggled(self, *_args):
        # 文ごとに個別タグを付ける場合、「文と文の間隔」は結合しないため無関係になる
        self.gap_spin.configure(state="disabled" if self.per_sentence_var.get() else "normal")

    def _on_settings_changed(self, *_args):
        self._save_current_config()

    def _is_on_screen(self, x: int, y: int) -> bool:
        """保存されていたウィンドウ左上座標(x, y)が、現在の画面(仮想デスクトップ)
        の範囲内かどうかを判定する。モニター構成が変わった後に前回の座標を
        復元すると画面外に表示されてしまう(タスクバー等でしか存在を確認できない)
        事故を防ぐためのチェック。"""
        try:
            sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        except tk.TclError:
            return False
        margin = 100  # 少しでも画面内に頭が出ていればOKとする
        return -margin <= x < sw and -margin <= y < sh

    def _on_close(self):
        """終了時にウィンドウサイズ・ペイン状態を含めて設定を保存してから閉じる。"""
        self._stop_test_waveform_animation()
        if WINSOUND_AVAILABLE:
            try:
                winsound.PlaySound(None, winsound.SND_PURGE)
            except Exception:  # noqa: BLE001
                pass
        try:
            self._save_current_config()
        finally:
            self.destroy()

    # --- UI構築 ---------------------------------------------------------
    LEFT_PANE_WIDTH = 430  # 左の設定ペインの幅(px)
    COLLAPSED_TAB_WIDTH = 32  # 縮小時の縦タブの幅(px)。ノート一覧・プレビューで共通

    def _build_widgets(self):
        # --- ヘッダー(タイトル + 設定ボタン) ---
        # ダーク/ライト切替は2026-07-27に「⚙ 設定」ダイアログの「全般」タブへ
        # 移動した(他の「一度設定したらそのまま」の項目と同じ理由)。
        header = ttk.Frame(self)
        header.pack(fill="x", padx=14, pady=(12, 2))
        ttk.Label(
            header, text="Anki TTS 音声追加ツール", font=("", 15, "bold")
        ).pack(side="left")
        ttk.Button(
            header,
            text="⚙ 設定",
            command=self._open_settings_dialog,
            style="Accent.TButton" if SV_TTK_AVAILABLE else "TButton",
        ).pack(side="right", padx=(0, 6))

        # --- 下段(進捗バー + ログ)。メインペインより先にpackしておくことで、
        #     ウィンドウを縮めたときに設定・一覧より先に見えなくなるのを防ぐ ---
        bottom = ttk.Frame(self)
        bottom.pack(side="bottom", fill="x", padx=12, pady=(2, 10))
        self.progress = ttk.Progressbar(bottom, mode="determinate")
        self.progress.pack(fill="x", pady=(0, 2))
        log_header = ttk.Frame(bottom)
        log_header.pack(fill="x")
        ttk.Label(log_header, text="ログ").pack(side="left")
        self._log_visible = True
        self.log_toggle_btn = ttk.Button(log_header, text="隠す", width=8, command=self._toggle_log)
        self.log_toggle_btn.pack(side="right")
        self.log_text = tk.Text(bottom, height=6, state="disabled", wrap="word", bd=0)
        self.log_text.pack(fill="x", pady=(2, 0))

        # --- メイン3ペイン(左:設定 / 中央:ノート一覧 / 右:プレビュー) ---
        main_pane = ttk.PanedWindow(self, orient="horizontal")
        main_pane.pack(fill="both", expand=True, padx=12, pady=2)

        # === 左ペイン: 設定列(縦スクロール) ===
        left_outer = ttk.Frame(main_pane)
        main_pane.add(left_outer, weight=0)

        # --- 入力元タブバー(固定。左ペインをスクロールしても常に見える) ---
        source_tabbar = ttk.Frame(left_outer)
        source_tabbar.pack(side="top", fill="x", padx=6, pady=(6, 0))
        self.source_tab_var = tk.StringVar(value="daily")
        self._source_tab_buttons = {}
        # 表示順は入力の流れが分かるように: DailyConversation/AIに質問(習熟用への
        # 供給元)→習熟用(それらを集約して出力)→apkgインポート(独立した手動経路)
        self._source_tab_labels = {
            "daily": "DailyConversation",
            "ai_ask": "AIに質問",
            "shuujuku": "習熟用(音読)",
            "word": "単語",
            "apkg_import": "apkgインポート",
        }
        for key, label in self._source_tab_labels.items():
            btn = ttk.Button(
                source_tabbar, text=label, command=lambda k=key: self._switch_source_tab(k)
            )
            btn.pack(side="left", fill="x", expand=True, padx=1)
            self._source_tab_buttons[key] = btn

        left_canvas_area = ttk.Frame(left_outer)
        left_canvas_area.pack(side="top", fill="both", expand=True)
        left_canvas = tk.Canvas(
            left_canvas_area, highlightthickness=0, bd=0, width=self.LEFT_PANE_WIDTH
        )
        left_scroll = ttk.Scrollbar(left_canvas_area, orient="vertical", command=left_canvas.yview)
        left_canvas.configure(yscrollcommand=left_scroll.set)
        left_canvas.pack(side="left", fill="both", expand=True)
        left_scroll.pack(side="right", fill="y")

        settings = ttk.Frame(left_canvas)
        settings_window = left_canvas.create_window((0, 0), window=settings, anchor="nw")

        def _on_settings_configure(event):
            left_canvas.configure(scrollregion=left_canvas.bbox("all"))

        def _on_left_canvas_configure(event):
            left_canvas.itemconfigure(settings_window, width=event.width)

        settings.bind("<Configure>", _on_settings_configure)
        left_canvas.bind("<Configure>", _on_left_canvas_configure)

        # マウスホイールは左ペインにポインタが乗っている間だけ設定列をスクロールする
        # (常時bind_allすると中央の一覧・右のプレビューのスクロールを奪ってしまうため)
        def _on_mousewheel(event):
            left_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        left_canvas.bind(
            "<Enter>", lambda e: left_canvas.bind_all("<MouseWheel>", _on_mousewheel)
        )
        left_canvas.bind("<Leave>", lambda e: left_canvas.unbind_all("<MouseWheel>"))

        pad = {"padx": 6, "pady": 5}
        hint_wrap = self.LEFT_PANE_WIDTH - 60

        # --- ① 入力元を選択(タブ切替) ---------------------------------
        # 入力源(DailyConversation/習熟用/AIに質問)を増やしても、ここに
        # タブを追加するだけで済むようにする。どのタブで生成しても、
        # 結果は下の「① 結果のapkg」欄に集約され、②以降は共通の処理になる。
        # タブ選択ボタン自体はleft_outer側の固定ヘッダー(source_tabbar)にあり、
        # ここは各タブの中身(3枚のFrame)を保持するだけの容器。
        frm_source = ttk.LabelFrame(settings, text="① 入力元を選択")
        frm_source.pack(fill="x", **pad)
        self.source_tabs_container = ttk.Frame(frm_source)
        self.source_tabs_container.pack(fill="x", padx=6, pady=6)

        # --- タブ: DailyConversation(スプレッドシート読み込み。実装済み) ---
        # スプレッドシートID・シート名は「一度設定したらそのまま」の項目なので
        # 2026-07-27に「⚙ 設定」ダイアログの「スプレッドシート」タブへ移動した
        # (このタブにはボタン・チェックボックスだけを残す)。
        tab_daily = ttk.Frame(self.source_tabs_container)
        tab_daily.grid_columnconfigure(0, weight=1)

        ttk.Label(
            tab_daily,
            text="スプレッドシートID・シート名は「⚙ 設定」の「スプレッドシート」タブで設定します。",
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=0, column=0, sticky="w", padx=8, pady=(8, 4))
        self.fetch_sheet_btn_label = "シートから未出力行を読み込んでデッキ生成"
        self.fetch_sheet_btn = ttk.Button(
            tab_daily,
            text=self.fetch_sheet_btn_label,
            command=self.on_fetch_from_sheet_clicked,
        )
        self.fetch_sheet_btn.grid(row=1, column=0, sticky="ew", padx=8, pady=(4, 8))
        ttk.Checkbutton(
            tab_daily,
            text="エクスポート後、対応する行を「Anki出力済み」にする",
            variable=self.sheets_update_var,
        ).grid(row=2, column=0, sticky="w", padx=8, pady=(0, 8))

        # --- タブ: 習熟用(音読)(DailyConversation/AIに質問からのストックをまとめて出力) ---
        tab_shuujuku = ttk.Frame(self.source_tabs_container)
        tab_shuujuku.grid_columnconfigure(0, weight=1)

        self.shuujuku_count_label = ttk.Label(tab_shuujuku, text="")
        self.shuujuku_count_label.grid(row=0, column=0, sticky="w", padx=8, pady=(8, 2))

        shuujuku_list_frame = ttk.Frame(tab_shuujuku)
        shuujuku_list_frame.grid(row=1, column=0, sticky="ew", padx=8, pady=(0, 4))
        self.shuujuku_listbox = tk.Listbox(shuujuku_list_frame, height=6, exportselection=False)
        shuujuku_list_vsb = ttk.Scrollbar(
            shuujuku_list_frame, orient="vertical", command=self.shuujuku_listbox.yview
        )
        self.shuujuku_listbox.configure(yscrollcommand=shuujuku_list_vsb.set)
        self.shuujuku_listbox.pack(side="left", fill="both", expand=True)
        shuujuku_list_vsb.pack(side="right", fill="y")
        self.shuujuku_listbox.bind("<<ListboxSelect>>", self.on_shuujuku_item_selected)

        shuujuku_btns = ttk.Frame(tab_shuujuku)
        shuujuku_btns.grid(row=2, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Button(shuujuku_btns, text="更新", width=8, command=self.refresh_shuujuku_stock_view).pack(
            side="left"
        )
        ttk.Button(
            shuujuku_btns,
            text="ストックをクリア",
            command=self.on_clear_shuujuku_stock_clicked,
        ).pack(side="left", padx=6)
        ttk.Button(
            tab_shuujuku,
            text="まとめて習熟用として出力",
            command=self.on_export_shuujuku_stock_clicked,
        ).grid(row=3, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Label(
            tab_shuujuku,
            text=(
                "DailyConversationタブでの読み込み時、AIに質問タブでの生成時に、"
                "それぞれ自動でここにストックされる(仮実装。Gemini API使用)。\n"
                "出力すると②のノートタイプ・フィールドに反映されるので、"
                "内容を確認してから③④に進んでください。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=4, column=0, sticky="w", padx=8, pady=(0, 8))

        # --- タブ: AIに質問(Gemini APIで回答生成→習熟用ストックへ追加。仮実装) ---
        tab_ai_ask = ttk.Frame(self.source_tabs_container)
        ttk.Label(tab_ai_ask, text="質問・お題:").pack(anchor="w", padx=8, pady=(8, 2))
        self.ai_ask_text = tk.Text(tab_ai_ask, height=4, wrap="word")
        self.ai_ask_text.pack(fill="x", padx=8, pady=(0, 4))
        self.ai_ask_generate_btn = ttk.Button(
            tab_ai_ask, text="AIに生成させる(習熟用ストックへ追加)", command=self.on_ai_ask_clicked
        )
        self.ai_ask_generate_btn.pack(anchor="w", padx=8, pady=(0, 4))
        ttk.Label(
            tab_ai_ask,
            text=(
                "生成結果はそのまま「習熟用(音読)」タブのストックに追加される"
                "(この場ではapkgを作らない)。仮実装としてGemini APIを使用。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).pack(fill="x", padx=8, pady=(0, 8))

        # --- タブ: 単語(読書中に出会った未学習の英単語をAIでカード化。2026-07-27追加) ---
        # 「習熟用(音読)」とは完全に別物: 文法パターンの音読練習ではなく、単語単体の
        # 記憶定着が目的のため、ここで生成した候補は習熟用ストック(shuujuku_stock.json)
        # には一切流さない。専用のword_stock.json(word_stock.py)で管理する。
        tab_word = ttk.Frame(self.source_tabs_container)
        tab_word.grid_columnconfigure(0, weight=1)

        # 2026-07-27変更: 単語1件ずつの入力から、「単語 | 文脈」のペアを複数行
        # まとめて入力できる形に変更(読書中に複数の未知語をまとめて調べたい
        # ニーズへの対応)。文脈は完全な英文である必要はなく、句動詞などの
        # 単語の組み合わせも想定している(片桐の指示により、AIへの指示文でも
        # 「完全な文でなくてよい」ことを明記してある。gemini_client.py参照)。
        ttk.Label(
            tab_word,
            text="未学習の単語(1行に1件、「単語 | 文脈」の形式。文脈は省略可):",
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=0, column=0, sticky="w", padx=8, pady=(8, 2))
        self.word_pairs_text = tk.Text(tab_word, height=5, wrap="none")
        self.word_pairs_text.grid(row=1, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Label(
            tab_word,
            text=(
                "例: give up | I'll never give up on my dream.\n"
                "文脈は完全な文でなくてもよい(句動詞や単語の組み合わせのみでも可)。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=2, column=0, sticky="w", padx=8, pady=(0, 4))
        self.word_generate_btn = ttk.Button(
            tab_word, text="AIに生成させる(単語ストックへ追加)", command=self.on_word_generate_clicked
        )
        self.word_generate_btn.grid(row=3, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Label(
            tab_word,
            text=(
                "生成結果は「習熟用(音読)」とは別の単語専用ストックに追加される"
                "(習熟用ストックには一切流さない)。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=4, column=0, sticky="w", padx=8, pady=(0, 8))

        self.word_count_label = ttk.Label(tab_word, text="")
        self.word_count_label.grid(row=6, column=0, sticky="w", padx=8, pady=(0, 2))

        word_list_frame = ttk.Frame(tab_word)
        word_list_frame.grid(row=7, column=0, sticky="ew", padx=8, pady=(0, 4))
        self.word_listbox = tk.Listbox(word_list_frame, height=6, exportselection=False)
        word_list_vsb = ttk.Scrollbar(
            word_list_frame, orient="vertical", command=self.word_listbox.yview
        )
        self.word_listbox.configure(yscrollcommand=word_list_vsb.set)
        self.word_listbox.pack(side="left", fill="both", expand=True)
        word_list_vsb.pack(side="right", fill="y")
        self.word_listbox.bind("<<ListboxSelect>>", self.on_word_item_selected)

        word_btns = ttk.Frame(tab_word)
        word_btns.grid(row=8, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Button(word_btns, text="更新", width=8, command=self.refresh_word_stock_view).pack(
            side="left"
        )
        ttk.Button(
            word_btns,
            text="ストックをクリア",
            command=self.on_clear_word_stock_clicked,
        ).pack(side="left", padx=6)
        ttk.Button(
            tab_word,
            text="まとめて単語カードとして出力",
            command=self.on_export_word_stock_clicked,
        ).grid(row=9, column=0, sticky="ew", padx=8, pady=(0, 4))
        ttk.Label(
            tab_word,
            text=(
                "出力すると②のノートタイプ・フィールドに反映されるので、"
                "内容を確認してから③④に進んでください(デッキ: "
                f"{self._word_deck_name_for_hint()})。カード内容(フィールド・"
                "テンプレート)は「⚙ 設定」の「カード定義」タブで編集できます。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=10, column=0, sticky="w", padx=8, pady=(0, 8))

        # --- タブ: apkgインポート(外部で生成された.apkgを手動で読み込む。
        #     DailyConversation/習熟用/AIに質問はapkgを参照しなくても用途を
        #     満たせるため、手動インポートはこの独立タブに分離してある) ---
        tab_apkg_import = ttk.Frame(self.source_tabs_container)
        tab_apkg_import.grid_columnconfigure(1, weight=1)

        ttk.Label(tab_apkg_import, text="apkgファイル:").grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 2)
        )
        ttk.Entry(tab_apkg_import, textvariable=self.apkg_path).grid(
            row=0, column=1, sticky="ew", pady=(8, 2)
        )
        ttk.Button(tab_apkg_import, text="参照...", width=7, command=self.on_browse_apkg).grid(
            row=0, column=2, padx=(4, 8), pady=(8, 2)
        )
        ttk.Label(tab_apkg_import, text="row_map.json:").grid(row=1, column=0, sticky="w", padx=8, pady=2)
        ttk.Entry(tab_apkg_import, textvariable=self.row_map_path).grid(row=1, column=1, sticky="ew", pady=2)
        ttk.Button(tab_apkg_import, text="参照...", width=7, command=self.on_browse_row_map).grid(
            row=1, column=2, padx=(4, 8), pady=2
        )

        if DND_AVAILABLE:
            tab_apkg_import.drop_target_register(DND_FILES)
            tab_apkg_import.dnd_bind("<<Drop>>", self.on_drop_apkg)
            drop_hint = "この枠に.apkgをドラッグ&ドロップできます。"
        else:
            drop_hint = "(tkinterdnd2未インストールのためドラッグ&ドロップは無効です)"
        ttk.Label(tab_apkg_import, text=drop_hint, wraplength=hint_wrap).grid(
            row=2, column=0, columnspan=3, sticky="w", padx=8, pady=(2, 2)
        )
        ttk.Checkbutton(
            tab_apkg_import,
            text="エクスポート後、対応する行を「Anki出力済み」にする",
            variable=self.sheets_update_var,
        ).grid(row=3, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 4))
        ttk.Label(
            tab_apkg_import,
            text=(
                "外部(別チャット等)で生成した.apkgを直接読み込みたい場合に使う。"
                "row_map.jsonを指定すれば、Anki出力済みへの書き戻しも可能。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=4, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 8))

        # タブ本体5枚をキー付きで保持し、固定ヘッダーのボタンから切り替える
        self._source_tab_frames = {
            "daily": tab_daily,
            "ai_ask": tab_ai_ask,
            "shuujuku": tab_shuujuku,
            "word": tab_word,
            "apkg_import": tab_apkg_import,
        }
        self._switch_source_tab("daily")
        # Gemini API設定・TTS設定は共通の「⚙ 設定」ダイアログ側にあるため
        # (_build_settings_dialog)、ここでは何もしない。

        # --- ② ノートタイプ・フィールド ---
        frm_fields = ttk.LabelFrame(settings, text="② ノートタイプ・フィールド")
        frm_fields.pack(fill="x", **pad)
        frm_fields.grid_columnconfigure(1, weight=1)

        ttk.Label(frm_fields, text="ノートタイプ:").grid(row=0, column=0, sticky="w", padx=8, pady=5)
        self.notetype_combo = ttk.Combobox(
            frm_fields, textvariable=self.notetype_var, state="readonly"
        )
        self.notetype_combo.grid(row=0, column=1, sticky="ew", padx=(0, 8), pady=5)
        self.notetype_combo.bind("<<ComboboxSelected>>", self.on_notetype_selected)

        ttk.Label(frm_fields, text="読み上げ元 (Source):").grid(
            row=1, column=0, sticky="w", padx=8, pady=5
        )
        self.source_combo = ttk.Combobox(
            frm_fields, textvariable=self.source_field_var, state="readonly"
        )
        self.source_combo.grid(row=1, column=1, sticky="ew", padx=(0, 8), pady=5)
        self.source_combo.bind("<<ComboboxSelected>>", self.update_preview)

        ttk.Label(frm_fields, text="タグ追加先 (Target):").grid(
            row=2, column=0, sticky="w", padx=8, pady=5
        )
        self.target_combo = ttk.Combobox(
            frm_fields, textvariable=self.target_field_var, state="readonly"
        )
        self.target_combo.grid(row=2, column=1, sticky="ew", padx=(0, 8), pady=(5, 8))
        self.target_combo.bind("<<ComboboxSelected>>", self.update_preview)

        # TTS設定はヘッダーの「⚙ 設定」ダイアログに移設した(_build_settings_dialog)。

        # --- ③ 出力・オプション ---
        # 出力先(パス編集)は2026-07-27に「⚙ 設定」ダイアログの「出力先」タブへ
        # 移動した。ここでは現在の出力先を確認できるよう、読み取り専用の表示だけ残す。
        frm_out = ttk.LabelFrame(settings, text="③ 出力・オプション")
        frm_out.pack(fill="x", **pad)
        frm_out.grid_columnconfigure(0, weight=1)

        ttk.Label(frm_out, text="出力先(⚙ 設定で変更):").grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 0)
        )
        ttk.Label(
            frm_out, textvariable=self.output_path, foreground="#888888", wraplength=hint_wrap
        ).grid(row=1, column=0, sticky="w", padx=8, pady=(0, 6))

        ttk.Checkbutton(
            frm_out,
            text="既存の音声を上書きして再生成する",
            variable=self.force_regen_var,
        ).grid(row=2, column=0, sticky="w", padx=8, pady=2)
        ttk.Checkbutton(
            frm_out,
            text="生成前に元のapkgを自動バックアップする",
            variable=self.auto_backup_var,
        ).grid(row=3, column=0, sticky="w", padx=8, pady=2)
        ttk.Checkbutton(
            frm_out,
            text="生成完了後、出力apkgを自動でAnkiに渡す",
            variable=self.auto_open_anki_var,
        ).grid(row=4, column=0, sticky="w", padx=8, pady=2)

        out_btns = ttk.Frame(frm_out)
        out_btns.grid(row=5, column=0, sticky="ew", padx=8, pady=(4, 8))
        ttk.Button(out_btns, text="ドライラン(件数確認)", command=self.on_dry_run_clicked).pack(
            side="left"
        )
        ttk.Button(
            out_btns, text="バックアップ管理...", command=self.on_manage_backups_clicked
        ).pack(side="left", padx=6)

        # --- ⑤ 実行 ---
        frm_run = ttk.Frame(settings)
        frm_run.pack(fill="x", padx=6, pady=(8, 12))
        self.generate_btn = ttk.Button(
            frm_run,
            text="④ TTS音声を生成する",
            command=self.on_generate_clicked,
            style="Accent.TButton" if SV_TTK_AVAILABLE else "TButton",
        )
        self.generate_btn.pack(side="left", fill="x", expand=True)
        self.cancel_btn = ttk.Button(
            frm_run, text="キャンセル", command=self.on_cancel_clicked, state="disabled", width=10
        )
        self.cancel_btn.pack(side="left", padx=(6, 0))

        # === 中央ペイン: ノート一覧 ===
        self._main_pane = main_pane
        mid = ttk.Frame(main_pane)
        main_pane.add(mid, weight=1)
        self._mid_frame = mid
        self._mid_visible = True

        mid_header = ttk.Frame(mid)
        mid_header.pack(fill="x", padx=(8, 0), pady=(4, 2))
        ttk.Label(mid_header, text="ノート一覧", font=("", 11, "bold")).pack(side="left")
        ttk.Button(mid_header, text="◀ 隠す", width=7, command=self._toggle_mid_pane).pack(
            side="right"
        )
        self.notes_count_label = ttk.Label(mid_header, text="")
        self.notes_count_label.pack(side="right", padx=(0, 8))

        tree_frame = ttk.Frame(mid)
        tree_frame.pack(fill="both", expand=True, padx=(8, 0))
        self.notes_tree = ttk.Treeview(tree_frame, show="headings")
        tree_vsb = ttk.Scrollbar(tree_frame, orient="vertical", command=self.notes_tree.yview)
        self.notes_tree.configure(yscrollcommand=tree_vsb.set)
        self.notes_tree.pack(side="left", fill="both", expand=True)
        tree_vsb.pack(side="right", fill="y")
        self.notes_tree.bind("<<TreeviewSelect>>", self.on_note_row_selected)

        mid_btns = ttk.Frame(mid)
        mid_btns.pack(fill="x", padx=(8, 0), pady=4)
        ttk.Button(mid_btns, text="🔊 試聴", command=self.on_preview_play_clicked).pack(side="left")
        ttk.Button(
            mid_btns, text="🔍 カードをプレビュー", command=self.on_open_card_in_browser
        ).pack(side="left", padx=6)

        # === 右ペイン: プレビュー(選択中ノートの全フィールド) ===
        right = ttk.Frame(main_pane)
        main_pane.add(right, weight=2)
        self._right_frame = right
        self._right_visible = True

        right_header = ttk.Frame(right)
        right_header.pack(fill="x", padx=(8, 0), pady=(4, 2))
        ttk.Label(right_header, text="プレビュー", font=("", 11, "bold")).pack(side="left")
        ttk.Button(right_header, text="◀ 隠す", width=7, command=self._toggle_right_pane).pack(
            side="right"
        )

        pv_frame = ttk.Frame(right)
        pv_frame.pack(fill="both", expand=True, padx=(8, 0))
        self.preview_text = tk.Text(
            pv_frame, wrap="word", state="disabled", bd=0, padx=12, pady=10
        )
        pv_vsb = ttk.Scrollbar(pv_frame, orient="vertical", command=self.preview_text.yview)
        self.preview_text.configure(yscrollcommand=pv_vsb.set)
        self.preview_text.pack(side="left", fill="both", expand=True)
        pv_vsb.pack(side="right", fill="y")

        self.preview_text.tag_configure("fieldname", font=("", 10, "bold"), spacing1=10, spacing3=3)
        self.preview_text.tag_configure("badge", foreground="#5c85cf", font=("", 9, "bold"))
        self.preview_text.tag_configure("empty", foreground="#888888")

        # --- 縮小時に表示する縦タブ(クリックで再展開) ---
        # ペインを「隠す」と、その位置に細い縦書きタブだけが残る(VSCodeのサイドバー風)。
        # フレーム幅を固定してpack_propagateを切ることで、ボタンの文字数に関係なく
        # 2つのタブが必ず同じ幅になるようにする。
        self._mid_tab = ttk.Frame(main_pane, width=self.COLLAPSED_TAB_WIDTH)
        self._mid_tab.pack_propagate(False)
        ttk.Button(
            self._mid_tab,
            text="ノ\nー\nト\n一\n覧\n▶",
            command=self._toggle_mid_pane,
        ).pack(fill="both", expand=True, pady=2)
        self._right_tab = ttk.Frame(main_pane, width=self.COLLAPSED_TAB_WIDTH)
        self._right_tab.pack_propagate(False)
        ttk.Button(
            self._right_tab,
            text="プ\nレ\nビ\nュ\nー\n▶",
            command=self._toggle_right_pane,
        ).pack(fill="both", expand=True, pady=2)

        # tk.Text(ログ・プレビュー)はttkテーマの対象外なので、手動で配色を合わせる
        self._style_text_widgets(self.theme_var.get())

        self._build_settings_dialog()

    def _build_settings_dialog(self):
        """TTS設定・Gemini API設定・スプレッドシート連携・出力先は、生成の
        たびに触るものではなく「一度設定したら基本そのまま」のものなので、
        メイン画面の常設パネルではなく独立した設定ダイアログにまとめている
        (メイン画面をワークフロー関連の項目だけに保つため)。起動時に1回だけ
        構築して隠しておき(withdraw)、「⚙ 設定」ボタンでdeiconifyするだけに
        することで、`self.voice_combo`等のウィジェット参照をアプリ起動中
        ずっと有効なままにしている(毎回作り直すと、ダイアログを閉じている間に
        on_fetch_voices等から参照できなくなってしまうため)。
        2026-07-27に、それまで縦積みだったLabelFrameをカテゴリ別の横タブ
        (ttk.Notebook)に再構成し、DailyConversationタブにあったスプレッドシート
        ID/シート名、③出力・オプションにあった出力先もここへ移動した
        (それぞれ元の場所は「⚙ 設定」を参照するよう案内文言に変更)。"""
        pad = {"padx": 10, "pady": 6}
        hint_wrap = 420

        dlg = tk.Toplevel(self)
        self.settings_dialog = dlg
        dlg.title("設定")
        dlg.geometry("480x620")
        dlg.minsize(440, 480)
        dlg.withdraw()
        dlg.protocol("WM_DELETE_WINDOW", dlg.withdraw)

        notebook = ttk.Notebook(dlg)
        notebook.pack(fill="both", expand=True, padx=8, pady=(8, 0))

        # --- 全般タブ(2026-07-27追加: テーマ切替をヘッダーから移動) ---
        tab_general = ttk.Frame(notebook)
        notebook.add(tab_general, text="全般")
        ttk.Label(tab_general, text="テーマ:").grid(row=0, column=0, sticky="w", padx=8, pady=(10, 5))
        theme_row = ttk.Frame(tab_general)
        theme_row.grid(row=0, column=1, sticky="w", pady=(10, 5))
        ttk.Radiobutton(
            theme_row,
            text="☀ ライト",
            variable=self.theme_var,
            value="light",
            command=self.on_theme_setting_changed,
        ).pack(side="left")
        ttk.Radiobutton(
            theme_row,
            text="🌙 ダーク",
            variable=self.theme_var,
            value="dark",
            command=self.on_theme_setting_changed,
        ).pack(side="left", padx=(10, 0))

        # --- TTS設定タブ ---
        tab_tts = ttk.Frame(notebook)
        notebook.add(tab_tts, text="TTS")
        tab_tts.grid_columnconfigure(1, weight=1)

        ttk.Label(tab_tts, text="Google Cloud APIキー:").grid(
            row=0, column=0, sticky="w", padx=8, pady=(10, 5)
        )
        ttk.Entry(tab_tts, textvariable=self.api_key_var, show="*").grid(
            row=0, column=1, columnspan=2, sticky="ew", padx=(0, 8), pady=(10, 5)
        )
        ttk.Checkbutton(
            tab_tts, text="このPCに保存する", variable=self.remember_key_var
        ).grid(row=1, column=1, columnspan=2, sticky="w", pady=(0, 4))

        ttk.Label(tab_tts, text="言語コード:").grid(row=2, column=0, sticky="w", padx=8, pady=5)
        self.lang_combo = ttk.Combobox(
            tab_tts, textvariable=self.lang_var, values=tts_core.COMMON_LANGUAGE_CODES, width=12
        )
        self.lang_combo.grid(row=2, column=1, sticky="w", pady=5)
        self.lang_combo.bind("<<ComboboxSelected>>", lambda e: self.on_fetch_voices(silent=True))
        self.lang_combo.bind("<FocusOut>", lambda e: self.on_fetch_voices(silent=True))
        ttk.Button(
            tab_tts, text="音声一覧を取得", command=lambda: self.on_fetch_voices(silent=False)
        ).grid(row=2, column=2, sticky="e", padx=(4, 8), pady=5)

        ttk.Label(tab_tts, text="音声名 (voice):").grid(row=3, column=0, sticky="w", padx=8, pady=5)
        self.voice_combo = ttk.Combobox(
            tab_tts,
            textvariable=self.voice_var,
            values=[self.voice_var.get()],
            state="readonly",
        )
        self.voice_combo.grid(row=3, column=1, columnspan=2, sticky="ew", padx=(0, 8), pady=5)

        ttk.Label(tab_tts, text="文と文の間隔(秒):").grid(row=4, column=0, sticky="w", padx=8, pady=5)
        self.gap_spin = ttk.Spinbox(
            tab_tts,
            from_=0.0,
            to=5.0,
            increment=0.1,
            textvariable=self.sentence_gap_var,
            width=8,
        )
        self.gap_spin.grid(row=4, column=1, sticky="w", pady=5)

        ttk.Label(tab_tts, text="MP3圧縮ビットレート(kbps):").grid(
            row=5, column=0, sticky="w", padx=8, pady=5
        )
        self.bitrate_combo = ttk.Combobox(
            tab_tts,
            textvariable=self.mp3_bitrate_var,
            values=["32", "48", "64", "96", "128", "192"],
            state="readonly",
            width=8,
        )
        self.bitrate_combo.grid(row=5, column=1, sticky="w", pady=5)
        if not tts_core.LAMEENC_AVAILABLE:
            ttk.Label(
                tab_tts,
                text="(lameenc未インストールのため圧縮できません。WAVのまま出力されます)",
                wraplength=hint_wrap,
            ).grid(row=6, column=0, columnspan=3, sticky="w", padx=8)

        ttk.Checkbutton(
            tab_tts,
            text="文ごとに音声を分けて別タグを付ける(結合しない)",
            variable=self.per_sentence_var,
        ).grid(row=7, column=0, columnspan=3, sticky="w", padx=8, pady=(4, 8))

        # --- 音量ゲイン+テスト再生(2026-07-27追加) ---
        # 「TTSの音声が小さい場合がある」への対応。音量はGoogle Cloud TTSの
        # audioConfig.volumeGainDbで指定する(-96.0〜+16.0dBが有効範囲だが、
        # UIでは実用的な範囲に絞ってある)。ローカルで音声データを後から
        # 増幅するのではなく合成時点のゲインなので、クリッピング(音割れ)の
        # 心配が少ない。この値はテスト再生だけでなく、実際のカード生成にも
        # そのまま使われる(run_generate参照)。
        ttk.Label(tab_tts, text="音量ゲイン(dB):").grid(row=8, column=0, sticky="w", padx=8, pady=5)
        gain_row = ttk.Frame(tab_tts)
        gain_row.grid(row=8, column=1, columnspan=2, sticky="ew", padx=(0, 8), pady=5)
        gain_row.grid_columnconfigure(0, weight=1)
        self.volume_gain_scale = ttk.Scale(
            gain_row, from_=-20.0, to=16.0, orient="horizontal", variable=self.volume_gain_db_var
        )
        self.volume_gain_scale.grid(row=0, column=0, sticky="ew")
        self.volume_gain_value_label = ttk.Label(
            gain_row, text=self._format_gain_db(self.volume_gain_db_var.get()), width=8
        )
        self.volume_gain_value_label.grid(row=0, column=1, padx=(6, 0))
        self.volume_gain_db_var.trace_add("write", self._on_volume_gain_display_changed)
        self.auto_gain_btn = ttk.Button(
            gain_row, text="自動調整", width=8, command=self.on_auto_gain_clicked
        )
        self.auto_gain_btn.grid(row=0, column=2, padx=(6, 0))

        ttk.Label(
            tab_tts,
            text=(
                "「自動調整」で、0dB(音割れ)を超えない範囲でできるだけ音量が"
                "大きくなるようゲインを自動計算します(Google Cloud APIキーが必要)。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=9, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 4))

        ttk.Label(
            tab_tts,
            text=(
                "「テスト再生」で、上記の音声・言語コード・文と文の間隔・音量ゲインの"
                "設定を反映した短いサンプル文(2文)を確認できます。"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=10, column=0, columnspan=3, sticky="w", padx=8, pady=(6, 4))

        self.test_waveform_canvas = tk.Canvas(
            tab_tts, width=380, height=50, highlightthickness=1, highlightbackground="#888888"
        )
        self.test_waveform_canvas.grid(row=11, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 4))

        test_play_row = ttk.Frame(tab_tts)
        test_play_row.grid(row=12, column=0, columnspan=3, sticky="ew", padx=8, pady=(0, 10))
        self.test_play_btn = ttk.Button(
            test_play_row, text="▶ テスト再生", command=self.on_test_play_clicked
        )
        self.test_play_btn.pack(side="left")
        self.test_play_status_label = ttk.Label(test_play_row, text="")
        self.test_play_status_label.pack(side="left", padx=(8, 0))
        if not WINSOUND_AVAILABLE:
            self.test_play_btn.configure(state="disabled")
            self.test_play_status_label.configure(text="(この環境では利用できません)")

        # --- Gemini APIタブ ---
        tab_gemini = ttk.Frame(notebook)
        notebook.add(tab_gemini, text="Gemini API")
        tab_gemini.grid_columnconfigure(1, weight=1)
        ttk.Label(
            tab_gemini,
            text="DailyConversationタブでの習熟用候補の自動生成、および「AIに質問」タブで使用します。",
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(10, 6))
        ttk.Label(tab_gemini, text="APIキー:").grid(row=1, column=0, sticky="w", padx=8, pady=(0, 2))
        ttk.Entry(tab_gemini, textvariable=self.gemini_api_key_var, show="*").grid(
            row=1, column=1, columnspan=2, sticky="ew", padx=(0, 8), pady=(0, 2)
        )
        ttk.Label(tab_gemini, text="モデル名:").grid(row=2, column=0, sticky="w", padx=8, pady=(0, 8))
        self.gemini_model_combo = ttk.Combobox(
            tab_gemini,
            textvariable=self.gemini_model_var,
            values=self.gemini_models_cache or [self.gemini_model_var.get()],
        )
        self.gemini_model_combo.grid(row=2, column=1, sticky="ew", padx=(0, 4), pady=(0, 8))
        ttk.Button(
            tab_gemini, text="モデル一覧を取得", command=lambda: self.on_fetch_gemini_models(silent=False)
        ).grid(row=2, column=2, sticky="e", padx=(0, 8), pady=(0, 8))

        # --- スプレッドシートタブ(2026-07-27追加: DailyConversationタブから移動) ---
        tab_sheets = ttk.Frame(notebook)
        notebook.add(tab_sheets, text="スプレッドシート")
        tab_sheets.grid_columnconfigure(1, weight=1)
        ttk.Label(
            tab_sheets,
            text="「添削結果」シートの読み込み元です。DailyConversationタブの"
            "「シートから未出力行を読み込んでデッキ生成」ボタンで使用します。",
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=0, column=0, columnspan=2, sticky="w", padx=8, pady=(10, 6))
        ttk.Label(tab_sheets, text="スプレッドシートID:").grid(
            row=1, column=0, sticky="w", padx=8, pady=5
        )
        ttk.Entry(tab_sheets, textvariable=self.sheets_spreadsheet_id_var).grid(
            row=1, column=1, sticky="ew", padx=(0, 8), pady=5
        )
        ttk.Label(tab_sheets, text="シート(タブ)名:").grid(row=2, column=0, sticky="w", padx=8, pady=5)
        ttk.Entry(tab_sheets, textvariable=self.sheets_sheet_name_var, width=18).grid(
            row=2, column=1, sticky="w", padx=(0, 8), pady=5
        )

        # --- 出力先タブ(2026-07-27追加: ③出力・オプションから移動) ---
        tab_output = ttk.Frame(notebook)
        notebook.add(tab_output, text="出力先")
        tab_output.grid_columnconfigure(1, weight=1)
        ttk.Label(
            tab_output,
            text="TTS音声追加後に書き出すapkgの出力先です。apkgを選択・生成すると"
            "既定のファイル名が自動入力されます(必要なら変更してください)。",
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(10, 6))
        ttk.Label(tab_output, text="出力先:").grid(row=1, column=0, sticky="w", padx=8, pady=5)
        ttk.Entry(tab_output, textvariable=self.output_path).grid(
            row=1, column=1, sticky="ew", pady=5
        )
        ttk.Button(tab_output, text="参照...", width=7, command=self.on_browse_output).grid(
            row=1, column=2, padx=(4, 8), pady=5
        )

        # --- カード定義タブ(2026-07-27新設) ---
        # 「単語」タブなど、AIが都度カード内容を生成するタブが出力するノート
        # タイプ(フィールド名・カードテンプレート・CSS・デッキ)を、Pythonコードの
        # 編集無しにここから直接編集できるようにする(card_defs.json)。
        # 対象範囲はcard_defs.pyのdocstring参照(2026-07-27時点では「単語」のみ)。
        # 縦に長くなるため、他タブと違いスクロール可能なCanvasに載せてある。
        tab_carddefs_outer = ttk.Frame(notebook)
        notebook.add(tab_carddefs_outer, text="カード定義")

        carddefs_canvas = tk.Canvas(tab_carddefs_outer, highlightthickness=0, bd=0)
        carddefs_scroll = ttk.Scrollbar(
            tab_carddefs_outer, orient="vertical", command=carddefs_canvas.yview
        )
        carddefs_canvas.configure(yscrollcommand=carddefs_scroll.set)
        carddefs_canvas.pack(side="left", fill="both", expand=True)
        carddefs_scroll.pack(side="right", fill="y")

        tab_carddefs = ttk.Frame(carddefs_canvas)
        carddefs_window = carddefs_canvas.create_window((0, 0), window=tab_carddefs, anchor="nw")

        def _on_carddefs_configure(event):
            carddefs_canvas.configure(scrollregion=carddefs_canvas.bbox("all"))

        def _on_carddefs_canvas_configure(event):
            carddefs_canvas.itemconfigure(carddefs_window, width=event.width)

        tab_carddefs.bind("<Configure>", _on_carddefs_configure)
        carddefs_canvas.bind("<Configure>", _on_carddefs_canvas_configure)

        def _on_carddefs_mousewheel(event):
            carddefs_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        carddefs_canvas.bind(
            "<Enter>", lambda e: carddefs_canvas.bind_all("<MouseWheel>", _on_carddefs_mousewheel)
        )
        carddefs_canvas.bind("<Leave>", lambda e: carddefs_canvas.unbind_all("<MouseWheel>"))

        tab_carddefs.grid_columnconfigure(1, weight=1)
        cpad = {"padx": 8, "pady": 4}

        ttk.Label(tab_carddefs, text="定義一覧:").grid(row=0, column=0, sticky="w", **cpad)
        carddef_list_frame = ttk.Frame(tab_carddefs)
        carddef_list_frame.grid(row=1, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 4))
        self.carddef_listbox = tk.Listbox(carddef_list_frame, height=4, exportselection=False)
        carddef_list_vsb = ttk.Scrollbar(
            carddef_list_frame, orient="vertical", command=self.carddef_listbox.yview
        )
        self.carddef_listbox.configure(yscrollcommand=carddef_list_vsb.set)
        self.carddef_listbox.pack(side="left", fill="both", expand=True)
        carddef_list_vsb.pack(side="right", fill="y")
        self.carddef_listbox.bind("<<ListboxSelect>>", self.on_carddef_selected)

        carddef_btns = ttk.Frame(tab_carddefs)
        carddef_btns.grid(row=2, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 8))
        ttk.Button(carddef_btns, text="新規作成", command=self.on_carddef_new_clicked).pack(
            side="left"
        )
        ttk.Button(carddef_btns, text="削除", command=self.on_carddef_delete_clicked).pack(
            side="left", padx=6
        )
        ttk.Button(
            carddef_btns, text="apkgから読み込む...", command=self.on_carddef_import_apkg_clicked
        ).pack(side="left")

        ttk.Separator(tab_carddefs, orient="horizontal").grid(
            row=3, column=0, columnspan=2, sticky="ew", padx=8, pady=4
        )

        ttk.Label(tab_carddefs, text="キー(内部識別子):").grid(row=4, column=0, sticky="w", **cpad)
        carddef_key_cell = ttk.Frame(tab_carddefs)
        carddef_key_cell.grid(row=4, column=1, sticky="ew", **cpad)
        carddef_key_cell.grid_columnconfigure(0, weight=1)
        self.carddef_key_var = tk.StringVar()
        ttk.Entry(carddef_key_cell, textvariable=self.carddef_key_var, state="readonly").grid(
            row=0, column=0, sticky="ew"
        )
        # このキーが実際にどのタブの出力に使われているかを明示する
        # (2026-07-27追加: 「このカードタイプがどのタブの機能に属するか分かりにくい」
        # との指摘への対応。self._source_tab_labelsのキーと一致すればそのタブ名を、
        # 一致しなければ「どのタブにも未接続」と表示する)
        self.carddef_tab_usage_label = ttk.Label(carddef_key_cell, text="", foreground="#888888")
        self.carddef_tab_usage_label.grid(row=1, column=0, sticky="w", pady=(2, 0))
        ttk.Label(tab_carddefs, text="表示名:").grid(row=5, column=0, sticky="w", **cpad)
        self.carddef_label_var = tk.StringVar()
        ttk.Entry(tab_carddefs, textvariable=self.carddef_label_var).grid(
            row=5, column=1, sticky="ew", **cpad
        )
        ttk.Label(tab_carddefs, text="ノートタイプ名:").grid(row=6, column=0, sticky="w", **cpad)
        self.carddef_notetype_var = tk.StringVar()
        ttk.Entry(tab_carddefs, textvariable=self.carddef_notetype_var).grid(
            row=6, column=1, sticky="ew", **cpad
        )
        ttk.Label(tab_carddefs, text="デッキ名:").grid(row=7, column=0, sticky="w", **cpad)
        self.carddef_deckname_var = tk.StringVar()
        ttk.Entry(tab_carddefs, textvariable=self.carddef_deckname_var).grid(
            row=7, column=1, sticky="ew", **cpad
        )
        ttk.Label(tab_carddefs, text="重複防止キー(内部項目名):").grid(
            row=8, column=0, sticky="w", **cpad
        )
        self.carddef_dedupkey_var = tk.StringVar()
        ttk.Entry(tab_carddefs, textvariable=self.carddef_dedupkey_var, width=16).grid(
            row=8, column=1, sticky="w", **cpad
        )

        ttk.Label(
            tab_carddefs,
            text=(
                "フィールド一覧(1行1フィールド、「Ankiフィールド名 = 内部項目名」の"
                "形式。内部項目名はAIが生成するデータのキー名と一致させること):"
            ),
            wraplength=hint_wrap,
            justify="left",
        ).grid(row=9, column=0, columnspan=2, sticky="w", padx=8, pady=(6, 2))
        self.carddef_fields_text = tk.Text(tab_carddefs, height=6, wrap="none")
        self.carddef_fields_text.grid(row=10, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 6))

        ttk.Label(tab_carddefs, text="テンプレート:").grid(row=11, column=0, sticky="w", padx=8, pady=(2, 2))
        template_sel_row = ttk.Frame(tab_carddefs)
        template_sel_row.grid(row=11, column=1, sticky="ew", padx=8, pady=(2, 2))
        self.carddef_template_combo = ttk.Combobox(template_sel_row, state="readonly", width=20)
        self.carddef_template_combo.pack(side="left")
        self.carddef_template_combo.bind("<<ComboboxSelected>>", self.on_carddef_template_selected)
        ttk.Button(
            template_sel_row, text="追加", width=5, command=self.on_carddef_template_add_clicked
        ).pack(side="left", padx=(4, 0))
        ttk.Button(
            template_sel_row, text="削除", width=5, command=self.on_carddef_template_remove_clicked
        ).pack(side="left", padx=(2, 0))

        ttk.Label(tab_carddefs, text="テンプレート名:").grid(row=12, column=0, sticky="w", padx=8, pady=2)
        self.carddef_template_name_var = tk.StringVar()
        ttk.Entry(tab_carddefs, textvariable=self.carddef_template_name_var).grid(
            row=12, column=1, sticky="ew", padx=8, pady=2
        )

        ttk.Label(tab_carddefs, text="表面(Front)テンプレート:").grid(
            row=13, column=0, columnspan=2, sticky="w", padx=8, pady=(4, 2)
        )
        self.carddef_qfmt_text = tk.Text(tab_carddefs, height=5, wrap="none")
        self.carddef_qfmt_text.grid(row=14, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 6))

        ttk.Label(tab_carddefs, text="裏面(Back)テンプレート:").grid(
            row=15, column=0, columnspan=2, sticky="w", padx=8, pady=(0, 2)
        )
        self.carddef_afmt_text = tk.Text(tab_carddefs, height=5, wrap="none")
        self.carddef_afmt_text.grid(row=16, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 6))

        ttk.Label(tab_carddefs, text="CSS:").grid(row=17, column=0, columnspan=2, sticky="w", padx=8, pady=(0, 2))
        self.carddef_css_text = tk.Text(tab_carddefs, height=6, wrap="none")
        self.carddef_css_text.grid(row=18, column=0, columnspan=2, sticky="ew", padx=8, pady=(0, 6))

        ttk.Button(
            tab_carddefs,
            text="保存",
            command=self.on_carddef_save_clicked,
            style="Accent.TButton" if SV_TTK_AVAILABLE else "TButton",
        ).grid(row=19, column=0, columnspan=2, sticky="ew", padx=8, pady=(4, 10))

        self._carddef_templates = []
        self._carddef_current_template_idx = None
        self._carddef_model_id = None
        self._carddef_deck_id = None
        self._carddef_keys_in_list = []

        ttk.Button(dlg, text="閉じる", command=dlg.withdraw).pack(pady=(6, 10))

    def _open_settings_dialog(self):
        self.settings_dialog.deiconify()
        self.settings_dialog.lift()
        self.settings_dialog.focus_set()

    # --- カード定義タブ(⚙設定、2026-07-27追加) -----------------------------
    # 「単語」タブなどが出力するノートタイプの定義(card_defs.json)を、
    # コード編集無しにここから直接編集できるようにする。対象範囲は
    # card_defs.pyのdocstring参照(2026-07-27時点では「単語」のみ)。
    def refresh_carddef_listbox(self):
        self.carddef_listbox.delete(0, "end")
        self._carddef_keys_in_list = []
        for d in card_defs.list_defs():
            tab_label = self._source_tab_labels.get(d["key"])
            tab_suffix = f'  [{tab_label}タブ]' if tab_label else "  [未接続]"
            self.carddef_listbox.insert("end", f'{d["key"]}: {d.get("label", "")}{tab_suffix}')
            self._carddef_keys_in_list.append(d["key"])

    def on_carddef_selected(self, event=None):
        selection = self.carddef_listbox.curselection()
        if not selection:
            return
        key = self._carddef_keys_in_list[selection[0]]
        card_def = card_defs.get_def(key)
        if card_def:
            self._load_carddef_into_form(card_def)

    def _tab_usage_text_for_key(self, key: str) -> str:
        tab_label = self._source_tab_labels.get(key)
        return f"使用タブ: 「{tab_label}」タブ" if tab_label else "使用タブ: (どのタブにも未接続)"

    def _load_carddef_into_form(self, card_def: dict):
        self.carddef_key_var.set(card_def.get("key", ""))
        self.carddef_tab_usage_label.configure(text=self._tab_usage_text_for_key(card_def.get("key", "")))
        self.carddef_label_var.set(card_def.get("label", ""))
        self.carddef_notetype_var.set(card_def.get("notetype_name", ""))
        self.carddef_deckname_var.set(card_def.get("deck_name", ""))
        self.carddef_dedupkey_var.set(card_def.get("dedup_key", ""))
        self._carddef_model_id = card_def.get("model_id")
        self._carddef_deck_id = card_def.get("deck_id")

        self.carddef_fields_text.delete("1.0", "end")
        lines = [f'{f["anki_name"]} = {f["item_key"]}' for f in card_def.get("fields", [])]
        self.carddef_fields_text.insert("1.0", "\n".join(lines))

        self._carddef_templates = [dict(t) for t in card_def.get("templates", [])]
        self._carddef_current_template_idx = None
        self._refresh_carddef_template_combo()
        if self._carddef_templates:
            self.carddef_template_combo.current(0)
            self._select_carddef_template(0)
        else:
            self.carddef_template_name_var.set("")
            self.carddef_qfmt_text.delete("1.0", "end")
            self.carddef_afmt_text.delete("1.0", "end")

        self.carddef_css_text.delete("1.0", "end")
        self.carddef_css_text.insert("1.0", card_def.get("css", ""))

    def _clear_carddef_form(self):
        self.carddef_key_var.set("")
        self.carddef_tab_usage_label.configure(text="")
        self.carddef_label_var.set("")
        self.carddef_notetype_var.set("")
        self.carddef_deckname_var.set("")
        self.carddef_dedupkey_var.set("")
        self._carddef_model_id = None
        self._carddef_deck_id = None
        self.carddef_fields_text.delete("1.0", "end")
        self._carddef_templates = []
        self._carddef_current_template_idx = None
        self.carddef_template_combo["values"] = []
        self.carddef_template_combo.set("")
        self.carddef_template_name_var.set("")
        self.carddef_qfmt_text.delete("1.0", "end")
        self.carddef_afmt_text.delete("1.0", "end")
        self.carddef_css_text.delete("1.0", "end")

    def _refresh_carddef_template_combo(self):
        names = [f'{i + 1}. {t.get("name", "")}' for i, t in enumerate(self._carddef_templates)]
        self.carddef_template_combo["values"] = names

    def _save_current_template_widgets_to_memory(self):
        idx = self._carddef_current_template_idx
        if idx is None or idx >= len(self._carddef_templates):
            return
        self._carddef_templates[idx] = {
            "name": self.carddef_template_name_var.get(),
            "qfmt": self.carddef_qfmt_text.get("1.0", "end-1c"),
            "afmt": self.carddef_afmt_text.get("1.0", "end-1c"),
        }

    def _select_carddef_template(self, idx: int):
        self._save_current_template_widgets_to_memory()
        self._carddef_current_template_idx = idx
        t = self._carddef_templates[idx]
        self.carddef_template_name_var.set(t.get("name", ""))
        self.carddef_qfmt_text.delete("1.0", "end")
        self.carddef_qfmt_text.insert("1.0", t.get("qfmt", ""))
        self.carddef_afmt_text.delete("1.0", "end")
        self.carddef_afmt_text.insert("1.0", t.get("afmt", ""))

    def on_carddef_template_selected(self, event=None):
        idx = self.carddef_template_combo.current()
        if idx < 0:
            return
        self._select_carddef_template(idx)

    def on_carddef_template_add_clicked(self):
        self._save_current_template_widgets_to_memory()
        self._carddef_templates.append(
            {"name": f"テンプレート{len(self._carddef_templates) + 1}", "qfmt": "", "afmt": ""}
        )
        self._refresh_carddef_template_combo()
        new_idx = len(self._carddef_templates) - 1
        self.carddef_template_combo.current(new_idx)
        self._select_carddef_template(new_idx)

    def on_carddef_template_remove_clicked(self):
        idx = self._carddef_current_template_idx
        if idx is None or not self._carddef_templates:
            return
        if len(self._carddef_templates) <= 1:
            messagebox.showwarning("エラー", "テンプレートは最低1つ必要です。")
            return
        del self._carddef_templates[idx]
        self._carddef_current_template_idx = None  # 削除直後は古いindexを保存させない
        self._refresh_carddef_template_combo()
        new_idx = min(idx, len(self._carddef_templates) - 1)
        self.carddef_template_combo.current(new_idx)
        self._select_carddef_template(new_idx)

    def _generate_new_ids(self):
        """genankiのmodel_id/deck_id用に、現在時刻(ミリ秒)を元にした一意な
        整数IDを2つ生成する(model_id, deck_id)。"""
        base = int(time.time() * 1000)
        return base, base + 1

    def on_carddef_new_clicked(self):
        key = simpledialog.askstring(
            "新規カード定義",
            "内部識別子(キー)を入力してください。\n"
            "既存のタブと連携させたい場合は、そのタブが使っているキー名と"
            "一致させてください(例: 単語タブなら word)。",
            parent=self.settings_dialog,
        )
        if not key:
            return
        key = key.strip()
        if not key:
            return
        if card_defs.get_def(key):
            messagebox.showwarning("エラー", f"キー「{key}」は既に存在します。")
            return
        model_id, deck_id = self._generate_new_ids()
        new_def = {
            "key": key,
            "label": key,
            "notetype_name": key,
            "model_id": model_id,
            "deck_id": deck_id,
            "deck_name": "",
            "dedup_key": "",
            "fields": [],
            "templates": [{"name": "カード 1", "qfmt": "", "afmt": ""}],
            "css": "",
        }
        self._load_carddef_into_form(new_def)
        messagebox.showinfo(
            "新規作成",
            "フォームに入力して「保存」を押すと、カード定義一覧に追加されます。",
        )

    def on_carddef_delete_clicked(self):
        key = self.carddef_key_var.get().strip()
        if not key:
            messagebox.showinfo("該当なし", "削除する定義を一覧から選択してください。")
            return
        if not messagebox.askyesno(
            "確認",
            f"カード定義「{key}」を削除します。よろしいですか？(この操作は取り消せません)",
        ):
            return
        card_defs.delete_def(key)
        self.refresh_carddef_listbox()
        self._clear_carddef_form()
        self.log(f"カード定義「{key}」を削除しました。")

    def _ask_pick_from_list(self, title: str, options: list):
        """optionsから1つ選ばせる簡易モーダルダイアログ。選ばれなければNone。"""
        win = tk.Toplevel(self.settings_dialog)
        win.title(title)
        win.geometry("360x280")
        win.transient(self.settings_dialog)
        win.grab_set()
        ttk.Label(win, text=title, wraplength=340, justify="left").pack(
            padx=10, pady=(10, 4), anchor="w"
        )
        listbox = tk.Listbox(win, exportselection=False)
        for opt in options:
            listbox.insert("end", opt)
        listbox.pack(fill="both", expand=True, padx=10, pady=(0, 8))
        listbox.selection_set(0)

        result = {"value": None}

        def on_ok():
            sel = listbox.curselection()
            if sel:
                result["value"] = options[sel[0]]
            win.destroy()

        btn_row = ttk.Frame(win)
        btn_row.pack(fill="x", padx=10, pady=(0, 10))
        ttk.Button(btn_row, text="OK", command=on_ok).pack(side="right")
        ttk.Button(btn_row, text="キャンセル", command=win.destroy).pack(side="right", padx=(0, 6))

        win.wait_window()
        return result["value"]

    def on_carddef_import_apkg_clicked(self):
        """apkgを読み込み、含まれるノートタイプ(実際にノートがあるもののみ)から
        フィールド名・カードテンプレート・CSS・デッキ名を自動抽出してフォームに
        反映する(片桐が今回「単語」ノートタイプを確認した際に手動で行った作業を
        GUIから直接できるようにしたもの)。"""
        path = filedialog.askopenfilename(
            title="apkgファイルを選択(カード定義の読み込み元)",
            filetypes=[("Anki Package", "*.apkg")],
        )
        if not path:
            return
        try:
            work_col_path = os.path.join(
                os.environ.get("TEMP", tempfile.gettempdir()), "_anki_tts_gui_carddef_inspect.anki2"
            )
            col = tts_core.load_collection(path, work_col_path)
            candidates = []
            for nt in col.models.all_names_and_ids():
                model = col.models.get(nt.id)
                note_ids = col.find_notes(f'note:"{nt.name}"')
                if not note_ids:
                    continue
                candidates.append((nt.name, model, note_ids))

            if not candidates:
                col.close()
                messagebox.showwarning(
                    "該当なし", "このapkgにはノートが含まれるノートタイプがありませんでした。"
                )
                return

            if len(candidates) == 1:
                chosen_name, chosen_model, chosen_note_ids = candidates[0]
            else:
                chosen_name = self._ask_pick_from_list(
                    "複数のノートタイプが見つかりました。読み込むものを選んでください。",
                    [name for name, _, _ in candidates],
                )
                if not chosen_name:
                    col.close()
                    return
                chosen_model, chosen_note_ids = next(
                    (m, nids) for name, m, nids in candidates if name == chosen_name
                )

            deck_name = ""
            n = col.get_note(chosen_note_ids[0])
            card_ids = n.card_ids()
            if card_ids:
                c = col.get_card(card_ids[0])
                deck_name = col.decks.get(c.did)["name"]
            col.close()

            key_default = re.sub(r"[^0-9A-Za-z]+", "_", chosen_name).strip("_").lower() or "new"
            key = simpledialog.askstring(
                "内部識別子(キー)",
                f"「{chosen_name}」を、このソフト内でどのキー名で扱いますか？\n"
                "既存のタブと連携させたい場合は、そのタブが使っているキー名と"
                "一致させてください(例: 単語タブなら word)。",
                initialvalue=key_default,
                parent=self.settings_dialog,
            )
            if not key:
                return
            key = key.strip()

            existing = card_defs.get_def(key)
            existing_item_keys = (
                {f["anki_name"]: f["item_key"] for f in existing["fields"]} if existing else {}
            )

            def _default_item_key(name):
                if name in existing_item_keys:
                    return existing_item_keys[name]
                return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

            model_id, deck_id = self._generate_new_ids()
            new_def = {
                "key": key,
                "label": existing["label"] if existing else chosen_name,
                "notetype_name": chosen_name,
                "model_id": chosen_model["id"],
                "deck_id": existing["deck_id"] if existing else deck_id,
                "deck_name": deck_name or (existing["deck_name"] if existing else ""),
                "dedup_key": existing["dedup_key"] if existing else "",
                "fields": [
                    {"anki_name": f["name"], "item_key": _default_item_key(f["name"])}
                    for f in chosen_model["flds"]
                ],
                "templates": [
                    {"name": t["name"], "qfmt": t["qfmt"], "afmt": t["afmt"]}
                    for t in chosen_model["tmpls"]
                ],
                "css": chosen_model["css"],
            }
            self._load_carddef_into_form(new_def)
            self.log(f"apkgから「{chosen_name}」のノートタイプ定義を読み込みました(キー: {key})。")
            messagebox.showinfo(
                "読み込み完了",
                f"「{chosen_name}」を読み込みました。\n"
                "フィールド一覧の「= 内部項目名」の部分は、AIが生成するデータの"
                "キー名と一致させる必要があるため、必要に応じて編集してから"
                "「保存」を押してください。",
            )
        except Exception as e:  # noqa: BLE001
            self.log(f"apkgからのカード定義読み込みに失敗しました: {e}")
            messagebox.showerror("エラー", f"apkgからのカード定義読み込みに失敗しました:\n{e}")

    def on_carddef_save_clicked(self):
        key = self.carddef_key_var.get().strip()
        if not key:
            messagebox.showwarning(
                "入力不足",
                "キー(内部識別子)が設定されていません。「新規作成」または"
                "「apkgから読み込む」から始めてください。",
            )
            return

        self._save_current_template_widgets_to_memory()

        fields = []
        for line in self.carddef_fields_text.get("1.0", "end").splitlines():
            line = line.strip()
            if not line:
                continue
            if "=" not in line:
                messagebox.showerror(
                    "入力エラー",
                    "フィールド一覧の書式が不正です"
                    "(「Ankiフィールド名 = 内部項目名」の形式で入力してください):\n"
                    f"{line}",
                )
                return
            anki_name, item_key = line.split("=", 1)
            fields.append({"anki_name": anki_name.strip(), "item_key": item_key.strip()})
        if not fields:
            messagebox.showerror("入力エラー", "フィールドを1つ以上入力してください。")
            return
        if not self._carddef_templates:
            messagebox.showerror("入力エラー", "テンプレートを1つ以上作成してください。")
            return

        new_def = {
            "key": key,
            "label": self.carddef_label_var.get().strip() or key,
            "notetype_name": self.carddef_notetype_var.get().strip(),
            "model_id": self._carddef_model_id or self._generate_new_ids()[0],
            "deck_id": self._carddef_deck_id or self._generate_new_ids()[1],
            "deck_name": self.carddef_deckname_var.get().strip(),
            "dedup_key": self.carddef_dedupkey_var.get().strip(),
            "fields": fields,
            "templates": self._carddef_templates,
            "css": self.carddef_css_text.get("1.0", "end-1c"),
        }
        card_defs.upsert_def(new_def)
        self.refresh_carddef_listbox()
        self.log(f"カード定義「{key}」を保存しました。")
        messagebox.showinfo("保存しました", f"カード定義「{key}」を保存しました。")

    def on_auto_gain_clicked(self):
        """0dBFS(音割れ)を超えない範囲でできるだけ音量が大きくなるよう、
        音量ゲインを自動計算してself.volume_gain_db_varにセットする
        (`tts_core.find_safe_volume_gain_db`)。実際にGoogle Cloud TTSへの
        テスト合成を複数回行うため、API呼び出しが必要(数秒かかることがある)。"""
        if not self.api_key_var.get():
            messagebox.showwarning("入力不足", "先にGoogle Cloud APIキーを入力してください。")
            return
        voice = self.voice_var.get().strip()
        lang = self.lang_var.get().strip()
        if not voice:
            messagebox.showwarning("入力不足", "音声名(voice)を選択してください。")
            return

        api_key = self.api_key_var.get()
        gap_seconds = self.sentence_gap_var.get()

        self.auto_gain_btn.configure(state="disabled")
        self.test_play_status_label.configure(text="音量を自動調整中...")

        def worker():
            try:
                gain_db = tts_core.find_safe_volume_gain_db(voice, lang, api_key, gap_seconds)
                self.log(f"音量ゲインを自動調整しました: {self._format_gain_db(gain_db)}")

                def apply():
                    self.volume_gain_db_var.set(gain_db)
                    self.auto_gain_btn.configure(state="normal")
                    self.test_play_status_label.configure(
                        text=f"自動調整完了: {self._format_gain_db(gain_db)}"
                    )

                self.after(0, apply)
            except Exception as e:  # noqa: BLE001
                self.log(f"音量の自動調整に失敗しました: {e}")

                def on_error():
                    self.auto_gain_btn.configure(state="normal")
                    self.test_play_status_label.configure(text=f"エラー: {e}")

                self.after(0, on_error)

        threading.Thread(target=worker, daemon=True).start()

    # --- テスト再生(⚙設定「TTS」タブ、2026-07-27追加) ---------------------
    @staticmethod
    def _format_gain_db(value: float) -> str:
        return f"{value:+.1f} dB"

    def _on_volume_gain_display_changed(self, *_args):
        label = getattr(self, "volume_gain_value_label", None)
        if label is not None:
            label.configure(text=self._format_gain_db(self.volume_gain_db_var.get()))

    def on_test_play_clicked(self):
        """設定中の音声・言語・文間隔・音量ゲインで短い2文サンプルを合成し、
        再生しながら波形(振幅の推移を事前計算したもの)を経過時間に合わせて
        アニメーション表示する。再生自体は標準ライブラリのwinsoundを使う
        (アプリ内で再生開始時刻を把握できる必要があるため、他のプレビュー
        機能で使っているos.startfileでの外部プレイヤー起動には出来ない)。"""
        if not WINSOUND_AVAILABLE:
            return
        if not self.api_key_var.get():
            messagebox.showwarning("入力不足", "先にGoogle Cloud APIキーを入力してください。")
            return
        voice = self.voice_var.get().strip()
        lang = self.lang_var.get().strip()
        if not voice:
            messagebox.showwarning("入力不足", "音声名(voice)を選択してください。")
            return

        api_key = self.api_key_var.get()
        gap_seconds = self.sentence_gap_var.get()
        volume_gain_db = self.volume_gain_db_var.get()

        self._stop_test_waveform_animation()
        try:
            winsound.PlaySound(None, winsound.SND_PURGE)
        except Exception:  # noqa: BLE001
            pass
        self._draw_test_waveform([], played_ratio=0.0, clipped=False)
        self.test_play_btn.configure(state="disabled")
        self.test_play_status_label.configure(text="生成中...")

        def worker():
            try:
                wav_bytes = tts_core.synthesize_test_sample_wav(
                    voice, lang, api_key, gap_seconds, volume_gain_db
                )
                tmp_path = os.path.join(tempfile.gettempdir(), "anki_tts_test_sample.wav")
                with open(tmp_path, "wb") as f:
                    f.write(wav_bytes)
                waveform = tts_core.compute_waveform_minmax(wav_bytes)
                clipped = tts_core.is_clipped(wav_bytes)
                duration = tts_core.wav_duration_seconds(wav_bytes)
                self.after(
                    0, lambda: self._start_test_playback(tmp_path, waveform, duration, clipped)
                )
            except Exception as e:  # noqa: BLE001
                self.log(f"テスト再生用の音声生成に失敗しました: {e}")
                self.after(0, lambda: self._finish_test_playback_ui(error=str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def _start_test_playback(self, wav_path: str, waveform: list, duration: float, clipped: bool):
        self.test_play_status_label.configure(
            text="再生中... ⚠ 0dBを超えています(音割れの可能性)" if clipped else "再生中..."
        )
        try:
            winsound.PlaySound(wav_path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        except Exception as e:  # noqa: BLE001
            self.log(f"テスト音声の再生に失敗しました: {e}")
            self._finish_test_playback_ui(error=str(e))
            return
        self._test_playback_start = time.monotonic()
        self._test_playback_waveform = waveform
        self._test_playback_duration = max(duration, 0.05)
        self._test_playback_clipped = clipped
        self._animate_test_waveform()

    def _animate_test_waveform(self):
        elapsed = time.monotonic() - self._test_playback_start
        ratio = min(1.0, elapsed / self._test_playback_duration)
        self._draw_test_waveform(
            self._test_playback_waveform, played_ratio=ratio, clipped=self._test_playback_clipped
        )
        if ratio >= 1.0:
            self._finish_test_playback_ui(clipped=self._test_playback_clipped)
            return
        self._test_waveform_after_id = self.after(40, self._animate_test_waveform)

    def _stop_test_waveform_animation(self):
        after_id = getattr(self, "_test_waveform_after_id", None)
        if after_id is not None:
            try:
                self.after_cancel(after_id)
            except Exception:  # noqa: BLE001
                pass
            self._test_waveform_after_id = None

    def _finish_test_playback_ui(self, error=None, clipped=False):
        self._stop_test_waveform_animation()
        self.test_play_btn.configure(state="normal")
        if error:
            self.test_play_status_label.configure(text=f"エラー: {error}")
        elif clipped:
            self.test_play_status_label.configure(text="再生完了 ⚠ 0dBを超えています(音割れの可能性)")
        else:
            self.test_play_status_label.configure(text="再生完了")

    def _draw_test_waveform(self, waveform: list, played_ratio: float, clipped: bool = False):
        """事前計算した波形データ(waveform、各バケットの[最小値,最大値]を
        -1.0〜+1.0で持つ)を、Canvasの中心線(0点)を挟んで上下に振れる形で
        描画する(2026-07-27、以前の棒グラフ表示から一般的な音声波形
        ビューアと同じ見た目に変更)。played_ratioより手前をアクセントカラー
        にすることで、再生位置が左から右へ動く波形として見える(リアルタイム
        の音声解析は行わない、事前計算データ+経過時間の組み合わせによる
        可視化)。clipped=Trueの場合は警告色で描画し、0dBを超えたことを
        視覚的にも示す。"""
        canvas = getattr(self, "test_waveform_canvas", None)
        if canvas is None:
            return
        canvas.delete("all")
        if not waveform:
            return
        w = int(canvas["width"])
        h = int(canvas["height"])
        center_y = h / 2
        n = len(waveform)
        bar_w = w / n
        played_bars = int(n * played_ratio)
        unplayed_color = "#666666" if self.theme_var.get() == "dark" else "#cccccc"
        played_color = "#d9534f" if clipped else "#5c85cf"

        canvas.create_line(0, center_y, w, center_y, fill=unplayed_color)

        for i, (mn, mx) in enumerate(waveform):
            x0 = i * bar_w + 1
            x1 = (i + 1) * bar_w - 1
            y0 = center_y - mx * (h / 2 - 2)
            y1 = center_y - mn * (h / 2 - 2)
            if y1 - y0 < 1:
                y0 -= 0.5
                y1 += 0.5
            color = played_color if i < played_bars else unplayed_color
            canvas.create_rectangle(x0, y0, x1, y1, fill=color, outline="")

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
        paths = self.tk.splitlist(event.data)
        if not paths:
            return
        path = paths[0]
        if not path.lower().endswith(".apkg"):
            messagebox.showwarning("ファイル形式エラー", ".apkg ファイルをドロップしてください。")
            return
        self._set_apkg_path(path)

    def _set_apkg_path(self, path: str):
        self._current_row_map = None  # 手動で別のapkgに切り替えたら、メモリ上のrow_mapは破棄する
        self.apkg_path.set(path)
        default_out = os.path.splitext(path)[0] + "_tts追加.apkg"
        self.output_path.set(default_out)

        default_row_map = os.path.splitext(path)[0] + ".row_map.json"
        if os.path.exists(default_row_map):
            self.row_map_path.set(default_row_map)
            self.log(f"row_map.jsonを自動検出しました: {default_row_map}")
        else:
            self.row_map_path.set("")

        self.load_fields(path)

    def on_browse_output(self):
        path = filedialog.asksaveasfilename(
            title="出力先を指定", defaultextension=".apkg", filetypes=[("Anki Package", "*.apkg")]
        )
        if path:
            self.output_path.set(path)

    def on_browse_row_map(self):
        path = filedialog.askopenfilename(
            title="row_map.jsonを選択", filetypes=[("JSON", "*.json")]
        )
        if path:
            self.row_map_path.set(path)

    def on_fetch_from_sheet_clicked(self):
        spreadsheet_id = self.sheets_spreadsheet_id_var.get().strip()
        sheet_name = self.sheets_sheet_name_var.get().strip()
        credentials_path = os.environ.get("SHEETS_WRITER_CREDENTIALS", "")

        if not spreadsheet_id or not sheet_name:
            messagebox.showwarning("入力不足", "スプレッドシートIDとシート(タブ)名を入力してください。")
            return
        if not credentials_path:
            messagebox.showwarning(
                "認証情報未設定",
                "環境変数 SHEETS_WRITER_CREDENTIALS が設定されていません。\n"
                "サービスアカウントのJSONキーのパスを設定してください。",
            )
            return

        self.fetch_sheet_btn.configure(state="disabled", text="読み込み中...")

        def worker():
            try:
                self.log("スプレッドシートから「Anki出力済み」が空の行を読み込み中...")
                rows = sheets_reader.fetch_pending_rows(spreadsheet_id, sheet_name, credentials_path)
                self.log(f"未出力の行: {len(rows)} 件")
                if not rows:
                    messagebox.showinfo(
                        "該当なし", "「Anki出力済み」列が空の行が見つかりませんでした。"
                    )
                    return

                deck, row_map = deck_builder.build_deck_and_row_map(rows)
                excluded = len(rows) - len(row_map)
                if excluded:
                    self.log(
                        f"(カテゴリ「誤りなし」・ID重複などの理由で {excluded} 件は"
                        "デッキから除外されました)"
                    )

                temp_path = os.path.join(
                    tempfile.gettempdir(),
                    f"sheet_deck_{datetime.datetime.now():%Y%m%d_%H%M%S}.apkg",
                )
                deck_builder.write_deck_to_apkg(deck, temp_path)
                self.log(f"デッキを生成しました: {temp_path} ({len(row_map)} ノート)")

                self._set_apkg_path(temp_path)
                self._current_row_map = row_map
                self.sheets_update_var.set(True)
                self.log("生成したデッキを①以降に読み込みました。②③を確認して生成を実行してください(TTS設定は⚙から確認できます)。")

                self._generate_shuujuku_candidates_from_rows(rows, row_map)
            except Exception as e:  # noqa: BLE001
                self.log(
                    f"スプレッドシートからの読み込みに失敗しました"
                    f"(使用した認証情報パス: {credentials_path!r}): {e}"
                )
                messagebox.showerror("エラー", f"スプレッドシートからの読み込みに失敗しました:\n{e}")
            finally:
                self.fetch_sheet_btn.configure(state="normal", text=self.fetch_sheet_btn_label)

        threading.Thread(target=worker, daemon=True).start()

    def _generate_shuujuku_candidates_from_rows(self, rows: list, row_map: dict):
        """DailyConversationの読み込み(on_fetch_from_sheet_clicked)後に、
        実際にデッキへ採用された行(row_mapに含まれる行)ごとにGemini APIを
        自動で呼び、習熟用ストックへ候補を追加する(2026-07-24時点でユーザーが
        「自動・毎回」を選択したための仕様)。APIキー未設定なら黙ってスキップする。"""
        api_key = self.gemini_api_key_var.get().strip()
        if not api_key:
            self.log(
                "(Gemini APIキーが未設定のため、習熟用候補の自動生成はスキップしました)"
            )
            return

        model = self.gemini_model_var.get().strip()
        used_ids = set(row_map.values())
        target_rows = [r for r in rows if r.get("id") in used_ids]
        if not target_rows:
            # ここで無言でreturnすると、デッキ生成後にストックが増えない理由が
            # 全く分からなくなる(2026-07-27にユーザーから報告された挙動)。
            # process_sheet_rows()が「誤りなし」カテゴリ・ID重複の行をデッキから
            # 除外する仕様(build_grammar_dailyconv_v1_final.py参照)のため、
            # 取得した行が全てそれに該当すると習熟用候補も0件になる。
            self.log(
                "習熟用候補の生成対象は0件でした"
                "(取得した行はすべて「誤りなし」またはID重複などの理由で"
                "デッキから除外されたため、習熟用候補も生成されません)。"
            )
            return

        self.log(f"習熟用候補をAIで生成中(対象 {len(target_rows)} 件)...")
        items = []
        failed = 0
        for i, row in enumerate(target_rows, start=1):
            try:
                item = gemini_client.generate_shuujuku_item_from_row(row, api_key, model)
                items.append(item)
            except gemini_client.GeminiClientError as e:
                failed += 1
                self.log(f"  行{i}/{len(target_rows)}(id={row.get('id')}): 生成失敗 - {e}")

        added = shuujuku_stock.add_pending_items(items)
        self.log(f"習熟用ストックに {added} 件追加しました(生成成功 {len(items)}/{len(target_rows)} 件)。")
        self.refresh_shuujuku_stock_view()
        if added:
            messagebox.showinfo(
                "習熟用ストックに追加",
                f"習熟用ストックに {added} 件追加しました。\n"
                "「習熟用(音読)」タブで確認できます。",
            )
        elif failed == len(target_rows):
            # 全件Gemini呼び出し失敗はログだけだと見落としやすいため、ログを
            # 見ていなくても気付けるようポップアップでも知らせる。
            messagebox.showwarning(
                "習熟用候補の生成に失敗",
                f"対象 {len(target_rows)} 件すべてでAIによる習熟用候補の生成に"
                "失敗しました。\n詳細はログを確認してください。",
            )
        elif items:
            self.log(
                "(生成には成功しましたが、すべて既存のストックまたは出力済みと"
                "重複していたため追加されませんでした)"
            )

    # --- 入力元タブの切り替え(固定ヘッダーのボタン) -----------------------
    def _switch_source_tab(self, key: str):
        self.source_tab_var.set(key)
        for k, frame in self._source_tab_frames.items():
            if k == key:
                frame.pack(fill="x")
            else:
                frame.pack_forget()
        for k, btn in self._source_tab_buttons.items():
            btn.configure(style="Accent.TButton" if (k == key and SV_TTK_AVAILABLE) else "TButton")

    # --- 習熟用(音読)タブ -------------------------------------------------
    def refresh_shuujuku_stock_view(self):
        pending = shuujuku_stock.get_pending()
        self.shuujuku_count_label.configure(text=f"現在のストック: {len(pending)} 件")
        self.shuujuku_listbox.delete(0, "end")
        for item in pending:
            label = item.get("pattern") or "(pattern未設定)"
            source = item.get("source_label") or ""
            self.shuujuku_listbox.insert("end", f"{label}  {source}")

        # タブボタンにストック件数のバッジを表示する
        base_label = self._source_tab_labels["shuujuku"]
        badge_label = f"{base_label} ({len(pending)})" if pending else base_label
        self._source_tab_buttons["shuujuku"].configure(text=badge_label)

    def on_shuujuku_item_selected(self, event=None):
        """ストック一覧で選択した候補の内容を、右のプレビューペインに表示する。"""
        selection = self.shuujuku_listbox.curselection()
        if not selection:
            return
        pending = shuujuku_stock.get_pending()
        idx = selection[0]
        if idx >= len(pending):
            return
        self._show_shuujuku_item_preview(pending[idx])

    def _show_shuujuku_item_preview(self, item: dict):
        pv = self.preview_text
        pv.configure(state="normal")
        pv.delete("1.0", "end")
        self._render_shuujuku_fields_to_pane(item)
        pv.configure(state="disabled")
        self._preview_source = {"kind": "shuujuku", "item": item}

    def _render_shuujuku_fields_to_pane(self, parsed: dict):
        """Pattern/Meaning/Examples/Explanation/Sourceの構造化データを右の
        プレビューペインに書き込む。ストック中のitem dict、
        tts_core.parse_shuujuku_content_html()の戻り値、どちらの形式でも可
        (キー名を揃えてある)。呼び出し側でconfigure(state="normal")/削除・
        configure(state="disabled")を行うこと。"""
        pv = self.preview_text

        def field(name, text):
            pv.insert("end", name, "fieldname")
            pv.insert("end", "\n")
            if text:
                pv.insert("end", str(text) + "\n")
            else:
                pv.insert("end", "(空欄)\n", "empty")

        field("Pattern", parsed.get("pattern"))
        field("Meaning", parsed.get("meaning"))

        pv.insert("end", "Examples", "fieldname")
        pv.insert("end", "\n")
        examples = parsed.get("examples") or []
        if examples:
            for ex in examples:
                en, jp = ex[0], ex[1]
                pv.insert("end", f"{en}\n  {jp}\n")
        else:
            pv.insert("end", "(空欄)\n", "empty")

        field("Explanation", parsed.get("expl"))
        field("Source", parsed.get("source_label"))

    def on_clear_shuujuku_stock_clicked(self):
        pending = shuujuku_stock.get_pending()
        if not pending:
            messagebox.showinfo("該当なし", "ストックは空です。")
            return
        if not messagebox.askyesno(
            "確認",
            f"ストック {len(pending)} 件をすべて破棄します(出力済みにはなりません)。\n"
            "よろしいですか？(この操作は取り消せません)",
        ):
            return
        count = shuujuku_stock.clear_pending()
        self.log(f"習熟用ストックを {count} 件破棄しました。")
        self.refresh_shuujuku_stock_view()

    def on_export_shuujuku_stock_clicked(self):
        if not SHUUJUKU_AVAILABLE:
            messagebox.showerror(
                "エラー",
                "build_shuujuku_v1.py が見つからないか、genankiがインストールされていません。",
            )
            return
        pending = shuujuku_stock.get_pending()
        if not pending:
            messagebox.showinfo("該当なし", "ストックは空です。")
            return
        if not messagebox.askyesno(
            "確認", f"ストック {len(pending)} 件をまとめて習熟用デッキとして出力します。よろしいですか？"
        ):
            return
        try:
            deck = build_shuujuku_v1.build_deck(pending)
            temp_path = os.path.join(
                tempfile.gettempdir(),
                f"shuujuku_deck_{datetime.datetime.now():%Y%m%d_%H%M%S}.apkg",
            )
            deck.write_to_file(temp_path)
            shuujuku_stock.mark_exported(pending)
            self.log(f"習熟用デッキを生成しました: {temp_path} ({len(pending)} ノート)")
            self._set_apkg_path(temp_path)
            self.sheets_update_var.set(False)  # 習熟用はスプレッドシート書き戻し対象外
            self.refresh_shuujuku_stock_view()
            self.log("生成したデッキを①以降に読み込みました。②③を確認して生成を実行してください(TTS設定は⚙から確認できます)。")
        except Exception as e:  # noqa: BLE001
            self.log(f"習熟用デッキの生成に失敗しました: {e}")
            messagebox.showerror("エラー", f"習熟用デッキの生成に失敗しました:\n{e}")

    # --- 単語タブ(2026-07-27追加) ------------------------------------
    # 「習熟用(音読)」とは無関係の独立機能。ここで生成したitemは必ず
    # word_stock.py側だけで扱い、shuujuku_stock.pyには一切渡さないこと。
    def refresh_word_stock_view(self):
        pending = word_stock.get_pending()
        self.word_count_label.configure(text=f"現在のストック: {len(pending)} 件")
        self.word_listbox.delete(0, "end")
        for item in pending:
            label = item.get("word") or "(単語未設定)"
            meaning = item.get("meaning") or ""
            self.word_listbox.insert("end", f"{label}  {meaning}")

        base_label = self._source_tab_labels["word"]
        badge_label = f"{base_label} ({len(pending)})" if pending else base_label
        self._source_tab_buttons["word"].configure(text=badge_label)

    def on_word_item_selected(self, event=None):
        """ストック一覧で選択した候補の内容を、右のプレビューペインに表示する。"""
        selection = self.word_listbox.curselection()
        if not selection:
            return
        pending = word_stock.get_pending()
        idx = selection[0]
        if idx >= len(pending):
            return
        self._show_word_item_preview(pending[idx])

    def _show_word_item_preview(self, item: dict):
        pv = self.preview_text
        pv.configure(state="normal")
        pv.delete("1.0", "end")
        self._render_word_fields_to_pane(item)
        pv.configure(state="disabled")
        self._preview_source = {"kind": "word", "item": item}

    def _render_word_fields_to_pane(self, item: dict):
        """Word/Reading/POS/Meaning/Example/ExampleJA/ExampleBlank/Noteの
        各フィールドを右のプレビューペインに書き込む。「Vocab (単語 v1)」の
        実フィールドがそのまま独立した値として存在するため、習熟用のような
        HTMLからの逆抽出(parse_shuujuku_content_html相当)は不要。"""
        pv = self.preview_text

        def field(name, text):
            pv.insert("end", name, "fieldname")
            pv.insert("end", "\n")
            if text:
                pv.insert("end", str(text) + "\n")
            else:
                pv.insert("end", "(空欄)\n", "empty")

        field("Word", item.get("word"))
        field("Reading", item.get("reading"))
        field("POS", item.get("pos"))
        field("Meaning", item.get("meaning"))
        field("Example", item.get("example"))
        field("ExampleJA", item.get("example_ja"))
        field("ExampleBlank", item.get("example_blank"))
        field("Note", item.get("note"))

    def on_clear_word_stock_clicked(self):
        pending = word_stock.get_pending()
        if not pending:
            messagebox.showinfo("該当なし", "ストックは空です。")
            return
        if not messagebox.askyesno(
            "確認",
            f"ストック {len(pending)} 件をすべて破棄します(出力済みにはなりません)。\n"
            "よろしいですか？(この操作は取り消せません)",
        ):
            return
        count = word_stock.clear_pending()
        self.log(f"単語ストックを {count} 件破棄しました。")
        self.refresh_word_stock_view()

    def _word_deck_name_for_hint(self) -> str:
        card_def = card_defs.get_def("word")
        return card_def["deck_name"] if card_def else "不明"

    def on_export_word_stock_clicked(self):
        if not card_def_builder.GENANKI_AVAILABLE:
            messagebox.showerror("エラー", "genanki がインストールされていません。")
            return
        card_def = card_defs.get_def("word")
        if not card_def:
            messagebox.showerror(
                "エラー",
                "「単語」のカード定義が見つかりません。⚙設定の「カード定義」タブで作成してください。",
            )
            return
        pending = word_stock.get_pending()
        if not pending:
            messagebox.showinfo("該当なし", "ストックは空です。")
            return
        if not messagebox.askyesno(
            "確認", f"ストック {len(pending)} 件をまとめて単語カードとして出力します。よろしいですか？"
        ):
            return
        try:
            deck = card_def_builder.build_deck_from_def(card_def, pending)
            temp_path = os.path.join(
                tempfile.gettempdir(),
                f"word_deck_{datetime.datetime.now():%Y%m%d_%H%M%S}.apkg",
            )
            deck.write_to_file(temp_path)
            word_stock.mark_exported(pending)
            self.log(f"単語デッキを生成しました: {temp_path} ({len(pending)} ノート)")
            self._set_apkg_path(temp_path)
            self.sheets_update_var.set(False)  # 単語はスプレッドシート書き戻し対象外
            self.refresh_word_stock_view()
            self.log("生成したデッキを①以降に読み込みました。②③を確認して生成を実行してください(TTS設定は⚙から確認できます)。")
        except Exception as e:  # noqa: BLE001
            self.log(f"単語デッキの生成に失敗しました: {e}")
            messagebox.showerror("エラー", f"単語デッキの生成に失敗しました:\n{e}")

    @staticmethod
    def _parse_word_pairs(text: str) -> list:
        """「単語 | 文脈」形式の複数行テキストを(word, context)のタプルの
        リストにパースする。文脈は省略可(区切り文字「|」が無ければ空文字)。
        文脈は完全な英文である必要はない(句動詞・単語の組み合わせも想定)。
        空行はスキップする。"""
        pairs = []
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            if "|" in line:
                word_part, context_part = line.split("|", 1)
            else:
                word_part, context_part = line, ""
            word = word_part.strip()
            context = context_part.strip()
            if word:
                pairs.append((word, context))
        return pairs

    def on_word_generate_clicked(self):
        pairs = self._parse_word_pairs(self.word_pairs_text.get("1.0", "end"))
        if not pairs:
            messagebox.showwarning(
                "入力不足", "単語を1件以上入力してください(1行に1件、「単語 | 文脈」の形式)。"
            )
            return
        api_key = self.gemini_api_key_var.get().strip()
        if not api_key:
            messagebox.showwarning("入力不足", "Gemini APIキーを入力してください(⚙設定)。")
            return
        model = self.gemini_model_var.get().strip()

        self.word_generate_btn.configure(state="disabled")

        def worker():
            items = []
            failed = 0
            self.log(f"単語カードをAIで生成中(対象 {len(pairs)} 件)...")
            for i, (word, context_sentence) in enumerate(pairs, start=1):
                try:
                    item = gemini_client.generate_vocab_card_from_word(
                        word, context_sentence, api_key, model
                    )
                    items.append(item)
                except gemini_client.GeminiClientError as e:
                    failed += 1
                    self.log(f"  {i}/{len(pairs)}(単語={word}): 生成失敗 - {e}")

            added = word_stock.add_pending_items(items)
            self.log(f"単語ストックに {added} 件追加しました(生成成功 {len(items)}/{len(pairs)} 件)。")

            def finish():
                self.refresh_word_stock_view()
                # 全件成功した場合だけ入力欄をクリアする(一部失敗時は、どの行が
                # 失敗したか片桐が見て判断できるよう入力内容を残しておく)。
                if added == len(pairs):
                    self.word_pairs_text.delete("1.0", "end")
                self.word_generate_btn.configure(state="normal")
                if failed == len(pairs):
                    messagebox.showwarning(
                        "単語カードの生成に失敗",
                        f"対象 {len(pairs)} 件すべてでAIによる単語カード生成に"
                        "失敗しました。\n詳細はログを確認してください。",
                    )

            self.after(0, finish)

        threading.Thread(target=worker, daemon=True).start()

    # --- AIに質問タブ -------------------------------------------------
    def on_ai_ask_clicked(self):
        question = self.ai_ask_text.get("1.0", "end").strip()
        if not question:
            messagebox.showwarning("入力不足", "質問・お題を入力してください。")
            return
        api_key = self.gemini_api_key_var.get().strip()
        if not api_key:
            messagebox.showwarning("入力不足", "Gemini APIキーを入力してください。")
            return
        model = self.gemini_model_var.get().strip()

        self.ai_ask_generate_btn.configure(state="disabled")

        def worker():
            try:
                self.log(f"AIに質問中: {question[:50]}...")
                item = gemini_client.answer_question_as_shuujuku_item(question, api_key, model)
                added = shuujuku_stock.add_pending_items([item])
                if added:
                    self.log(f"習熟用ストックに追加しました: {item['pattern']}")
                else:
                    self.log("(同じ質問が既にストックまたは出力済みのため、追加されませんでした)")
                self.refresh_shuujuku_stock_view()
            except gemini_client.GeminiClientError as e:
                self.log(f"AIへの質問に失敗しました: {e}")
                messagebox.showerror("エラー", f"AIへの質問に失敗しました:\n{e}")
            finally:
                self.ai_ask_generate_btn.configure(state="normal")

        threading.Thread(target=worker, daemon=True).start()

    def on_fetch_gemini_models(self, silent=False):
        """Gemini APIから、generateContentに対応しているモデルの一覧を取得し、
        モデル名コンボボックスに反映する(音声一覧取得のGemini版)。"""
        api_key = self.gemini_api_key_var.get().strip()
        if not api_key:
            if not silent:
                messagebox.showwarning("入力不足", "先にGemini APIキーを入力してください。")
            return

        def worker():
            try:
                names = gemini_client.list_gemini_models(api_key)
                self.gemini_models_cache = names
                self.gemini_model_combo["values"] = names
                if names and self.gemini_model_var.get() not in names:
                    self.gemini_model_var.set(names[0])
                self._save_current_config()
                self.log(f"Geminiモデル一覧を {len(names)} 件取得しました。")
            except gemini_client.GeminiClientError as e:
                self.log(f"Geminiモデル一覧の取得に失敗しました: {e}")
                if not silent:
                    messagebox.showerror("エラー", f"Geminiモデル一覧の取得に失敗しました:\n{e}")

        threading.Thread(target=worker, daemon=True).start()

    MAX_LIST_ROWS = 500  # 一覧表示の上限件数(TTS生成自体には影響しない)

    def load_fields(self, apkg_path: str):
        """apkgを読み込み、ノートタイプ・フィールド一覧・全ノートの中身を取得する。"""
        try:
            self.log(f"読み込み中: {apkg_path}")
            work_col_path = os.path.join(
                os.environ.get("TEMP", tempfile.gettempdir()), "_anki_tts_gui_inspect.anki2"
            )
            col = tts_core.load_collection(apkg_path, work_col_path)

            self.notetype_fields = {}
            self.notetype_notes = {}
            self.notetype_total_counts = {}
            self.notetype_styling = {}
            for nt in col.models.all_names_and_ids():
                model = col.models.get(nt.id)
                note_ids = col.find_notes(f'note:"{nt.name}"')
                if not note_ids:
                    continue
                self.notetype_fields[nt.name] = [f["name"] for f in model["flds"]]
                self.notetype_total_counts[nt.name] = len(note_ids)
                tmpls = model["tmpls"]
                self.notetype_styling[nt.name] = {
                    "qfmt": tmpls[0]["qfmt"] if tmpls else "",
                    "afmt": tmpls[0]["afmt"] if tmpls else "",
                    "css": model["css"],
                }
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
            # TTSで読み上げる対象は「Answer」フィールド(正解文)がある場合は
            # それを既定にする(Grammar DailyConversationノートタイプでの
            # 主な使い方に合わせたデフォルト)。無ければ先頭フィールド。
            default_field = "Answer" if "Answer" in fields else fields[0]
            self.source_field_var.set(default_field)
            self.target_field_var.set(default_field)
        self.populate_notes_tree(nt_name)

    def populate_notes_tree(self, nt_name: str):
        """ノート一覧をメール一覧風のコンパクトな2列(先頭2フィールドの要約)で表示する。
        フィールドの中身は右のプレビューペインで確認する。"""
        fields = self.notetype_fields.get(nt_name, [])
        notes_data = self.notetype_notes.get(nt_name, [])

        self.notes_tree.delete(*self.notes_tree.get_children())
        summary_fields = fields[:2]
        self.notes_tree["columns"] = ["num"] + summary_fields
        self.notes_tree.heading("num", text="#")
        self.notes_tree.column("num", width=42, anchor="e", stretch=False)
        for f in summary_fields:
            self.notes_tree.heading(f, text=f)
        if summary_fields:
            self.notes_tree.column(summary_fields[0], width=140, anchor="w", stretch=False)
            if len(summary_fields) > 1:
                self.notes_tree.column(summary_fields[1], width=240, anchor="w", stretch=True)

        for i, (nid, vals) in enumerate(notes_data, start=1):
            summary = [
                tts_core.strip_html_for_tts(v)[:80] for v in vals[: len(summary_fields)]
            ]
            self.notes_tree.insert("", "end", iid=str(nid), values=[i] + summary)

        total = self.notetype_total_counts.get(nt_name, len(notes_data))
        if total > len(notes_data):
            self.notes_count_label.configure(
                text=f"全 {total} 件中、先頭 {len(notes_data)} 件を表示"
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

    def _get_selected_note_fields(self):
        """選択中ノートの(フィールド名リスト, フィールド値リスト, note_id)を返す。
        未選択時は先頭ノートを使い、データが無ければ(None, None, None)。"""
        nt_name = self.notetype_var.get()
        fields = self.notetype_fields.get(nt_name, [])
        notes_data = self.notetype_notes.get(nt_name, [])
        if not fields or not notes_data:
            return None, None, None

        selected = self.notes_tree.selection()
        if selected:
            nid = int(selected[0])
            for n, flds in notes_data:
                if n == nid:
                    return fields, flds, n
        return fields, notes_data[0][1], notes_data[0][0]

    def update_preview(self, event=None):
        """右ペインに選択中ノートの全フィールドを表示する(Outlookの閲覧ウィンドウ風)。
        Source/Targetに指定されているフィールドにはバッジを付ける。"""
        nt_name = self.notetype_var.get()
        fields, values, nid = self._get_selected_note_fields()
        pv = self.preview_text
        pv.configure(state="normal")
        pv.delete("1.0", "end")
        if fields is None:
            pv.insert("end", "apkgを読み込むと、ここに選択中ノートの内容が表示されます。", "empty")
            self._preview_source = None
        elif nt_name == SHUUJUKU_NOTETYPE_NAME and "Content" in fields:
            # 習熟用ノートはContentフィールドに全情報(英語例文+日本語の意味・
            # 解説等)が混在した1つの塊なので、そのまま出すと読みにくい。
            # ストック選択時と同じPattern/Meaning/Examples/Explanation/Source
            # の構造化表示に再分解する(_render_shuujuku_fields_to_pane)。
            content_html = values[fields.index("Content")]
            parsed = tts_core.parse_shuujuku_content_html(content_html)
            self._render_shuujuku_fields_to_pane(parsed)
            self._preview_source = {
                "kind": "note", "nt_name": nt_name, "fields": fields, "values": values, "nid": nid,
            }
        else:
            src_name = self.source_field_var.get()
            tgt_name = self.target_field_var.get()
            for fname, fval in zip(fields, values):
                pv.insert("end", fname, "fieldname")
                if fname == src_name:
                    pv.insert("end", "  [Source]", "badge")
                if fname == tgt_name:
                    pv.insert("end", "  [Target]", "badge")
                pv.insert("end", "\n")
                text = tts_core.html_to_display_text(fval)
                if text:
                    pv.insert("end", text + "\n")
                else:
                    pv.insert("end", "(空欄)\n", "empty")
            self._preview_source = {
                "kind": "note", "nt_name": nt_name, "fields": fields, "values": values, "nid": nid,
            }
        pv.configure(state="disabled")

    def on_open_card_in_browser(self):
        """右のプレビューペインに現在表示されている内容(ノート一覧選択中の
        ノート、または習熟用ストック選択中の候補)を、実際のカードテンプレート
        +CSSでHTML化し、Anki風の小さいプレビューウィンドウ(Edge/Chromeの
        --appモード)で開く。プレビュー欄に何も表示されていなければ警告する。"""
        source = getattr(self, "_preview_source", None)
        if not source:
            messagebox.showwarning(
                "未選択", "プレビュー欄に何も表示されていません。ノート一覧または習熟用ストックから選択してください。"
            )
            return
        try:
            if source["kind"] == "note":
                styling = self.notetype_styling.get(source["nt_name"])
                if not styling:
                    messagebox.showwarning("エラー", "ノートタイプの情報が見つかりません。")
                    return
                html_doc = tts_core.render_card_preview_html(
                    dict(zip(source["fields"], source["values"])),
                    styling["qfmt"],
                    styling["afmt"],
                    styling["css"],
                    night_mode=self.theme_var.get() == "dark",
                )
                tmp_name = f"anki_card_preview_{source['nid']}.html"
            elif source["kind"] == "shuujuku":
                if not SHUUJUKU_AVAILABLE:
                    messagebox.showerror(
                        "エラー",
                        "build_shuujuku_v1.py が見つからないか、genankiがインストールされていません。",
                    )
                    return
                item = source["item"]
                content = "<div class=\"deck-title\">習熟用 &nbsp;No.001</div>" + build_shuujuku_v1.render_item(
                    1, item
                )
                html_doc = tts_core.render_card_preview_html(
                    {"Content": content},
                    build_shuujuku_v1.FRONT_TMPL,
                    build_shuujuku_v1.BACK_TMPL,
                    build_shuujuku_v1.BASE_CSS,
                    night_mode=self.theme_var.get() == "dark",
                )
                tmp_name = "shuujuku_card_preview.html"
            elif source["kind"] == "word":
                card_def = card_defs.get_def("word")
                if not card_def_builder.GENANKI_AVAILABLE or not card_def:
                    messagebox.showerror(
                        "エラー",
                        "「単語」のカード定義が見つからないか、genankiがインストールされていません。",
                    )
                    return
                item = source["item"]
                fields_dict = card_def_builder.fields_dict_from_item(card_def, item)
                template = card_def["templates"][0]
                html_doc = tts_core.render_card_preview_html(
                    fields_dict,
                    template["qfmt"],
                    template["afmt"],
                    card_def.get("css", ""),
                    night_mode=self.theme_var.get() == "dark",
                )
                tmp_name = "word_card_preview.html"
            else:
                return

            tmp_path = os.path.join(tempfile.gettempdir(), tmp_name)
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(html_doc)
            tts_core.open_html_preview_window(tmp_path)
            self.log(f"カードプレビューを小窓で開きました: {tmp_path}")
        except Exception as e:  # noqa: BLE001
            self.log(f"カードプレビューの生成に失敗しました: {e}")
            messagebox.showerror("エラー", f"カードプレビューの生成に失敗しました:\n{e}")

    def _save_current_config(self):
        cfg = {
            "remember_key": self.remember_key_var.get(),
            "voice": self.voice_var.get(),
            "language_code": self.lang_var.get(),
            "voices_cache": self.voices_cache,
            "sentence_gap": self.sentence_gap_var.get(),
            "per_sentence_tags": self.per_sentence_var.get(),
            "mp3_bitrate": int(self.mp3_bitrate_var.get()),
            "volume_gain_db": self.volume_gain_db_var.get(),
            "force_regen": self.force_regen_var.get(),
            "auto_open_anki": self.auto_open_anki_var.get(),
            "auto_backup": self.auto_backup_var.get(),
            "theme": self.theme_var.get(),
            "sheets_spreadsheet_id": self.sheets_spreadsheet_id_var.get(),
            "sheets_sheet_name": self.sheets_sheet_name_var.get(),
            "gemini_api_key": self.gemini_api_key_var.get(),
            "gemini_model": self.gemini_model_var.get(),
            "gemini_models_cache": self.gemini_models_cache,
            "show_notes_pane": getattr(self, "_mid_visible", True),
            "show_preview_pane": getattr(self, "_right_visible", True),
            "notes_pane_width": getattr(self, "_mid_saved_width", 320),
            "preview_pane_width": getattr(self, "_right_saved_width", 480),
        }
        try:
            cfg["window_geometry"] = self.geometry()
        except tk.TclError:
            pass
        if self.remember_key_var.get():
            cfg["api_key"] = self.api_key_var.get()
        try:
            tts_core.save_config(cfg)
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
                names = tts_core.list_google_voices(lang, api_key)
                if not names:
                    self.log(f"'{lang}' に該当する音声が見つかりませんでした。")
                    return
                self.voice_combo["values"] = names
                if self.voice_var.get() not in names:
                    self.voice_var.set(names[0])
                self.voices_cache[lang] = names
                self._save_current_config()
                self.log(f"'{lang}' の音声を {len(names)} 件取得しました。")
            except Exception as e:  # noqa: BLE001
                self.log(f"音声一覧の取得に失敗しました: {e}")
                if not silent:
                    messagebox.showerror("エラー", f"音声一覧の取得に失敗しました:\n{e}")

        threading.Thread(target=worker, daemon=True).start()

    def on_manage_backups_clicked(self):
        backups = tts_core.list_backups()

        win = tk.Toplevel(self)
        win.title("バックアップ管理")
        win.geometry("640x440")
        win.minsize(500, 350)
        win.resizable(True, True)

        ttk.Label(win, text=f"保存場所: {tts_core.BACKUP_DIR}").pack(
            anchor="w", padx=12, pady=(12, 6)
        )

        tree_frame = ttk.Frame(win)
        tree_frame.pack(fill="both", expand=True, padx=12, pady=6)
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
            for fpath, fname, mtime, size in tts_core.list_backups():
                mtime_str = datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
                size_str = f"{size / 1024:.0f} KB"
                tree.insert("", "end", iid=fpath, values=(fname, mtime_str, size_str))

        populate()

        count_label = ttk.Label(win, text=f"バックアップ数: {len(backups)} 件")
        count_label.pack(anchor="w", padx=12)

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
            for fpath, _fname, _mtime, _size in tts_core.list_backups():
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
        btn_frame.pack(fill="x", padx=12, pady=12)
        ttk.Button(btn_frame, text="選択した項目を復元(名前を付けて保存)", command=on_restore).pack(
            side="left", padx=4
        )
        ttk.Button(btn_frame, text="すべて削除", command=on_delete_all).pack(side="left", padx=4)
        ttk.Button(btn_frame, text="閉じる", command=win.destroy).pack(side="right", padx=4)

    def _get_source_transform_for(self, nt_name: str):
        """習熟用(ATSU方式)ノートは、Contentフィールドに英語例文と日本語の
        意味・和訳・解説が混在しているため、フィールドをそのままTTSに
        かけると日本語部分まで英語音声で読み上げようとしてしまう。
        該当notetypeの場合だけ、英語例文部分だけを抽出する変換関数を返す。"""
        if nt_name == SHUUJUKU_NOTETYPE_NAME:
            return tts_core.extract_shuujuku_tts_text
        return None

    def on_dry_run_clicked(self):
        if not self.apkg_path.get():
            messagebox.showwarning("入力不足", "apkgファイルを選択してください。")
            return

        def worker():
            try:
                work_col_path = os.path.join(
                    os.environ.get("TEMP", tempfile.gettempdir()), "_anki_tts_gui_dryrun.anki2"
                )
                col = tts_core.load_collection(self.apkg_path.get(), work_col_path)
                nt_name = self.notetype_var.get()
                nt = col.models.by_name(nt_name)
                field_names = [f["name"] for f in nt["flds"]]
                src_idx = field_names.index(self.source_field_var.get())
                tgt_idx = field_names.index(self.target_field_var.get())

                to_process, skip_audio, skip_empty, total_chars = tts_core.analyze_targets(
                    col, nt_name, src_idx, tgt_idx, self.force_regen_var.get(),
                    source_transform=self._get_source_transform_for(nt_name),
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

        raw_field_text = tts_core.strip_sound_tags(current_fields[fields.index(src_name)])
        preview_text = tts_core.strip_html_for_tts(raw_field_text)
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
                audio_bytes, ext = tts_core.synthesize_with_gaps(
                    raw_field_text, voice, lang, api_key, gap_seconds, bitrate,
                    self.volume_gain_db_var.get(),
                )
                tmp_path = os.path.join(tempfile.gettempdir(), f"anki_tts_preview_{nid}.{ext}")
                with open(tmp_path, "wb") as f:
                    f.write(audio_bytes)
                self.log(f"再生します: {tmp_path}")
                tts_core.open_with_default_player(tmp_path)
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
                    backup_path = tts_core.make_backup_path(self.apkg_path.get())
                    shutil.copy2(self.apkg_path.get(), backup_path)
                    self.log(f"バックアップを作成しました: {backup_path}")
                except Exception as e:  # noqa: BLE001
                    self.log(f"バックアップの作成に失敗しました(処理は続行します): {e}")

            work_col_path = os.path.join(
                os.environ.get("TEMP", tempfile.gettempdir()), "_anki_tts_gui_generate.anki2"
            )
            col = tts_core.load_collection(self.apkg_path.get(), work_col_path)

            nt_name = self.notetype_var.get()
            nt = col.models.by_name(nt_name)
            field_names = [f["name"] for f in nt["flds"]]
            src_idx = field_names.index(self.source_field_var.get())
            tgt_idx = field_names.index(self.target_field_var.get())

            force_regen = self.force_regen_var.get()
            source_transform = self._get_source_transform_for(nt_name)
            to_process, skipped_has_audio, skipped_empty, _total_chars = tts_core.analyze_targets(
                col, nt_name, src_idx, tgt_idx, force_regen, source_transform=source_transform
            )

            self.progress["maximum"] = max(len(to_process), 1)
            self.progress["value"] = 0

            if (
                not self.per_sentence_var.get()
                and self.sentence_gap_var.get() > 0
                and not tts_core.LAMEENC_AVAILABLE
            ):
                self.log(
                    "注意: lameencが未インストールのため、結合音声はMP3ではなくWAVのまま出力されます。"
                    "圧縮したい場合は `pip install lameenc` を実行してください。"
                )

            def on_progress(done, total):
                self.progress["value"] = done
                self.update_idletasks()

            result = tts_core.generate_tts_for_collection(
                col,
                nt_name,
                src_idx,
                tgt_idx,
                to_process,
                api_key=self.api_key_var.get(),
                voice=self.voice_var.get(),
                lang=self.lang_var.get(),
                gap_seconds=self.sentence_gap_var.get(),
                bitrate=int(self.mp3_bitrate_var.get()),
                per_sentence=self.per_sentence_var.get(),
                force_regen=force_regen,
                volume_gain_db=self.volume_gain_db_var.get(),
                source_transform=source_transform,
                log=self.log,
                on_progress=on_progress,
                should_cancel=self._cancel_event.is_set,
            )

            matched_sheet_ids = []
            if self.sheets_update_var.get():
                processed_note_ids = to_process[: result.processed]
                row_map = None
                if self._current_row_map:
                    row_map = self._current_row_map  # スプレッドシートから直接読み込んだ場合
                elif self.row_map_path.get():
                    try:
                        row_map = tts_core.load_row_map(self.row_map_path.get())
                    except Exception as e:  # noqa: BLE001
                        self.log(
                            f"row_map.jsonの読み込みに失敗しました(スプレッドシート更新はスキップします): {e}"
                        )

                if row_map:
                    matched_sheet_ids, unmatched_guids = tts_core.match_sheet_row_ids(
                        col, processed_note_ids, row_map
                    )
                    if unmatched_guids:
                        self.log(
                            f"対応が無いノートが{len(unmatched_guids)}件ありました"
                            "(スプレッドシート更新の対象からは除外します)。"
                        )

            tts_core.export_collection(col, self.output_path.get())
            col.close()

            status = "キャンセルにより途中まで" if result.cancelled else "完了"
            self.log(
                f"\n{status}: 新規生成 {result.processed} 件 / 既に音声あり(スキップ) "
                f"{skipped_has_audio} 件 / 空欄スキップ {skipped_empty} 件"
            )
            self.log(f"出力ファイル: {self.output_path.get()}")
            self._save_current_config()

            if matched_sheet_ids:
                self._update_sheets_export_status(matched_sheet_ids)

            if result.cancelled:
                messagebox.showinfo(
                    "中断", f"キャンセルされました。{result.processed} 件を処理した時点までの内容で出力しました。"
                )
            else:
                if self.auto_open_anki_var.get():
                    try:
                        self.log("出力apkgをAnkiに渡します(取り込み画面を開きます)...")
                        tts_core.open_with_default_player(self.output_path.get())
                    except Exception as e:  # noqa: BLE001
                        self.log(f"Ankiでの自動オープンに失敗しました: {e}")
                messagebox.showinfo("完了", "TTS音声の追加が完了しました。")
        except Exception as e:  # noqa: BLE001
            self.log(f"エラー: {e}")
            messagebox.showerror("エラー", str(e))
        finally:
            self.generate_btn.configure(state="normal")
            self.cancel_btn.configure(state="disabled")

    def _update_sheets_export_status(self, sheet_row_ids: list):
        """処理済みノートに対応するスプレッドシート行を「Anki出力済み」にマークする。
        実書き込み前に必ず確認ダイアログを挟む(取り消せない外部操作のため)。"""
        credentials_path = os.environ.get("SHEETS_WRITER_CREDENTIALS", "")
        if not credentials_path:
            self.log(
                "SHEETS_WRITER_CREDENTIALS が未設定のため、スプレッドシートの更新をスキップしました。"
            )
            return
        if not self.sheets_spreadsheet_id_var.get():
            self.log("スプレッドシートIDが未入力のため、スプレッドシートの更新をスキップしました。")
            return

        if not messagebox.askyesno(
            "スプレッドシート更新の確認",
            f"{len(sheet_row_ids)} 件のスプレッドシート行を「Anki出力済み」にマークします。\n"
            "よろしいですか?(この操作は取り消せません)",
        ):
            self.log("スプレッドシートの更新をキャンセルしました。")
            return

        try:
            result = sheets_writer.mark_rows_as_exported(
                spreadsheet_id=self.sheets_spreadsheet_id_var.get(),
                sheet_name=self.sheets_sheet_name_var.get(),
                row_ids=sheet_row_ids,
                credentials_path=credentials_path,
                dry_run=False,
                log=self.log,
            )
            self.log(
                f"スプレッドシート更新完了: 成功 {len(result.succeeded)} 件 / "
                f"見つからず {len(result.failed)} 件"
            )
        except sheets_writer.SheetsWriterError as e:
            self.log(f"スプレッドシートの更新に失敗しました: {e}")
            messagebox.showerror("エラー", f"スプレッドシートの更新に失敗しました:\n{e}")


if __name__ == "__main__":
    app = AnkiTTSApp()
    app.mainloop()
