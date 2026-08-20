#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deck_builder.py
---------------
sheets_reader.py が返す行データ(rows)から、genankiでAnkiデッキ(.apkg)を組み立てる。

【設計方針(重要)】
    - ノートタイプ・デッキ定義・フィールドの並び順などの実体は一切ここに持たない。
      すべて build_grammar_dailyconv_v1_final.py (正典はclaude.ai側のプロジェクト
      知識ベースにあり、ここにあるのはその時点のコピー)の process_sheet_rows() /
      build_deck() をそのまま呼び出すだけにする。
      理由: 正典が更新されローカルコピーが古くなっても、このモジュールが
      内部構造(フィールド順序等)に依存していなければ影響を受けずに済むため。
    - guidの計算方法(genanki.guid_for('dailyconv', シートのID列の値))は
      build_grammar_dailyconv_v1_final.py内で「変更しないこと」と明記されている
      ルールなので、row_map生成にそのまま使ってよい。
"""

try:
    import genanki

    import build_grammar_dailyconv_v1_final as _builder
    DECK_BUILDER_AVAILABLE = True
except ImportError:
    DECK_BUILDER_AVAILABLE = False


class DeckBuilderError(Exception):
    """genanki未インストール、またはbuild_grammar_dailyconv_v1_final.pyが
    見つからない場合の専用例外。"""


def build_deck_and_row_map(raw_rows: list, start_num: int = 1):
    """sheets_reader.fetch_pending_rows()が返したraw_rowsから、(genanki.Deck, row_map)を作る。

    row_map: {ノートのguid: シートのID列の値} の辞書。sheets_writer.mark_rows_as_exported()
    に渡すrow_idsを、TTS処理後にAnkiノートのguidから逆引きするために使う。

    start_num: cards.due(Ankiの新規カードの位置)の開始番号。正典側の
    build_deck(rows, start_num)へそのまま渡すだけ(詳細はそちらのdocstring参照)。
    """
    if not DECK_BUILDER_AVAILABLE:
        raise DeckBuilderError(
            "genanki がインストールされていないか、build_grammar_dailyconv_v1_final.py が"
            "このフォルダに見つかりません。`pip install genanki` を実行してください。"
        )
    rows = _builder.process_sheet_rows(raw_rows)
    deck = _builder.build_deck(rows, start_num=start_num)
    row_map = {genanki.guid_for("dailyconv", r["id"]): r["id"] for r in rows}
    return deck, row_map


def write_deck_to_apkg(deck, output_path: str) -> None:
    deck.write_to_file(output_path)
