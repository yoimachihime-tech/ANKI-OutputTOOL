#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_due_counter.py
-------------------
due_counter.py(2026-08-20追加、新規カードの位置 cards.due の続き番号)と、
それを使う3つのビルダーの採番の回帰テスト。

    python test_due_counter.py

【重要】このテストは**片桐の実データに一切触れない**。due_counter の
保存先を一時フォルダへ差し替えてから実行する(CLAUDE.mdに記録のとおり、
テストで実データを上書き・削除する事故を過去に2回起こしているため、
この差し替えは必ず最初に行うこと)。

【何を守っているか】
以前は出力のたびに due を0から振り直していた(word は全ノート due=0、
grammar_multi/daily は0始まりのインデックス)。そのため別々のバッチで
出力したカードがAnki側で同じ位置に居座り、「1つの質問から作った3問が
まとまって出題されず、他の生成カードと同じ出題形式でまとまって出て
しまう」状態になっていた(片桐からの報告)。このテストは
「出力のたびに件数分だけ進む」「失敗したバッチでは番号を消費しない」
「1未満の値は保存しない」「due = 開始番号 + 並び順」を固定する。
Web版の同じ検証は tools/test_due_counter.mjs にある。
"""

import os
import shutil
import sys
import tempfile

import due_counter

_results = []


def check(label, condition):
    _results.append(bool(condition))
    print(("  OK  " if condition else "  NG  ") + label)


def main():
    tmp_dir = tempfile.mkdtemp(prefix="anki_tool_test_")
    # 実データを触らないよう、最初に保存先を差し替える。
    due_counter.COUNTER_PATH = os.path.join(tmp_dir, "due_counter.json")

    try:
        print("\n[1] 既定値と保存")
        check("未設定なら1から始まる", due_counter.get_next_due("grammar_multi") == 1)
        check("整数を保存できる", due_counter.set_next_due("grammar_multi", 439) is True)
        check("保存した値が読み出せる", due_counter.get_next_due("grammar_multi") == 439)
        check("文字列の数字も受け付ける(入力欄からそのまま渡せる)",
              due_counter.set_next_due("grammar_multi", "500") is True)
        check("文字列でも数値として保存される",
              due_counter.get_next_due("grammar_multi") == 500)

        print("\n[2] 1未満・数値でない値は保存しない")
        due_counter.set_next_due("word", 100)
        for bad in (0, -1, "", "abc", None, 1.5):
            check(f"{bad!r} は拒否する", due_counter.set_next_due("word", bad) is False)
        check("拒否された場合、元の値は壊れていない", due_counter.get_next_due("word") == 100)

        print("\n[3] 出力のたびに件数分だけ進む")
        due_counter.set_next_due("grammar_multi", 439)
        due_counter.advance_next_due("grammar_multi", 3)
        check("3件出力すると次は442から", due_counter.get_next_due("grammar_multi") == 442)
        due_counter.advance_next_due("grammar_multi", 3)
        check("続けて出力しても番号が重ならない",
              due_counter.get_next_due("grammar_multi") == 445)
        due_counter.advance_next_due("grammar_multi", 0)
        check("0件では進まない(出力に失敗したバッチで番号を消費しない)",
              due_counter.get_next_due("grammar_multi") == 445)
        due_counter.advance_next_due("grammar_multi", -5)
        check("負の件数でも戻らない", due_counter.get_next_due("grammar_multi") == 445)

        print("\n[4] カード種別ごとに独立している")
        due_counter.set_next_due("word", 13310)
        due_counter.set_next_due("grammar_multi", 439)
        due_counter.set_next_due("daily", 3)
        due_counter.advance_next_due("word", 10)
        allv = due_counter.get_all_next_due()
        check("word だけが進む", allv["word"] == 13320)
        check("grammar_multi は影響を受けない", allv["grammar_multi"] == 439)
        check("daily も影響を受けない", allv["daily"] == 3)
        check("対象は word / grammar_multi / daily の3種",
              due_counter.COUNTER_KEYS == ("word", "grammar_multi", "daily"))

        print("\n[5] ビルダーが due = 開始番号 + 並び順で採番する")
        try:
            import grammar_multi_builder
        except Exception as e:  # noqa: BLE001
            print(f"  --  genanki が無いためビルダーの検証はスキップ ({e})")
        else:
            items = [
                {"pattern": "選択問題", "question": "q1", "topic_key": "t", "note_index": 0},
                {"pattern": "誤り訂正問題", "question": "q2", "topic_key": "t", "note_index": 1},
                {"pattern": "記述式", "question": "q3", "topic_key": "t", "note_index": 2},
            ]
            deck = grammar_multi_builder.build_deck(items, start_num=439)
            dues = [n.due for n in deck.notes]
            check("grammar_multi: 1問=3ノートが439,440,441と連続する",
                  dues == [439, 440, 441])
            deck = grammar_multi_builder.build_deck(items)
            check("start_numを省略すると1始まり(Web版の既定値と同じ)",
                  [n.due for n in deck.notes] == [1, 2, 3])

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
