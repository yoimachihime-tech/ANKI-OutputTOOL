#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/dump_python_apkg.py
--------------------------
標準入力で受け取った items(JSON配列)から、デスクトップ版とまったく同じ経路で
.apkg を生成し、その中身をJSONで標準出力に書き出す。

verify_web_parity.mjs から呼ばれ、Web版(docs/lib/apkg.js)の出力と
突き合わせるための「正解データ」を提供する。単体でも実行できる:

    echo '[{"word":"slated", ...}]' | python tools/dump_python_apkg.py --card-def word
    echo '[{"pattern":"...", ...}]' | python tools/dump_python_apkg.py --card-def grammar_multi

--card-def word: card_defs.json + card_def_builder 経由(デスクトップ版の
    単語タブと同じ経路)。
--card-def grammar_multi: grammar_multi_builder.build_deck() 経由
    (デスクトップ版のAIに質問タブと同じ経路。card_defs.json は通らない)。
--card-def shuujuku: build_shuujuku_v1.build_deck(items, start_num=1) 経由
    (デスクトップ版の習熟用タブと同じ経路。start_numは再現性のため1固定)。
--card-def daily: deck_builder.build_deck_and_row_map() 経由(デスクトップ版の
    DailyConversationタブと同じ経路)。この種別だけは標準入力で受け取るのが
    「生成済みのitem」ではなく**「添削結果」シートの生の行**で、カテゴリ
    「誤りなし」の除外・ID重複の除去(process_sheet_rows)もPython側で行われる。
"""

import argparse
import contextlib
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
import grammar_multi_builder  # noqa: E402
import build_shuujuku_v1  # noqa: E402
import build_grammar_dailyconv_v1_final as dailyconv_canon  # noqa: E402
import deck_builder  # noqa: E402

# Web版が guid を再実装しているため、代表的な入力での一致も確認する。
# (フィールド構成が変わっても検出できるよう、apkg 本体とは別に見る)
GUID_CASES = [
    ["word", "slated"],
    ["dailyconv", "59cb55d3-d794-4ae8-8813-c1268807b0f7"],
    ["shuujuku", "chat", "discussの使い方"],
    ["grammar-multi-v1", "テスト", "0"],
]


def build_deck_for(card_def_key: str, items: list):
    """(genanki.Deck, model_id, deck_id) を返す。card_defs.json経由/独立
    ビルダー経由のどちらでも呼び出し側から見た戻り値の形を揃える。"""
    if card_def_key == "grammar_multi":
        deck = grammar_multi_builder.build_deck(items)
        return deck, grammar_multi_builder.canon.GRAMMAR_MODEL.model_id, grammar_multi_builder.DECK_ID

    if card_def_key == "shuujuku":
        # start_num=1固定(再現性のため。docs/lib/shuujuku.jsのbuildFieldsReadyItems
        # をWeb側でも同じstartNum=1で呼び出して突き合わせる、
        # tools/verify_web_parity.mjs参照)。items内のsource_keyはJSONの配列として
        # 届くが、build_shuujuku_v1.build_guid()側は `kind, key = item['source_key']`
        # とアンパックするだけなのでlistでも問題ない。
        deck = build_shuujuku_v1.build_deck(items, start_num=1)
        return deck, build_shuujuku_v1.SHUUJUKU_MODEL.model_id, build_shuujuku_v1.DECK_ID

    if card_def_key == "daily":
        # itemsは「添削結果」シートの生の行(sheets_reader.fetch_pending_rowsの
        # 戻り値と同じ形)。build_deck_and_row_map()がprocess_sheet_rows()での
        # 除外まで含めてデスクトップ版と同じ経路で処理する。
        deck, _row_map = deck_builder.build_deck_and_row_map(items)
        return deck, dailyconv_canon.MODEL_ID, dailyconv_canon.DECK_ID

    card_def = card_defs.get_def(card_def_key)
    if not card_def:
        raise SystemExit(f"カード定義 '{card_def_key}' が見つかりません。")
    deck = card_def_builder.build_deck_from_def(card_def, items)
    return deck, card_def["model_id"], card_def["deck_id"]


def main() -> int:
    # 日本語Windowsでは標準入出力の既定が cp932 になり、日本語を含む items が
    # 壊れる(サロゲート混入で UnicodeEncodeError)。UTF-8 を明示する。
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--card-def", default="word",
        choices=["word", "grammar_multi", "shuujuku", "daily"],
    )
    args = parser.parse_args()

    items = json.load(sys.stdin)
    # build_deck_for()が呼ぶ処理の一部(process_sheet_rowsのID重複警告など)は
    # print()で標準出力に書くため、そのままだと出力するJSONが壊れる。
    # 検証時に見えるよう捨てずに標準エラーへ回す。
    with contextlib.redirect_stdout(sys.stderr):
        deck, model_id, deck_id = build_deck_for(args.card_def, items)

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
            "model": json.loads(models_json)[str(model_id)],
            "deck": json.loads(decks_json)[str(deck_id)],
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
