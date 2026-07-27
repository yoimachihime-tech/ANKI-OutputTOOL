#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
grammar_multi_stock.py
------------------------
「AIに質問」タブの候補(item dict)を、まとめて出力するまでファイルに
貯めておくためのモジュール。word_stock.py/shuujuku_stock.pyと同じ設計だが、
**完全に別のファイル(grammar_multi_stock.json)を使う独立モジュール**。

【2026-07-27changed: 「AIに質問」タブの出力先変更】
以前は「AIに質問」タブの生成結果もshuujuku_stock.json(習熟用/ATSU方式、
音読練習用)に追加していたが、「習熟用タブに飛ぶ内容と同じでダブっている」
との指摘を受け、「AIに質問」は知識を深めるための出題形式(Grammar Multi:
選択問題/誤り訂正問題/記述式・書き換え問題)を独立して持つよう変更した。
そのためこのストックの中身がshuujuku_stock.jsonに混ざることはない。

【永続化】
このフォルダの grammar_multi_stock.json に保存する(shuujuku_stock.json等と
同じ理由でgit管理対象外)。

【重複の扱い】
word_stock.py/shuujuku_stock.pyと同じ理由(「生成には成功したのにストックに
増えない」という分かりにくい状態を避けるため)で、**重複していても常に
追加し**、`find_duplicate_pending_indices()`で重複しているインデックスを
検出できるようにした。ハイライト・手動削除はtts_gui.py側の責務。

重複キーは`topic_key`(質問文を正規化したもの)+`note_index`の組。1つの
質問から独立ノートを複数(既定3枚)作るため、`pattern`フィールドは
「選択問題」のような出題形式ラベルに過ぎず内容の識別には使えない
(shuujuku_stock.pyのようなpattern類似度による重複検出はここでは行わない)。

【出力の流れ】
`get_pending()`で読み取り→呼び出し側がgrammar_multi_builder.build_deck()で
apkgを実際に生成できた後に初めて`mark_exported(items)`を呼ぶ、という
2段階にしてある(他のストックと同じ理由: 生成に失敗した場合にストックが
消えてしまわないようにするため)。
"""

import json
import os

STOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "grammar_multi_stock.json")


def _item_key(item: dict) -> str:
    return f"{item.get('topic_key', '')}::{item.get('note_index', '')}"


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
    """new_itemsを常にpendingへ追加する(重複していてもスキップしない)。
    戻り値: 追加した件数(= len(new_items))。
    重複の検出・表示は find_duplicate_pending_indices() の責務とする。"""
    if not new_items:
        return 0
    stock = load_stock(path)
    stock["pending"].extend(new_items)
    save_stock(stock, path)
    return len(new_items)


def find_duplicate_pending_indices(path: str = None) -> set:
    """現在のpendingのうち、(a)pending内に同じキー(topic_key::note_index)の
    項目が複数ある、または(b)既にexported_keys(出力済み)と同じキーを持つ、
    のいずれかに該当するインデックスの集合を返す。UI側でハイライト表示する
    用途。"""
    stock = load_stock(path)
    pending = stock["pending"]
    exported = set(stock["exported_keys"])

    key_counts = {}
    for item in pending:
        key = _item_key(item)
        key_counts[key] = key_counts.get(key, 0) + 1

    dup_indices = set()
    for i, item in enumerate(pending):
        key = _item_key(item)
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
    """指定したitemたちのキーを「出力済み」にし、pendingから取り除く。
    grammar_multi_builder.build_deck()でのapkg生成が実際に成功した後に
    呼ぶこと。"""
    if not items:
        return
    stock = load_stock(path)
    keys_to_remove = {_item_key(i) for i in items}
    stock["exported_keys"].extend(keys_to_remove)
    stock["pending"] = [i for i in stock["pending"] if _item_key(i) not in keys_to_remove]
    save_stock(stock, path)


def clear_pending(path: str = None) -> int:
    """pendingを出力済みにはせず、そのまま破棄する(誤って追加した候補の削除用)。
    戻り値: 破棄した件数。"""
    stock = load_stock(path)
    count = len(stock["pending"])
    stock["pending"] = []
    save_stock(stock, path)
    return count
