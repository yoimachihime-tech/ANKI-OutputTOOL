#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
card_def_builder.py
--------------------
card_defs.py が保持する定義(dict)から、genankiのModel/Deck/Noteを動的に
組み立てる汎用モジュール。「単語」タブ用に固定で書かれていたbuild_word_v1.py
の代わりに、⚙設定の「カード定義」タブで編集された内容がそのまま出力に
反映されるようにするためのもの。

対象範囲についてはcard_defs.pyのモジュールdocstringを参照
(2026-07-27時点では「単語」タブのみ)。
"""

try:
    import genanki
    GENANKI_AVAILABLE = True
except ImportError:
    GENANKI_AVAILABLE = False


class CardDefBuilderError(Exception):
    """card_defの内容が不正、またはgenanki未インストールの場合の例外。"""


def build_model(card_def: dict):
    if not GENANKI_AVAILABLE:
        raise CardDefBuilderError("genanki がインストールされていません。`pip install genanki` を実行してください。")
    return genanki.Model(
        card_def["model_id"],
        card_def["notetype_name"],
        fields=[{"name": f["anki_name"]} for f in card_def["fields"]],
        templates=[
            {"name": t["name"], "qfmt": t["qfmt"], "afmt": t["afmt"]}
            for t in card_def["templates"]
        ],
        css=card_def.get("css", ""),
    )


def build_guid(card_def: dict, item: dict) -> str:
    """dedup_keyで指定されたitemの値(前後空白除去・小文字化)を一意キーとする。
    同じキーで複数回生成しても、既存ノートの学習履歴を壊さず上書き対象に
    なるようにするため(genankiの仕様: 同じguidのノートは重複追加されない)。"""
    key_value = str(item.get(card_def["dedup_key"], "")).strip().lower()
    return genanki.guid_for(card_def["key"], key_value)


def build_deck_from_def(card_def: dict, items: list):
    """card_def(card_defs.get_def()の戻り値)とitems(dictのリスト、キーは
    各fieldの"item_key")から、genanki.Deckを組み立てる。"""
    if not GENANKI_AVAILABLE:
        raise CardDefBuilderError("genanki がインストールされていません。`pip install genanki` を実行してください。")
    model = build_model(card_def)
    deck = genanki.Deck(card_def["deck_id"], card_def["deck_name"])
    for item in items:
        fields = [str(item.get(f["item_key"], "")) for f in card_def["fields"]]
        note = genanki.Note(model=model, fields=fields, guid=build_guid(card_def, item))
        deck.add_note(note)
    return deck


def fields_dict_from_item(card_def: dict, item: dict) -> dict:
    """プレビュー表示用に、Ankiフィールド名をキーにしたdictへ変換する
    (tts_core.render_card_preview_htmlにそのまま渡せる形)。"""
    return {f["anki_name"]: str(item.get(f["item_key"], "")) for f in card_def["fields"]}
