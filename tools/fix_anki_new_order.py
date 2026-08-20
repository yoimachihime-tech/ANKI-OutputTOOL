#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/fix_anki_new_order.py
---------------------------
Ankiコレクションを直接読み書きして、新規カードの「位置」(cards.due)を
確認・修正するスクリプト(2026-08-20追加)。

【なぜ必要か】
このソフトが出力する.apkgのdueは due_counter.py(Web版はdocs/lib/dueCounter.js)
が採番するが、その値は**Ankiコレクション側の実際の位置とは同期しない**。
初回や、Anki側で位置を振り直した後は、⚙設定「新規カードの位置」へ
「そのデッキで既に使われている最大値+1」を入れる必要がある。
その番号を調べるのがこのスクリプトの主目的(--show)。

またAnkiの既定のデッキ設定「新規カードの並び順」は
`カードの種類、その後集めた順`で、集めた新規カードを**テンプレート番号順に
並べ替えてしまう**。この設定のままだとdueをどう振っても、同じ出題形式の
カードがまとまって出題される(片桐からの報告の直接の原因)。
このスクリプトはプリセットを`集めた順番`へ変更する処理も行う。

【使い方】Ankiを終了してから(--show だけは起動中でも可)
    set PY=C:/Users/<user>/AppData/Local/AnkiProgramFiles/.venv/Scripts/python.exe
    set COL=C:/Users/<user>/AppData/Roaming/Anki2/ユーザー 1/collection.anki2
    %PY% tools/fix_anki_new_order.py "%COL%" --deck "02.単語・MindTips" --show
    %PY% tools/fix_anki_new_order.py "%COL%" --deck "02.単語・MindTips::文法・用法" --append

オプション
    --show        デッキごとの位置と「次の開始番号」を表示して終了(書き込み無し)
    --deck NAME   対象デッキ(:: 区切り、配下のサブデッキを含む)。省略時は全デッキ
    --append      整列済みのブロックは動かさず、未整列のブロックだけを末尾へ
    --start N     位置の開始番号を手動指定(--append と併用可)
    --dry-run     変更内容の表示のみ
    --no-preset   デッキプリセット(並び順設定)は変更しない

必要なもの: `anki` パッケージ(デッキプリセットがprotobufで保存されているため)。
Anki本体のvenv(AnkiProgramFiles/.venv)のpythonで実行するのが確実。
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import time

from anki import deck_config_pb2 as dc

SEP = chr(31)  # Ankiのデッキ名の区切り文字
SORT_NO_SORT = dc.DeckConfig.Config.NEW_CARD_SORT_ORDER_NO_SORT


def opt(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def connect(path):
    """Anki独自の照合順序 unicase を登録した接続を返す
    (decks.name の索引がこれを使っており、素のsqlite3では
    `no such collation sequence: unicase` で読めないため)。"""
    db = sqlite3.connect(path)
    db.create_collation(
        "unicase",
        lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()),
    )
    return db


def open_snapshot(path):
    """Anki起動中でも読めるよう、WALごと一時コピーして開く。"""
    tmpdir = tempfile.mkdtemp(prefix="anki_show_")
    base = os.path.join(tmpdir, "collection.anki2")
    shutil.copy2(path, base)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(path + suffix):
            shutil.copy2(path + suffix, base + suffix)
    return connect(base), tmpdir


def is_aligned(dues):
    """1ノート分の新規カード(ブロック)が整列済みかを判定する。

    整列済みなら兄弟カードの位置はすべて相異なる。生成ツールが
    1ノート1番号で出力した直後は兄弟が同じ位置を共有するので区別できる。
    「連続していること」は条件にしない(兄弟の一部を学習すると自然に穴が
    空くため、連続性を求めると学習済みのブロックを誤検出してしまう)。
    """
    return len(set(dues)) == len(dues)


def target_deck_ids(cur, deck_name):
    key = deck_name.replace("::", SEP)
    return [
        did for did, name in cur.execute("select id, name from decks").fetchall()
        if name == key or name.startswith(key + SEP)
    ]


def show_decks(cur, deck_name=None):
    """デッキごとの新規カードの位置と、次に使うべき開始番号を表示する。"""
    names = dict(cur.execute("select id, name from decks").fetchall())
    raw = cur.execute(
        "select did, count(*), min(due), max(due) from cards"
        " where type = 0 group by did"
    ).fetchall()
    rows = [(did, names.get(did, str(did)), c, mn, mx) for did, c, mn, mx in raw]
    if deck_name:
        key = deck_name.replace("::", SEP)
        rows = [r for r in rows if r[1] == key or r[1].startswith(key + SEP)]
    if not rows:
        print("新規カードを持つデッキがありません。")
        return

    collide = {}
    shared_pos = {}
    for did, _name, _c, _mn, _mx in rows:
        blocks = {}
        for nid, due in cur.execute(
            "select nid, due from cards where type = 0 and did = ?", (did,)
        ):
            blocks.setdefault(nid, []).append(due)
        owners = {}
        for nid, dues in blocks.items():
            for due in set(dues):
                owners.setdefault(due, set()).add(nid)
        bad = set()
        for _due, nids in owners.items():
            if len(nids) > 1:
                bad |= nids
        collide[did] = len(bad)
        shared_pos[did] = sum(1 for v in blocks.values() if not is_aligned(v))

    width = max(len(r[1].replace(SEP, " > ")) for r in rows)
    print("デッキ".ljust(width)
          + "   新規   位置min   位置max   次の開始番号   位置衝突   兄弟同番")
    print("-" * (width + 58))
    for did, name, cnt, mn, mx in sorted(rows, key=lambda r: r[1]):
        print(name.replace(SEP, " > ").ljust(width)
              + str(cnt).rjust(7) + str(mn).rjust(9) + str(mx).rjust(10)
              + str(mx + 1).rjust(14) + str(collide[did]).rjust(10)
              + str(shared_pos[did]).rjust(10))
    print()
    print("位置衝突 = 別ノート同士が同じ位置を使っているノート数。"
          "1以上だとその分が交互に出題されます(要修正)。")
    print("兄弟同番 = 1ノート内の複数カードが同じ位置を共有しているノート数。"
          "位置衝突が0なら問題ありません。")
    for did, name, cnt, _mn, mx in rows:
        if mx > max(cnt * 10, 1000):
            print("注意: " + name.replace(SEP, " > ") + " は位置が大きく飛んでいます"
                  + "(新規 " + str(cnt) + " 枚に対して位置max " + str(mx) + ")。"
                  + " --start 1 を --append なしで実行すると1から詰め直せます。")
    print("「次の開始番号」を⚙設定「新規カードの位置」へ入れてください"
          "(Web版は設定画面の同じ項目)。位置はデッキ単位で見れば十分です"
          "(Ankiは新規カードをデッキごとに集めるため)。")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    deck_name = opt("--deck")
    if deck_name in args:
        args.remove(deck_name)
    start_arg = opt("--start")
    if start_arg in args:
        args.remove(start_arg)
    dry = "--dry-run" in sys.argv
    do_preset = "--no-preset" not in sys.argv
    append = "--append" in sys.argv
    show = "--show" in sys.argv

    if not args:
        print(__doc__)
        return 1
    path = args[0]
    if not os.path.exists(path):
        print("ファイルが見つかりません: " + path)
        return 1

    if show:  # 読み取りのみ。Anki起動中でも可
        db, tmpdir = open_snapshot(path)
        try:
            show_decks(db.cursor(), deck_name)
        finally:
            db.close()
            shutil.rmtree(tmpdir, ignore_errors=True)
        return 0

    for suffix in ("-wal", "-journal"):
        if os.path.exists(path + suffix):
            print("警告: " + os.path.basename(path) + suffix
                  + " が存在します。Ankiを終了してから実行してください。")

    if not dry:
        backup = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, backup)
        print("[backup] " + backup)

    db = connect(path)
    cur = db.cursor()
    now = int(time.time())

    if deck_name:
        dids = target_deck_ids(cur, deck_name)
        if not dids:
            print("デッキが見つかりません: " + deck_name)
            return 1
        print("[scope] 対象デッキ " + str(len(dids)) + " 件: " + deck_name + " (配下含む)")
        ph = ",".join("?" * len(dids))
        rows = cur.execute(
            "select id, nid, ord, due from cards where type = 0 and did in ("
            + ph + ")", dids
        ).fetchall()
    else:
        print("[scope] 全デッキ")
        rows = cur.execute("select id, nid, ord, due from cards where type = 0").fetchall()

    blocks = {}
    for cid, nid, ordn, due in rows:
        blocks.setdefault(nid, []).append((ordn, cid, due))

    start_pos = 1
    if append:
        done, todo = [], []
        for nid, cards in blocks.items():
            (done if is_aligned([t[2] for t in cards]) else todo).append((nid, cards))
        if not todo:
            print("[append] 未整列のブロックはありません(変更なし)")
            order = []
        else:
            start_pos = max((t[2] for _n, cs in done for t in cs), default=0) + 1
            order = sorted(todo, key=lambda kv: kv[0])  # ノート作成順に末尾へ追加
            print("[append] 整列済み " + str(len(done)) + " ブロックは据え置き / "
                  + "未整列 " + str(len(todo)) + " ブロックを位置 "
                  + str(start_pos) + " 以降へ追加")
    else:
        # ブロックの並び = 現在の最小due -> ノートID(既存の意図した順序を保つ)
        order = sorted(blocks.items(), key=lambda kv: (min(t[2] for t in kv[1]), kv[0]))

    if start_arg is not None:
        start_pos = int(start_arg)
        print("[start] 開始番号を手動指定: " + str(start_pos))

    pos = start_pos
    updates = []
    for _nid, cards in order:
        for _ordn, cid, _due in sorted(cards):  # ノート内はテンプレート順
            updates.append((pos, now, cid))
            pos += 1

    sizes = {}
    for _nid, cards in order:
        sizes[len(cards)] = sizes.get(len(cards), 0) + 1
    print("[due] 新規カード " + str(len(updates)) + " 枚 / " + str(len(order))
          + " ブロック -> 位置 " + str(start_pos) + ".." + str(pos - 1))
    print("[due] ブロックの大きさ内訳: " + str(dict(sorted(sizes.items()))))
    if not dry:
        cur.executemany("update cards set due = ?, mod = ?, usn = -1 where id = ?", updates)

    if do_preset:
        for conf_id, name, blob in cur.execute(
            "select id, name, config from deck_config"
        ).fetchall():
            cfg = dc.DeckConfig.Config()
            cfg.ParseFromString(blob)
            if cfg.new_card_sort_order == SORT_NO_SORT:
                print("[preset] id=" + str(conf_id) + " " + repr(name) + ": 変更不要")
                continue
            print("[preset] id=" + str(conf_id) + " " + repr(name)
                  + ": new_card_sort_order " + str(cfg.new_card_sort_order)
                  + " -> " + str(SORT_NO_SORT) + " (集めた順番)")
            if not dry:
                cfg.new_card_sort_order = SORT_NO_SORT
                cur.execute(
                    "update deck_config set config = ?, mtime_secs = ?, usn = -1 where id = ?",
                    (cfg.SerializeToString(), now, conf_id),
                )

    if not dry:
        cur.execute("update col set mod = ?", (now * 1000,))
        db.commit()
        print("完了。⚙設定「新規カードの位置」の開始番号も更新してください"
              "(--show で新しい値を確認できます)。")
    else:
        print("(--dry-run のため書き込みなし)")
    db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
