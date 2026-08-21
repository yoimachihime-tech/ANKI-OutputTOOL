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


def build_deck(items: list, start_num: int = 1) -> genanki.Deck:
    """grammar_multi_stock.get_pending()が返すitemのリストから、
    「Grammar Multi」デッキを1つ組み立てて返す。書き出しは呼び出し側の責務
    (deck.write_to_file())。

    item dictのキー: pattern, question, choices, answer, example, example_ja,
    why, whynot, example_blank(いずれもcanon.GRAMMAR_MODELのフィールド値として
    渡すHTML/テキスト文字列)、topic_key, note_index(guid計算用)。

    start_num: cards.due(Ankiの新規カードの位置)の開始番号(既定1、呼び出し元が
    省略した場合は1始まりの通し番号)。以前は`enumerate(items)`の0始まりの
    インデックスをそのままdueにしていたため、出力のたびに0から振り直され、
    別バッチのカードとAnki側で位置が衝突していた(2026-08-20、片桐からの
    指摘: 「1つの質問から作った3問がまとまって出題されず、他の生成カードと
    同じ出題形式でまとまって出てしまう」)。呼び出し元(tts_gui.py)が
    due_counter.get_next_due("grammar_multi")で続き番号を渡す。
    build_shuujuku_v1.build_deck()のstart_numと同じ設計。
    """
    deck = genanki.Deck(DECK_ID, DECK_NAME)
    for offset, item in enumerate(items):
        due = start_num + offset
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
                # 2026-08-21追加。穴あき版の例文(音声タグを持たない)。
                # canon.GRAMMAR_MODELのフィールド順の末尾に対応する。
                item.get("example_blank", ""),
            ],
            guid=build_guid(item["topic_key"], item["note_index"]),
            due=due,
        )
        deck.add_note(note)
    return deck
