#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
grammar_multi_builder.py
-------------------------
「Grammar Multi (文法・複数出題形式)」ノートタイプ向けの、
grammar_multi_stock.pyのitem dictからgenankiデッキを組み立てる橋渡し役
(deck_builder.py/build_shuujuku_v1.build_deck()と同じ位置づけ)。

build_grammar_multi_v1_updated.py(正典、claude.ai側からの2026-07-27時点の
コピー)自体はModel定義とCSS・qfmt/afmt・choice()/whynot_item()/example_en()/
example_ja()ヘルパー関数だけを提供し、「notes_data はこのファイルを流用する
各バッチスクリプト側で定義し、genanki.Note(...)で1ノート=1カードとして
追加すること」とコメントされている(Deck/Noteの組み立ては呼び出し側の責務)。
このモジュールがその「呼び出し側」にあたる。

【デッキ】
02.単語・MindTips::文法・用法 (DECK_ID 1907231458999)。
claude.aiプロジェクトのメモリーに記録された値で、build_grammar_multi_v1_
updated.py自体には含まれていない(Model定義のみのファイルのため)。

【guid】
`genanki.guid_for("grammar-multi-v1", topic_key, str(note_index))`。
1つの質問(トピック)につき独立した複数ノート(既定3枚: 選択問題/誤り訂正問題/
記述式・書き換え問題)を作るため、topic_key(質問文を正規化したもの)と
note_index(そのトピック内での通し番号)の組でノートごとに一意にする。
"""

import genanki

import build_grammar_multi_v1_updated as canon

DECK_ID = 1907231458999
DECK_NAME = '02.単語・MindTips::文法・用法'


def build_guid(topic_key: str, note_index: int) -> str:
    return genanki.guid_for("grammar-multi-v1", topic_key, str(note_index))


def build_deck(items: list) -> genanki.Deck:
    """grammar_multi_stock.get_pending()が返すitemのリストから、
    「Grammar Multi」デッキを1つ組み立てて返す。書き出しは呼び出し側の責務
    (deck.write_to_file())。

    item dictのキー: pattern, question, choices, answer, example, example_ja,
    why, whynot(いずれもcanon.GRAMMAR_MODELのフィールド値として渡すHTML/
    テキスト文字列)、topic_key, note_index(guid計算用)。
    """
    deck = genanki.Deck(DECK_ID, DECK_NAME)
    for due, item in enumerate(items):
        note = genanki.Note(
            model=canon.GRAMMAR_MODEL,
            fields=[
                item.get("pattern", ""),
                item.get("question", ""),
                item.get("choices", ""),
                item.get("answer", ""),
                item.get("example", ""),
                item.get("example_ja", ""),
                item.get("why", ""),
                item.get("whynot", ""),
            ],
            guid=build_guid(item["topic_key"], item["note_index"]),
            due=due,
        )
        deck.add_note(note)
    return deck
