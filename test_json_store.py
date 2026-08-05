#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_json_store.py
------------------
json_store.py(2026-08-05追加)と、それを使うようになった6モジュールの
永続化まわりの回帰テスト。

    python test_json_store.py

【重要】このテストは**片桐の実データに一切触れない**。各モジュールの
`STOCK_PATH`/`DEFS_PATH`/`STATE_PATH`/`EXCLUSIONS_PATH`を一時フォルダへ
差し替えてから実行する(CLAUDE.mdに記録のとおり、テストで
shuujuku_stock.jsonを上書き・削除する事故を過去に2回起こしているため、
この差し替えは必ず最初に行うこと)。

【何を守っているか】
以前は6モジュールとも `open(path, "w")` + `json.dump` で直接書いていた。
open("w")は開いた時点で中身を切り捨てるため、書き込み中にプロセスが落ちる・
Google Driveの同期がロックすると中途半端なJSONだけが残り、読み込み側にも
例外処理が無かったため次回以降 JSONDecodeError で操作不能になっていた。
このテストは「壊れても旧版が残る」「壊れたファイルを読んでも落ちない」を
固定する。
"""

import json
import os
import shutil
import sys
import tempfile

import card_defs
import daily_pending_exclusions
import grammar_multi_stock
import json_store
import shuujuku_stock
import tab_notes_state
import word_stock

_results = []


def check(label, condition):
    _results.append(bool(condition))
    print(("  OK  " if condition else "  NG  ") + label)


def main():
    tmp_dir = tempfile.mkdtemp(prefix="anki_tool_test_")
    # 実データを触らないよう、最初に全モジュールの保存先を差し替える。
    word_stock.STOCK_PATH = os.path.join(tmp_dir, "word_stock.json")
    shuujuku_stock.STOCK_PATH = os.path.join(tmp_dir, "shuujuku_stock.json")
    grammar_multi_stock.STOCK_PATH = os.path.join(tmp_dir, "grammar_multi_stock.json")
    card_defs.DEFS_PATH = os.path.join(tmp_dir, "card_defs.json")
    tab_notes_state.STATE_PATH = os.path.join(tmp_dir, "tab_notes_state.json")
    daily_pending_exclusions.EXCLUSIONS_PATH = os.path.join(tmp_dir, "exclusions.json")

    try:
        print("\n[1] json_store の基本動作")
        path = os.path.join(tmp_dir, "basic.json")
        json_store.write_json(path, {"word": "テスト", "n": 1})
        check("write→read の往復で日本語がそのまま残る(ensure_ascii=False)",
              json_store.read_json(path, None) == {"word": "テスト", "n": 1})
        check("一時ファイルを残さない",
              [f for f in os.listdir(tmp_dir) if f.endswith(".tmp")] == [])
        check("ファイルが無ければ既定値を返す",
              json_store.read_json(os.path.join(tmp_dir, "none.json"), {"x": 1}) == {"x": 1})

        print("\n[2] 壊れたJSONを読んでも落ちない(旧実装はJSONDecodeErrorで停止した)")
        broken = os.path.join(tmp_dir, "broken.json")
        with open(broken, "w", encoding="utf-8") as f:
            f.write('{"pending": [{"word": "書きかけで落ちた')
        check("例外を投げず既定値を返す",
              json_store.read_json(broken, {"pending": []}) == {"pending": []})
        check("壊れたファイルを .corrupt へ退避する", os.path.exists(broken + ".corrupt"))
        with open(broken + ".corrupt", encoding="utf-8") as f:
            check(".corrupt の中身は元のまま(手作業で救出できる)",
                  f.read().startswith('{"pending"'))

        print("\n[3] 書き込みが失敗しても既存ファイルを壊さない(アトミック性)")
        keep = os.path.join(tmp_dir, "keep.json")
        json_store.write_json(keep, {"version": "旧版"})

        class NotJsonSerializable:
            pass

        try:
            json_store.write_json(keep, {"version": NotJsonSerializable()})
        except TypeError:
            pass  # json.dump が途中で失敗する = 書き込み中に落ちた状況の代役
        check("失敗しても既存ファイルは旧版のまま無傷",
              json_store.read_json(keep, None) == {"version": "旧版"})
        check("失敗した書き込みの一時ファイルも残さない",
              [f for f in os.listdir(tmp_dir) if f.endswith(".tmp")] == [])

        print("\n[4] 各モジュールが json_store 経由でも従来どおり動く")
        word_stock.add_pending_items([{"word": "slated", "meaning": "予定された"}])
        check("word_stock: 追加→読み出し",
              [i["word"] for i in word_stock.get_pending()] == ["slated"])

        shuujuku_stock.add_pending_items([{
            "pattern": "She doesn't 動詞",
            "examples": [("She doesn't smoke.", "彼女はたばこを吸わない。")],
            "source_key": ("chat", "質問"),
        }])
        check("shuujuku_stock: examples が tuple へ復元される(build_deck側の期待)",
              shuujuku_stock.get_pending()[0]["examples"]
              == [("She doesn't smoke.", "彼女はたばこを吸わない。")])

        grammar_multi_stock.add_pending_items([
            {"pattern": "選択問題", "source_key": ("chat_grammar", "topic::0")},
        ])
        check("grammar_multi_stock: 追加→読み出し",
              len(grammar_multi_stock.get_pending()) == 1)

        card_defs.save_defs({"defs": {"word": {"key": "word", "editable": True}}})
        check("card_defs: 追加→読み出し",
              card_defs.load_defs()["defs"]["word"]["key"] == "word")

        tab_notes_state.save_tab_state("word", {"apkg": "pending_decks/word.apkg"})
        check("tab_notes_state: 追加→読み出し",
              tab_notes_state.load_all()["word"]["apkg"] == "pending_decks/word.apkg")

        daily_pending_exclusions.add_excluded_id("row-1")
        check("daily_pending_exclusions: 追加→読み出し",
              daily_pending_exclusions.load_excluded_ids() == {"row-1"})

        print("\n[5] ストックが壊れていてもアプリが起動できる")
        for label, path, reader in [
            ("word_stock", word_stock.STOCK_PATH, word_stock.get_pending),
            ("shuujuku_stock", shuujuku_stock.STOCK_PATH, shuujuku_stock.get_pending),
            ("grammar_multi_stock", grammar_multi_stock.STOCK_PATH,
             grammar_multi_stock.get_pending),
        ]:
            with open(path, "w", encoding="utf-8") as f:
                f.write("{途中で切れたJSON")
            check(f"壊れた {label}.json でも空として読める", reader() == [])

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    print()
    if all(_results):
        print(f"✅ 全テスト成功 ({len(_results)} 件)")
        return 0
    print(f"❌ {_results.count(False)} 件失敗 ({len(_results)} 件中)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
