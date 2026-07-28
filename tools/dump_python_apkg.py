#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/dump_python_apkg.py
--------------------------
標準入力で受け取った items(JSON配列)から、デスクトップ版とまったく同じ経路
(card_defs.json + card_def_builder + genanki)で .apkg を生成し、その中身を
JSON で標準出力に書き出す。

verify_web_parity.mjs から呼ばれ、Web版(docs/lib/apkg.js)の出力と
突き合わせるための「正解データ」を提供する。単体でも実行できる:

    echo '[{"word":"slated", ...}]' | python tools/dump_python_apkg.py
"""

import json
import os
import sqlite3
import sys
import tempfile
import zipfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import genanki  # noqa: E402

import card_def_builder  # noqa: E402
import card_defs  # noqa: E402

# Web版が guid を再実装しているため、代表的な入力での一致も確認する。
# (フィールド構成が変わっても検出できるよう、apkg 本体とは別に見る)
GUID_CASES = [
    ["word", "slated"],
    ["dailyconv", "59cb55d3-d794-4ae8-8813-c1268807b0f7"],
    ["shuujuku", "chat", "discussの使い方"],
    ["grammar-multi-v1", "テスト", "0"],
]


def main() -> int:
    # 日本語Windowsでは標準入出力の既定が cp932 になり、日本語を含む items が
    # 壊れる(サロゲート混入で UnicodeEncodeError)。UTF-8 を明示する。
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    items = json.load(sys.stdin)
    card_def = card_defs.get_def("word")
    if not card_def:
        print("カード定義 'word' が見つかりません。", file=sys.stderr)
        return 1

    deck = card_def_builder.build_deck_from_def(card_def, items)

    with tempfile.TemporaryDirectory() as tmp:
        apkg_path = os.path.join(tmp, "python.apkg")
        deck.write_to_file(apkg_path)

        with zipfile.ZipFile(apkg_path) as zf:
            entries = zf.namelist()
            zf.extractall(tmp)

        con = sqlite3.connect(os.path.join(tmp, "collection.anki2"))
        notes = [
            {"guid": g, "mid": mid, "tags": tags, "flds": flds, "sfld": sfld}
            for g, mid, tags, flds, sfld in con.execute(
                "SELECT guid, mid, tags, flds, sfld FROM notes ORDER BY id"
            )
        ]
        cards = [
            {"nid": nid, "did": did, "ord": ordv, "due": due}
            for nid, did, ordv, due in con.execute(
                "SELECT nid, did, ord, due FROM cards ORDER BY id"
            )
        ]
        models_json, decks_json = con.execute("SELECT models, decks FROM col").fetchone()
        con.close()

    json.dump(
        {
            "entries": entries,
            "notes": notes,
            "cards": cards,
            "model": json.loads(models_json)[str(card_def["model_id"])],
            "deck": json.loads(decks_json)[str(card_def["deck_id"])],
            "guid_cases": {
                json.dumps(case): genanki.guid_for(*case) for case in GUID_CASES
            },
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
