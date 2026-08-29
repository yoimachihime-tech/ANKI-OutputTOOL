#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/export_shared_card_defs.py
---------------------------------
`card_defs.json`(実行時に生成される・Git管理外)から、Web版が使う
`docs/shared/card_defs.json`(Git管理対象)を書き出すスクリプト。

【なぜ変換が必要か】
Web版はブラウザ上でsql.jsを使ってapkgを組み立てるが、Anki(schema 11)の
`col.models`に入れるJSONは、genankiが内部で組み立てている形
(flds各要素のord/font/size、tmplsのord/bfont/bsize、そして`req`など)で
なければならない。特に`req`(どのフィールドが揃えばそのカードを生成するか)は
genankiがテンプレートを解析して算出しており、この算出ロジックをJavaScriptで
再実装すると food で不一致が起きるリスクがある。

そこで**Python側(genanki)に一度モデルを組み立てさせ、その結果のJSONを
そのまま書き出して**Web版はそれを埋め込むだけにする。これにより
「Web版とデスクトップ版でノートタイプ定義がズレる」事故を構造的に防ぐ。

【使い方】
    python tools/export_shared_card_defs.py

card_defs.jsonを⚙設定の「カード定義」タブで編集したら、このスクリプトを
実行し直して`docs/shared/card_defs.json`を更新すること
(でないとWeb版に反映されない)。
"""

import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import genanki  # noqa: E402
import genanki.apkg_col  # noqa: E402
import genanki.apkg_schema  # noqa: E402

import card_def_builder  # noqa: E402
import card_defs  # noqa: E402
import build_grammar_multi_v1_updated as grammar_multi_canon  # noqa: E402
import grammar_multi_builder  # noqa: E402
import build_shuujuku_v1  # noqa: E402
import build_grammar_dailyconv_v1_final as dailyconv_canon  # noqa: E402

SHARED_DIR = os.path.join(BASE_DIR, "docs", "shared")
OUT_PATH = os.path.join(SHARED_DIR, "card_defs.json")
SCHEMA_OUT_PATH = os.path.join(SHARED_DIR, "anki_schema.json")

# card_defs.json(⚙設定「カード定義」タブが編集する汎用定義)から書き出す種別。
# daily/grammar_multi/shuujukuはPython側でも汎用ビルダーを経由しない独立実装の
# ため、下のbuild_*_def()で個別に組み立てる。
EXPORT_KEYS = ("word",)


def build_anki_model_json(card_def: dict) -> dict:
    """genankiにModelを組み立てさせ、Ankiの`col.models`にそのまま入る形の
    dictを返す(genanki.Model.to_json()相当)。genanki内部APIの差異を吸収する
    ため、実際にデッキを1件書き出して読み戻すのではなく、Model側が持つ
    to_json()を使う。"""
    model = card_def_builder.build_model(card_def)
    # genanki.Model.to_json(timestamp, deck_id) は mod/usn/did を埋めた
    # 完全なモデルJSONを返す。ここで渡す値は書き出し時に上書きされる
    # 性質のものなので、再現性のため固定値を使う。
    return model.to_json(0, card_def["deck_id"])


def build_grammar_multi_def() -> dict:
    """「Grammar Multi (文法・複数出題形式)」の共有定義を組み立てる。

    word(card_defs.json + card_def_builder)と違い、grammar_multiはPython側でも
    汎用ビルダーを経由せず、build_grammar_multi_v1_updated.py(正典)の
    genanki.Modelと、grammar_multi_builder.py(deck_id/deck_name・guid計算)を
    直接使う独立した実装になっている(CLAUDE.mdの「Grammar Multiカード生成
    との関係」参照)。そのためこの関数もcard_defs.json経由ではなく、
    2つのモジュールから直接組み立てる。

    guidはword等の「1フィールドの正規化値」方式ではなく、
    genanki.guid_for("grammar-multi-v1", topic_key, str(note_index))という
    複合キー方式(grammar_multi_builder.build_guid()参照)。Web版
    (docs/lib/gemini.js)もitemにtopic_key/note_indexを持たせ、同じguidを
    計算する。
    """
    model = grammar_multi_canon.GRAMMAR_MODEL
    return {
        "key": "grammar_multi",
        "label": "AIに質問(Grammar Multi)",
        "notetype_name": model.name,
        "model_id": model.model_id,
        "deck_id": grammar_multi_builder.DECK_ID,
        "deck_name": grammar_multi_builder.DECK_NAME,
        # フィールド順はgrammar_multi_builder.build_deck()のfields=[...]と
        # 一致させること(Ankiのnotetypeフィールド順そのもの)。
        "fields": [
            {"anki_name": "Pattern", "item_key": "pattern"},
            {"anki_name": "Question", "item_key": "question"},
            {"anki_name": "Choices", "item_key": "choices"},
            {"anki_name": "Answer", "item_key": "answer"},
            {"anki_name": "Example", "item_key": "example"},
            {"anki_name": "ExampleJA", "item_key": "example_ja"},
            {"anki_name": "Why", "item_key": "why"},
            {"anki_name": "WhyNot", "item_key": "whynot"},
            {"anki_name": "ExampleBlank", "item_key": "example_blank"},
            {"anki_name": "AnswerPlain", "item_key": "answer_plain"},
        ],
        # word用のdedup_key方式(genanki.guid_for(key, 正規化した1フィールド))
        # では表現できないため、guidの組み立て方をWeb側へ明示的に伝える。
        "guid_scheme": {
            "type": "compound",
            "prefix": "grammar-multi-v1",
            "item_keys": ["topic_key", "note_index"],
        },
        # grammar_multi_builder.build_deck()のdue=start_num+offset。
        # 開始番号はdue_counter.py(Web版はdocs/lib/dueCounter.js)が
        # カード種別ごとに永続化しており、出力のたびに件数分だけ進む
        # (2026-08-20。以前は0始まりのインデックスだったため、別バッチの
        # カードとAnki側で位置が衝突していた)。
        "due_scheme": {"type": "sequence"},
        "anki_model": model.to_json(0, grammar_multi_builder.DECK_ID),
    }


def build_shuujuku_def() -> dict:
    """「ATSU方式 (音読用・TTS対応)」(習熟用タブ)の共有定義を組み立てる。

    grammar_multiと同じく、Python側でも汎用ビルダーを経由しない独立実装
    (build_shuujuku_v1.py + shuujuku_stock.pyの続き番号管理)。

    【他のカード種別と根本的に違う点】
    ストックに貯まっているitemは pattern/meaning/examples/expl/source_label
    という「生の内容」で、Ankiのフィールド(DeckTitle/Num/I1PatternEN/…)とは
    1対1に対応しない。さらにNum・I1Badge・DeckTitleは出力時点で払い出される
    連番(start_num、shuujuku_stock.get_next_num()相当)に依存する。
    そのためWeb側は「生成時点のitem」をそのままfieldsFromItem()に渡すのでは
    なく、docs/lib/shuujuku.jsのbuildFieldsReadyItems()で先にフィールド確定済み
    itemへ変換してから渡す必要がある(docs/app.jsのonExportShuujuku参照)。

    guidはgrammar_multiと同様の複合キー方式だが、キーの中身が
    (source_kind, source_topic)というsource_key由来の2値である点が異なる
    (build_shuujuku_v1.build_guid()参照。genanki.guid_for('shuujuku', kind, key))。
    """
    model = build_shuujuku_v1.SHUUJUKU_MODEL
    return {
        "key": "shuujuku",
        "label": "習熟用(音読)",
        "notetype_name": model.name,
        "model_id": model.model_id,
        "deck_id": build_shuujuku_v1.DECK_ID,
        "deck_name": build_shuujuku_v1.DECK_NAME,
        # フィールド名とitem_keyの対応は正典(build_shuujuku_v1.FIELD_ITEM_KEYS)
        # を単一の出所にする。ここに並びを再掲するとv2のように構成を変えた
        # ときに片方だけ古いまま残るため。
        "fields": [
            {"anki_name": name, "item_key": key}
            for name, key in build_shuujuku_v1.FIELD_ITEM_KEYS
        ],
        "guid_scheme": {
            "type": "compound",
            "prefix": "shuujuku",
            "item_keys": ["source_kind", "source_topic"],
        },
        # Numフィールドと同じ値をdueにも使う(build_shuujuku_v1.build_deck()の
        # due=idxと同じ)。「itemの特定フィールドの値をそのままdueにする」
        # という、word(常に0)・grammar_multi(配列内インデックス)のどちらとも
        # 異なる第3のパターンのため、apkg.js側にdue_scheme.type="field"を
        # 追加した。
        "due_scheme": {"type": "field", "key": "num"},
        "anki_model": model.to_json(0, build_shuujuku_v1.DECK_ID),
    }


def build_daily_def() -> dict:
    """「Grammar DailyConversation (日次英作文添削 v1)」(DailyConversationタブ)の
    共有定義を組み立てる(2026-07-29、Web版のシート連携対応時に追加)。

    grammar_multi/shuujukuと同じく、Python側でも汎用ビルダー(card_defs.json +
    card_def_builder)を経由せず、build_grammar_dailyconv_v1_final.py(正典)の
    genanki.Modelとdeck_builder.py経由の生成になっている。card_defs.jsonにも
    参照専用(editable=False)の定義が入っているが、そちらは実際の出力には
    使われていないため、ここでは正典モジュールから直接組み立てる。

    【他のカード種別と違う点】
    itemの元になるのはAIの生成結果ではなく「添削結果」シートの1行で、
    Question/Example/ExampleJA/Scoreはその行の複数列からHTMLに合成した結果
    (build_deck()内の組み立て)。そのためWeb側は生の行をそのまま
    fieldsFromItem()に渡すのではなく、docs/lib/dailyconv.jsの
    buildFieldsReadyItems()で先に9フィールド分の値へ変換してから渡す
    (shuujukuのbuildFieldsReadyItems()と同じ位置づけ)。

    guidはgenanki.guid_for('dailyconv', シートのID列の値)。word等の
    dedup_key方式は値を小文字化+trimしてしまい正典と一致しないため、
    生値をそのまま使うcompound方式(item_keys=["id"])で表現する。
    """
    model = dailyconv_canon.GRAMMAR_DC_MODEL
    return {
        "key": "daily",
        "label": "DailyConversation(日次英作文添削)",
        "notetype_name": model.name,
        "model_id": model.model_id,
        "deck_id": dailyconv_canon.DECK_ID,
        "deck_name": dailyconv_canon.DECK_NAME,
        # フィールド順はbuild_deck()のfields=[...]と一致させること。
        "fields": [
            {"anki_name": "Pattern", "item_key": "pattern"},
            {"anki_name": "Question", "item_key": "question"},
            {"anki_name": "Choices", "item_key": "choices"},
            {"anki_name": "Answer", "item_key": "answer"},
            {"anki_name": "Example", "item_key": "example"},
            {"anki_name": "ExampleJA", "item_key": "example_ja"},
            {"anki_name": "Why", "item_key": "why"},
            {"anki_name": "WhyNot", "item_key": "whynot"},
            {"anki_name": "Score", "item_key": "score"},
        ],
        "guid_scheme": {
            "type": "compound",
            "prefix": "dailyconv",
            "item_keys": ["id"],
        },
        # build_deck()のdue=start_num+offset(grammar_multiと同じ)。
        "due_scheme": {"type": "sequence"},
        # build_deck()は全ノートにsource::gemini_dailyconvタグを付ける。
        # 他のカード種別はタグ無しなので、この定義だけが持つ項目。
        "tags": [dailyconv_canon.SOURCE_TAG],
        "anki_model": model.to_json(0, dailyconv_canon.DECK_ID),
    }


def main() -> int:
    exported = {}
    for key in EXPORT_KEYS:
        card_def = card_defs.get_def(key)
        if not card_def:
            print(f"警告: カード定義 '{key}' が見つかりません。スキップします。")
            continue
        exported[key] = {
            "key": card_def["key"],
            "label": card_def.get("label", key),
            "notetype_name": card_def["notetype_name"],
            "model_id": card_def["model_id"],
            "deck_id": card_def["deck_id"],
            "deck_name": card_def["deck_name"],
            "dedup_key": card_def["dedup_key"],
            "fields": card_def["fields"],
            "guid_scheme": {"type": "dedup_key", "prefix": card_def["key"], "dedup_key": card_def["dedup_key"]},
            # card_def_builder.build_deck_from_def()のdue=start_num+offset
            # (2026-08-20。以前は全ノートdue=0だったため、単語デッキの新規
            # カードがすべて同じ位置に積まれていた)。
            "due_scheme": {"type": "sequence"},
            # Ankiのcol.modelsへそのまま入れるJSON(genanki生成、上記docstring参照)
            "anki_model": build_anki_model_json(card_def),
        }

    exported["grammar_multi"] = build_grammar_multi_def()
    exported["shuujuku"] = build_shuujuku_def()
    exported["daily"] = build_daily_def()

    os.makedirs(SHARED_DIR, exist_ok=True)

    # Ankiのスキーマ(schema 11)と、col行の既定値もgenankiから機械的に書き出す。
    # JS側へ手写しすると、genanki更新時に気付かないままズレる恐れがあるため。
    with open(SCHEMA_OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "_comment": (
                    "genanki の apkg_schema/apkg_col から自動生成。直接編集しないこと。"
                    "tools/export_shared_card_defs.py で再生成する。"
                ),
                "genanki_version": getattr(genanki, "__version__", "unknown"),
                "schema_sql": genanki.apkg_schema.APKG_SCHEMA,
                "col_insert_sql": genanki.apkg_col.APKG_COL,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "_comment": (
                    "このファイルは tools/export_shared_card_defs.py が生成します。"
                    "直接編集せず、⚙設定の「カード定義」タブで編集してから"
                    "スクリプトを再実行してください。"
                ),
                "defs": exported,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"書き出しました: {OUT_PATH}")
    for key, d in exported.items():
        print(
            f"  {key}: {d['notetype_name']} / model_id={d['model_id']} / "
            f"fields={len(d['fields'])} / templates={len(d['anki_model']['tmpls'])}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
