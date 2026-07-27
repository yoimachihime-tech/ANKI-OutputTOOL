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

【重複防止】
item['source_key'](build_shuujuku_v1.build_guid()と同じ("chat"|"dailyconv", 値)
のタプル)を文字列化したものをキーに、(a)現在ストック中の項目、(b)過去に
出力済みの項目、の両方と重複しないようにする。出力済みのsource_keyは
無期限に保持し、同じ行・同じ質問から二重に候補が作られるのを防ぐ。

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
    """new_itemsのうち、まだストックにも出力済みにも無いものだけを追加する。
    戻り値: 実際に追加した件数。"""
    stock = load_stock(path)
    existing_keys = {_source_key_str(i) for i in stock["pending"]} | set(stock["exported_keys"])

    added = 0
    for item in new_items:
        key = _source_key_str(item)
        if key in existing_keys:
            continue
        stock["pending"].append(item)
        existing_keys.add(key)
        added += 1

    if added:
        save_stock(stock, path)
    return added


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
