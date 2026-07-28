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

SHARED_DIR = os.path.join(BASE_DIR, "docs", "shared")
OUT_PATH = os.path.join(SHARED_DIR, "card_defs.json")
SCHEMA_OUT_PATH = os.path.join(SHARED_DIR, "anki_schema.json")

# Web版フェーズ1で出力対象にするカード種別。
# daily(DailyConversation)/shuujuku(習熟用)は独自レンダリングロジックを持ち
# card_def_builderの汎用パスに載っていないため、現時点では対象外
# (CLAUDE.mdの「カード定義エディタ」の項を参照)。
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
            # Ankiのcol.modelsへそのまま入れるJSON(genanki生成、上記docstring参照)
            "anki_model": build_anki_model_json(card_def),
        }

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
