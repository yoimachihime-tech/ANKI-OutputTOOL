#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
card_defs.py
------------
各タブ(単語など、AIが都度カード内容を生成するタブ)が出力するAnkiノートタイプ
の定義(フィールド名・カードテンプレート・CSS・デッキ)を、Pythonファイルの
ハードコードではなくJSON(card_defs.json)として永続化するためのモジュール。

【背景・目的】
build_word_v1.pyのような「1notetype=1つのPythonファイル」方式だと、
フィールドやテンプレートを変更するたびにコード編集(Claude Codeへの依頼)が
必要になる。これを、⚙設定ダイアログの「カード定義」タブから片桐自身が
直接編集できるようにするためのデータ層。

【対象範囲(重要)】
2026-07-27時点では「単語」タブのみがこの仕組みを使う。DailyConversation
(build_grammar_dailyconv_v1_final.py)・習熟用(build_shuujuku_v1.py)は
単純なフィールド値の詰め替えではなく複雑な独自レンダリングロジックを
持つため、この汎用システムには**まだ**載せていない(移行のリスクが
見合わないため)。将来的に載せたくなった場合は個別に設計すること。

【定義(1件)のスキーマ】
{
    "key": "word",                  # 内部識別子(タブのキーと対応)
    "label": "単語",                 # 表示名
    "notetype_name": "Vocab (単語 v1)",
    "model_id": 1907245001123,       # genankiのモデルID。既存のAnki上の
                                      # ノートタイプと合わせる場合はそのID。
    "deck_id": 1785112749312,
    "deck_name": "02.単語・MindTips::単語",
    "dedup_key": "word",             # itemディクショナリのうち、guid生成・
                                      # 重複防止キーに使うキー名
    "fields": [                      # Ankiフィールドの並び順そのもの
        {"anki_name": "Word", "item_key": "word"},
        ...
    ],
    "templates": [                   # カードテンプレート(複数可)
        {"name": "...", "qfmt": "...", "afmt": "..."},
        ...
    ],
    "css": "...",
}

【永続化】
このフォルダの card_defs.json に保存する(config.json等と同じくGit管理対象外)。
"""

import json
import os

DEFS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "card_defs.json")


def load_defs(path: str = None) -> dict:
    """{"defs": {key: def, ...}} を返す。ファイルが無ければ空の状態を返す。"""
    if path is None:
        path = DEFS_PATH
    if not os.path.exists(path):
        return {"defs": {}}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("defs", {})
    return data


def save_defs(data: dict, path: str = None) -> None:
    if path is None:
        path = DEFS_PATH
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def list_defs(path: str = None) -> list:
    """定義の一覧をkey順で返す。"""
    data = load_defs(path)
    return [data["defs"][k] for k in sorted(data["defs"].keys())]


def get_def(key: str, path: str = None) -> dict:
    """指定したkeyの定義を返す。無ければNone。"""
    data = load_defs(path)
    return data["defs"].get(key)


def upsert_def(entry: dict, path: str = None) -> None:
    """entry["key"]をキーに、新規追加または上書き保存する。"""
    data = load_defs(path)
    data["defs"][entry["key"]] = entry
    save_defs(data, path)


def delete_def(key: str, path: str = None) -> bool:
    """指定したkeyの定義を削除する。戻り値: 削除できたかどうか。"""
    data = load_defs(path)
    if key not in data["defs"]:
        return False
    del data["defs"][key]
    save_defs(data, path)
    return True


def seed_default_word_def_if_missing(path: str = None) -> bool:
    """「単語」の定義が無い場合、build_word_v1.pyの内容を初期値として登録する
    (2026-07-27の統合当初はPythonハードコードだったため、その値をそのまま
    引き継ぐ形の一度きりの移行)。戻り値: 実際に登録したかどうか。"""
    if get_def("word", path) is not None:
        return False

    import build_word_v1 as bw

    upsert_def(
        {
            "key": "word",
            "label": "単語",
            "notetype_name": "Vocab (単語 v1)",
            "model_id": bw.MODEL_ID,
            "deck_id": bw.DECK_ID,
            "deck_name": bw.DECK_NAME,
            "dedup_key": "word",
            "fields": [
                {"anki_name": "Word", "item_key": "word"},
                {"anki_name": "Reading", "item_key": "reading"},
                {"anki_name": "POS", "item_key": "pos"},
                {"anki_name": "Meaning", "item_key": "meaning"},
                {"anki_name": "Example", "item_key": "example"},
                {"anki_name": "ExampleJA", "item_key": "example_ja"},
                {"anki_name": "ExampleBlank", "item_key": "example_blank"},
                {"anki_name": "Note", "item_key": "note"},
            ],
            "templates": [
                {
                    "name": "1. 意味想起(英→日)",
                    "qfmt": bw.TEMPLATE_1_QFMT,
                    "afmt": bw.TEMPLATE_1_AFMT,
                },
                {
                    "name": "2. 語彙想起(文脈→英単語)",
                    "qfmt": bw.TEMPLATE_2_QFMT,
                    "afmt": bw.TEMPLATE_2_AFMT,
                },
            ],
            "css": bw.BASE_CSS,
        },
        path,
    )
    return True
