#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tab_notes_state.py
-------------------
DailyConversation/習熟用(音読)/単語/AIに質問の各タブが「まとめてノート
一覧に出力」した内容を、アプリを再起動しても保持するための永続化モジュール
(2026-07-28追加)。

【設計】
- 「まとめてノート一覧に出力」で生成されるデッキ(.apkg)自体は、以前は
  tempfile.gettempdir()に書き出していたが、OSのtempフォルダは再起動時の
  クリーンアップ等で消える可能性があり、それに依存すると「保持したはずが
  消えた」となる(片桐からの指摘)。そのため、このフォルダの pending_decks/
  以下に、タブごとの固定ファイル名(例: pending_decks/daily.apkg)で直接
  書き出す方式にした。1タブにつき常に最新の1件だけを保持する(「まとめて
  ノート一覧に出力」を再実行すると上書きされる。既存のtts_gui.py側の
  self._pending_*_stock_itemsが「常に最新の1件」を保持する設計と同じ考え方)。
- apkg以外のメタデータ(row_map・ストックの出力済みマーク待ち情報等)は
  tab_notes_state.json に保存する。中身はtts_gui.pyの
  _snapshot_tab_output_stateが作るentry辞書(apkg_path/output_path/
  row_map_path/current_row_map/pending_word_stock_items/
  pending_shuujuku_stock_items/pending_grammar_multi_stock_items)を
  そのままJSON化したもの。
- ④のTTS音声生成(run_generate)が成功すると、そのタブの記録は
  clear_tab_state()で削除される(「ノート一覧に入っているものをTTSで
  出力したら、その一覧から消える」という運用のため)。

【対象タブ】
apkgインポートタブは対象外(「まとめてノート一覧に出力」ボタンを持たず、
外部で生成された.apkgを都度手動で読み込む使い方のため、この永続化の対象に
含めていない)。
"""

import os

import json_store

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(BASE_DIR, "tab_notes_state.json")
PENDING_DECKS_DIR = os.path.join(BASE_DIR, "pending_decks")

# ④のTTS音声生成の最終成果物(Ankiに取り込むapkg)の既定の置き場所
# (2026-07-28追加)。tts_gui._set_apkg_pathは既定の出力先を
# 「<入力apkgのパス>_tts追加.apkg」として導出するため、入力apkgを
# pending_decks/へ移した結果、利用者にとっての最終成果物までこの内部作業用
# フォルダに書き出され、しかもclear_tab_state()の削除対象外なので溜まり
# 続けていた。入力(作業用)と出力(成果物)でフォルダを分ける。
OUTPUT_DIR = os.path.join(BASE_DIR, "output")

# "bulk" は「一括出力」タブ(2026-08-20追加)。他の4タブの未出力候補をまとめて
# 1つのapkgにしたもので、扱い(pending_decks/bulk.apkg + 状態の永続化)は
# 他のタブとまったく同じ。
PERSISTED_TAB_KEYS = ("daily", "shuujuku", "word", "ai_ask", "bulk")


def is_pending_deck_path(path: str, decks_dir: str = None) -> bool:
    """pathが、このモジュールが管理する作業用デッキ(pending_decks/配下)かを返す。"""
    if not path:
        return False
    if decks_dir is None:
        decks_dir = PENDING_DECKS_DIR
    try:
        return os.path.dirname(os.path.abspath(path)) == os.path.abspath(decks_dir)
    except (OSError, ValueError):
        return False


def output_path_for(tab_key: str, output_dir: str = None) -> str:
    """tab_keyの「まとめてノート一覧に出力」から④まで進んだ場合の、
    最終成果物(TTS音声入りapkg)の既定パスを返す。"""
    if output_dir is None:
        output_dir = OUTPUT_DIR
    os.makedirs(output_dir, exist_ok=True)
    return os.path.join(output_dir, f"{tab_key}_tts追加.apkg")


def pending_deck_path(tab_key: str, decks_dir: str = None) -> str:
    """tab_keyの「まとめてノート一覧に出力」で生成するデッキの固定パスを
    返す(ディレクトリが無ければ作成する)。"""
    if decks_dir is None:
        decks_dir = PENDING_DECKS_DIR
    os.makedirs(decks_dir, exist_ok=True)
    return os.path.join(decks_dir, f"{tab_key}.apkg")


def load_all(path: str = None) -> dict:
    """永続化済みの全タブ分の状態を返す({tab_key: entry辞書})。
    ファイルが無い・壊れている場合は空辞書を返す。"""
    if path is None:
        path = STATE_PATH
    return json_store.read_json(path, {})


def save_tab_state(tab_key: str, entry: dict, path: str = None) -> None:
    """tab_keyの出力内容(_snapshot_tab_output_stateが作るentry辞書)を
    永続化する。"""
    state = load_all(path)
    state[tab_key] = entry
    _write_state(state, path)


def clear_tab_state(tab_key: str, path: str = None, decks_dir: str = None) -> None:
    """tab_keyの永続化状態を削除する(④のTTS音声生成が成功し、ノート一覧を
    クリアする際に呼ぶ)。pending_decks/内のapkgファイルも削除する。"""
    state = load_all(path)
    if tab_key in state:
        del state[tab_key]
        _write_state(state, path)
    dest_path = pending_deck_path(tab_key, decks_dir)
    if os.path.exists(dest_path):
        try:
            os.remove(dest_path)
        except OSError:
            pass


def _write_state(state: dict, path: str = None) -> None:
    if path is None:
        path = STATE_PATH
    # 一時ファイル + os.replace によるアトミック書き込み(2026-08-05)。
    # 詳細は json_store.py の説明を参照。
    json_store.write_json(path, state)
