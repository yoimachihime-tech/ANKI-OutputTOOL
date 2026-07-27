#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
shuujuku_stock.py
------------------
「習熟用(音読)」カードの候補(item dict)を、まとめて出力するまで
ファイルに貯めておくためのモジュール。DailyConversationタブ・AIに質問タブ
の両方から候補が追加され、「習熟用」タブの「まとめて出力」でまとめて
build_shuujuku_v1.build_deck()に渡す。

【永続化】
このフォルダの shuujuku_stock.json に保存する。アプリを閉じても消えない
(2026-07-24時点でのユーザー方針)。

【重複の扱い(2026-07-27変更)】
以前はitem['source_key'](build_shuujuku_v1.build_guid()と同じ
("chat"|"dailyconv", 値)のタプル)を文字列化したものをキーに、(a)現在
ストック中の項目、(b)過去に出力済みの項目、と重複する場合はadd_pending_items
が黙ってスキップしていた。word_stock.pyと同じ理由(「生成には成功したのに
ストックに増えない」という分かりにくい状態を避けるため)で、**重複していても
常に追加し**、`find_duplicate_pending_indices()`で重複しているインデックスを
検出できるようにした。片桐が`tts_gui.py`側で重複を視覚的にハイライトし、
`remove_pending_at()`で手動削除できるようにする想定。

【出力の流れ(重要)】
`get_pending()`で読み取り→呼び出し側がbuild_deck()でapkgを実際に生成
できた後に初めて`mark_exported(items)`を呼ぶ、という2段階にしてある。
生成に失敗した場合にストックが消えてしまわないようにするため。
"""

import json
import os

STOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shuujuku_stock.json")


def _source_key_str(item: dict) -> str:
    kind, key = item["source_key"]
    return f"{kind}:{key}"


def load_stock(path: str = None) -> dict:
    """{"pending": [item, ...], "exported_keys": [str, ...]} を返す。
    ファイルが無ければ空の状態を返す。"""
    if path is None:
        path = STOCK_PATH
    if not os.path.exists(path):
        return {"pending": [], "exported_keys": []}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("pending", [])
    data.setdefault("exported_keys", [])
    # JSON化の際にexamplesがtupleからlistになるので、build_deck側の期待に
    # 合わせてtupleへ戻しておく
    for item in data["pending"]:
        item["examples"] = [tuple(ex) for ex in item.get("examples", [])]
    return data


def save_stock(stock: dict, path: str = None) -> None:
    if path is None:
        path = STOCK_PATH
    with open(path, "w", encoding="utf-8") as f:
        json.dump(stock, f, ensure_ascii=False, indent=2)


def get_pending(path: str = None) -> list:
    return load_stock(path)["pending"]


def add_pending_items(new_items: list, path: str = None) -> int:
    """new_itemsを常にpendingへ追加する(重複していてもスキップしない、
    2026-07-27変更)。戻り値: 追加した件数(= len(new_items))。
    重複の検出・表示は find_duplicate_pending_indices() の責務とする。"""
    if not new_items:
        return 0
    stock = load_stock(path)
    stock["pending"].extend(new_items)
    save_stock(stock, path)
    return len(new_items)


def find_duplicate_pending_indices(path: str = None) -> set:
    """現在のpendingのうち、(a)pending内に同じsource_keyの項目が複数ある、
    または(b)既にexported_keys(出力済み)と同じsource_keyを持つ、のいずれかに
    該当するインデックスの集合を返す。UI側でハイライト表示する用途。"""
    stock = load_stock(path)
    pending = stock["pending"]
    exported = set(stock["exported_keys"])

    key_counts = {}
    for item in pending:
        key = _source_key_str(item)
        key_counts[key] = key_counts.get(key, 0) + 1

    dup_indices = set()
    for i, item in enumerate(pending):
        key = _source_key_str(item)
        if key_counts[key] > 1 or key in exported:
            dup_indices.add(i)
    return dup_indices


def remove_pending_at(index: int, path: str = None):
    """pendingの指定インデックスの項目を1件だけ破棄する(出力済みにはしない、
    単純な削除)。範囲外のインデックスの場合は何もせずNoneを返す。
    戻り値: 削除した項目のdict、またはNone。"""
    stock = load_stock(path)
    if index < 0 or index >= len(stock["pending"]):
        return None
    removed = stock["pending"].pop(index)
    save_stock(stock, path)
    return removed


def mark_exported(items: list, path: str = None) -> None:
    """指定したitemたちのsource_keyを「出力済み」にし、pendingから取り除く。
    build_deck()でのapkg生成が実際に成功した後に呼ぶこと。"""
    if not items:
        return
    stock = load_stock(path)
    keys_to_remove = {_source_key_str(i) for i in items}
    stock["exported_keys"].extend(keys_to_remove)
    stock["pending"] = [i for i in stock["pending"] if _source_key_str(i) not in keys_to_remove]
    save_stock(stock, path)


def clear_pending(path: str = None) -> int:
    """pendingを出力済みにはせず、そのまま破棄する(誤って追加した候補の削除用)。
    戻り値: 破棄した件数。"""
    stock = load_stock(path)
    count = len(stock["pending"])
    stock["pending"] = []
    save_stock(stock, path)
    return count
