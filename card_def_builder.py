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


def build_deck_from_def(card_def: dict, items: list, start_num: int = 1):
    """card_def(card_defs.get_def()の戻り値)とitems(dictのリスト、キーは
    各fieldの"item_key")から、genanki.Deckを組み立てる。

    start_num: cards.due(Ankiの新規カードの位置)の開始番号(既定1)。
    以前はdueを指定していなかったためgenankiの既定値0が全ノートに入り、
    単語デッキの新規カードがすべて同じ位置に積まれていた(2026-08-20修正)。
    呼び出し元(tts_gui.py)がdue_counter.get_next_due("word")で続き番号を渡す。
    """
    if not GENANKI_AVAILABLE:
        raise CardDefBuilderError("genanki がインストールされていません。`pip install genanki` を実行してください。")
    model = build_model(card_def)
    deck = genanki.Deck(card_def["deck_id"], card_def["deck_name"])
    for offset, item in enumerate(items):
        fields = [str(item.get(f["item_key"], "")) for f in card_def["fields"]]
        note = genanki.Note(
            model=model,
            fields=fields,
            guid=build_guid(card_def, item),
            due=start_num + offset,
        )
        deck.add_note(note)
    return deck


def write_decks_to_apkg(decks: list, output_path: str) -> None:
    """複数のgenanki.Deckを1つの.apkgにまとめて書き出す(2026-08-20追加、
    「一括出力」タブ用)。Anki側では今までどおりデッキごとに取り込まれる
    (1つのapkgに複数デッキ・複数ノートタイプが入っているだけ)。

    1デッキだけの場合の deck.write_to_file() と互換の出力になる
    (genanki.Deck.write_to_file自身が Package([self]).write_to_file を呼ぶ)。"""
    if not GENANKI_AVAILABLE:
        raise CardDefBuilderError("genanki がインストールされていません。`pip install genanki` を実行してください。")
    genanki.Package(decks).write_to_file(output_path)


def fields_dict_from_item(card_def: dict, item: dict) -> dict:
    """プレビュー表示用に、Ankiフィールド名をキーにしたdictへ変換する
    (tts_core.render_card_preview_htmlにそのまま渡せる形)。"""
    return {f["anki_name"]: str(item.get(f["item_key"], "")) for f in card_def["fields"]}
