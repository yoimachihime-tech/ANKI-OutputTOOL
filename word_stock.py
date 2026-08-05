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

【重複の扱い(2026-07-27変更)】
以前はitem['word']を正規化(前後空白除去・小文字化)した文字列をキーに、
(a)現在ストック中の項目、(b)過去に出力済みの項目、と重複する場合は
add_pending_itemsが黙ってスキップしていた。しかし「AIによる生成には成功した
のにストックに増えない」という状態が分かりにくく誤解を招く(実際に2回
問い合わせを受けた)ため、**重複していても常に追加し**、代わりに
`find_duplicate_pending_indices()`で重複しているインデックスを検出できる
ようにした。片桐が`tts_gui.py`側で重複を視覚的にハイライトし、
`remove_pending_at()`で手動削除できるようにする想定(キー自体は
build_word_v1.build_guid()と同じ作り方を踏襲)。

【出力の流れ】
`get_pending()`で読み取り→呼び出し側がbuild_deck()でapkgを実際に生成
できた後に初めて`mark_exported(items)`を呼ぶ、という2段階にしてある
(shuujuku_stock.pyと同じ理由: 生成に失敗した場合にストックが消えない
ようにするため)。
"""

import os

import json_store

STOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "word_stock.json")


def _word_key(item: dict) -> str:
    return item["word"].strip().lower()


def load_stock(path: str = None) -> dict:
    """{"pending": [item, ...], "exported_keys": [str, ...]} を返す。
    ファイルが無ければ空の状態を返す。"""
    if path is None:
        path = STOCK_PATH
    data = json_store.read_json(path, {"pending": [], "exported_keys": []})
    data.setdefault("pending", [])
    data.setdefault("exported_keys", [])
    return data


def save_stock(stock: dict, path: str = None) -> None:
    if path is None:
        path = STOCK_PATH
    # 一時ファイル + os.replace によるアトミック書き込み(2026-08-05)。
    # 以前は open(path, "w") で直接切り詰めていたため、書き込み中に落ちると
    # 片桐の未出力データが失われた。詳細は json_store.py の説明を参照。
    json_store.write_json(path, stock)


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
    """現在のpendingのうち、(a)pending内に同じキーの項目が複数ある、
    または(b)既にexported_keys(出力済み)と同じキーを持つ、のいずれかに
    該当するインデックスの集合を返す。UI側でハイライト表示する用途。"""
    stock = load_stock(path)
    pending = stock["pending"]
    exported = set(stock["exported_keys"])

    key_counts = {}
    for item in pending:
        key = _word_key(item)
        key_counts[key] = key_counts.get(key, 0) + 1

    dup_indices = set()
    for i, item in enumerate(pending):
        key = _word_key(item)
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
