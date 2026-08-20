#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
due_counter.py
--------------
カード種別ごとに「次に払い出す cards.due(Ankiの新規カードの位置)」を
`due_counter.json` に永続化する(2026-08-20追加)。
Web版の `docs/lib/dueCounter.js` と同じ役割・同じ既定値。

【なぜ必要か】
このソフトは出力のたびにまっさらな一時apkgを組み立てる設計のため、
以前の出力で使ったdueを知る手段がなく、これまでは

    - word (card_def_builder)          : due を指定せず genanki の既定値 0
    - grammar_multi / daily            : due = itemsのリスト内インデックス(0始まり)

と、**毎回0から振り直して**いた。その結果、別々のバッチで出力したカードが
Anki側で同じ位置に居座り、「1つの質問から作った3問がまとまって出題されず、
他のカードと混ざって出てくる」状態になっていた(2026-08-20、片桐からの報告)。

`shuujuku` は Num フィールドの続き番号(`shuujuku_stock.get_next_num()`)を
そのまま due にも使っており既に連番のため、このモジュールの対象外。
`CLAUDE.md`の「Grammar Multiカード生成との関係」に
「dueは既存デッキの最終due番号から連番、という運用ルールが…実際のAnki
コレクションの現在のdue値を参照する手段がなく」と記録されている、その
運用ルールをカウンタで復活させたもの。

【重要】この値はAnkiコレクション側の実際の位置とは同期しない。
初回は「そのデッキで既に使われている位置の最大値+1」を⚙設定から手で
入れる必要がある(番号は `fix_anki_new_order.py --show` で確認できる)。
"""

import os

import json_store

COUNTER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "due_counter.json")

# 対象のカード種別キー(docs/shared/card_defs.json の defs のキーと同じ)。
COUNTER_KEYS = ("word", "grammar_multi", "daily")

# 設定されていない場合の開始番号。Web版(dueCounter.js)と同じ既定値にすること
# (ここがズレると同じitemsから両者が別のdueのapkgを出してしまう)。
DEFAULT_NEXT_DUE = 1


def _load(path: str = None) -> dict:
    if path is None:
        path = COUNTER_PATH
    data = json_store.read_json(path, {})
    return data if isinstance(data, dict) else {}


def _save(data: dict, path: str = None) -> None:
    if path is None:
        path = COUNTER_PATH
    json_store.write_json(path, data)


def get_next_due(key: str, path: str = None) -> int:
    """次に払い出す開始番号を返す。未設定なら DEFAULT_NEXT_DUE。"""
    value = _load(path).get(key)
    if isinstance(value, int) and value >= 1:
        return value
    return DEFAULT_NEXT_DUE


def set_next_due(key: str, value: int, path: str = None) -> bool:
    """開始番号を明示的に設定する(⚙設定の入力欄用)。
    1未満・整数でない値は拒否してFalseを返す。

    `int(value)`で済ませないのは、Pythonのint()が1.5を黙って1に切り捨てて
    しまい、Web版(dueCounter.js の Number.isInteger)が拒否する値を
    こちら側だけ受け入れてしまうため(2026-08-20、test_due_counter.pyが検出)。
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        if not value.is_integer():
            return False
        n = int(value)
    elif isinstance(value, int):
        n = value
    else:
        try:
            n = int(str(value).strip())
        except (TypeError, ValueError):
            return False
    if n < 1:
        return False
    data = _load(path)
    data[key] = n
    _save(data, path)
    return True


def advance_next_due(key: str, count: int, path: str = None) -> None:
    """開始番号をcount件分進める。

    **apkgの出力が実際に成功した後にだけ呼ぶこと**(mark_exportedと同じ
    タイミング)。失敗したバッチで番号を消費すると、Anki側に存在しない
    番号が飛んでしまうため。"""
    if count <= 0:
        return
    set_next_due(key, get_next_due(key, path) + count, path)


def get_all_next_due(path: str = None) -> dict:
    """全カード種別の現在値を {key: 次の開始番号} で返す(⚙設定の表示用)。"""
    return {key: get_next_due(key, path) for key in COUNTER_KEYS}
