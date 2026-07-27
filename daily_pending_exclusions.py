#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
daily_pending_exclusions.py
----------------------------
「シート上の未出力行」一覧(tts_gui.pyのrefresh_daily_pending_view)で、
重複などの理由でもう出力対象にしたくない行をローカルに記録するモジュール。

「添削結果」シート自体は、sheets_reader.pyが読み取り専用・sheets_writer.pyは
「Anki出力済み」列書き込みと新規行追記だけが責務のため、この経路からは
行を直接削除・編集できない(2026-07-27、片桐から「重複行を削除したいが
スプレッドシートを直接編集はできないはず」との指摘を受けて追加)。
そのため「除外したい行のID」をこのソフト側だけでローカルに保持し、
sheets_reader.fetch_pending_rows()の結果からその場でフィルタする方式にした
(シート側のデータには一切書き込まない)。

【永続化】
このフォルダのdaily_pending_exclusions.jsonに保存する
(shuujuku_stock.json等と同じ理由でgit管理対象外)。
"""

import json
import os

EXCLUSIONS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "daily_pending_exclusions.json"
)


def load_excluded_ids(path: str = None) -> set:
    if path is None:
        path = EXCLUSIONS_PATH
    if not os.path.exists(path):
        return set()
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return set(data.get("excluded_ids", []))


def save_excluded_ids(excluded_ids: set, path: str = None) -> None:
    if path is None:
        path = EXCLUSIONS_PATH
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"excluded_ids": sorted(excluded_ids)}, f, ensure_ascii=False, indent=2)


def add_excluded_id(row_id: str, path: str = None) -> None:
    if not row_id:
        return
    ids = load_excluded_ids(path)
    ids.add(row_id)
    save_excluded_ids(ids, path)


def filter_out_excluded(rows: list, path: str = None) -> list:
    """sheets_reader.fetch_pending_rows()が返した行のリストから、
    ローカルで除外登録済みのidを持つ行を取り除いて返す。"""
    excluded = load_excluded_ids(path)
    if not excluded:
        return rows
    return [r for r in rows if r.get("id") not in excluded]
