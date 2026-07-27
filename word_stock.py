#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
word_stock.py
-------------
「単語」タブ(読書中に出会った未学習の英単語)の候補(item dict)を、
まとめて出力するまでファイルに貯めておくためのモジュール。

shuujuku_stock.pyと同じ設計だが、**完全に別のファイル(word_stock.json)を
使う独立モジュール**。習熟用(音読)カードとは目的が違う(単語だけを覚える
ためのカードで、文法パターンの音読練習ではない)ため、このストックの
中身がshuujuku_stock.jsonに混ざることは絶対にない(2026-07-27、片桐の
明示的な指示)。

【永続化】
このフォルダの word_stock.json に保存する(アプリを閉じても消えない、
shuujuku_stock.jsonと同じ方針)。

【重複防止】
item['word']を正規化(前後空白除去・小文字化)した文字列をキーに、
(a)現在ストック中の項目、(b)過去に出力済みの項目、の両方と重複しない
ようにする(build_word_v1.build_guid()と同じキーの作り方)。

【出力の流れ】
`get_pending()`で読み取り→呼び出し側がbuild_deck()でapkgを実際に生成
できた後に初めて`mark_exported(items)`を呼ぶ、という2段階にしてある
(shuujuku_stock.pyと同じ理由: 生成に失敗した場合にストックが消えない
ようにするため)。
"""

import json
import os

STOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "word_stock.json")


def _word_key(item: dict) -> str:
    return item["word"].strip().lower()


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
    existing_keys = {_word_key(i) for i in stock["pending"]} | set(stock["exported_keys"])

    added = 0
    for item in new_items:
        key = _word_key(item)
        if key in existing_keys:
            continue
        stock["pending"].append(item)
        existing_keys.add(key)
        added += 1

    if added:
        save_stock(stock, path)
    return added


def mark_exported(items: list, path: str = None) -> None:
    """指定したitemたちの単語キーを「出力済み」にし、pendingから取り除く。
    build_deck()でのapkg生成が実際に成功した後に呼ぶこと。"""
    if not items:
        return
    stock = load_stock(path)
    keys_to_remove = {_word_key(i) for i in items}
    stock["exported_keys"].extend(keys_to_remove)
    stock["pending"] = [i for i in stock["pending"] if _word_key(i) not in keys_to_remove]
    save_stock(stock, path)


def clear_pending(path: str = None) -> int:
    """pendingを出力済みにはせず、そのまま破棄する(誤って追加した候補の削除用)。
    戻り値: 破棄した件数。"""
    stock = load_stock(path)
    count = len(stock["pending"])
    stock["pending"] = []
    save_stock(stock, path)
    return count
