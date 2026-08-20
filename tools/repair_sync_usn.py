#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/repair_sync_usn.py
-------------------------
「同期のたびに大量のデータをダウンロードし直す」状態を直すスクリプト。

【何が起きていたか(2026-08-20の不具合)】
`col`テーブルの`usn`列は、**最後に同期が成功した時点のサーバ側USN**を
覚えておくための値で、notes/cards/revlogの`usn = -1`(=ローカルで変更した、
未アップロード)とは意味がまったく違う。

ところが`tools/migrate_shuujuku_notetype.py`の初版が、スキーマ変更を知らせる
つもりで `update col set scm=?, mod=?, usn=-1` と**colの方まで-1にして
しまった**。これで「この端末は USN -1 の時点までしか同期していない」という
状態になり、以後の同期のたびにサーバが「USN -1 より新しい行」——つまり
コレクションのほぼ全体——を送り直してくるようになった。

実際の被害(片桐のコレクション):
    col.usn = 5 に対して usn がそれより大きい行が 175,166 件
    (notes 6,153 / cards 8,399 / revlog 160,614)
移行前のバックアップでは col.usn = 15613 / 行のusn最大 = 15611 で、
「col.usn >= すべての行のusn」という関係が保たれていた。

【直し方】
行側のusnを`col.usn`まで下げて上の関係を復元する。usnは同期の記帳専用の
列で、カードの内容・スケジューリング・復習履歴には一切関係しない。

そのうえで`col.scm`(スキーマ更新時刻)を進め、次の同期でAnkiに全同期を
要求させる。**サーバ側にも古いusnのままの行が残っているため、ローカルを
直すだけでは不十分で、「アップロード」でサーバを作り直す必要がある**
(2026-08-20 16:58の全同期が効かなかったのはこのため。あのときは
アップロードでサーバのファイルを差し替えたが、中身の行のusnは大きいままで、
col.usnだけが小さい値に戻っていた)。

【実行方法】
Ankiを終了してから、`anki`パッケージのある実行環境で:

    "...\\AnkiProgramFiles\\.venv\\Scripts\\python.exe" tools/repair_sync_usn.py
    ...同上... tools/repair_sync_usn.py --apply

実行後にAnkiを起動して同期し、**「アップロード」**を選ぶこと。
他の端末では次回の同期で「ダウンロード」を選ぶ。

なお`anki`パッケージは実際には使わない(sqlite3だけで完結する)ので、
どのPythonでも動く。Ankiのvenvを指定しているのは他のツールと揃えるため。
"""

import argparse
import datetime
import glob
import os
import shutil
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")

# usn列を持ち、同期の対象になるテーブル。decks/notetypes/config等も usn を
# 持つが、件数が少なく実害が出ていないため、ここでは大量に溜まる3つに絞る
# (下見では全テーブルの状況を表示する)。
REPAIR_TABLES = ("notes", "cards", "revlog", "graves")


class RepairError(Exception):
    pass


def connect(col_path: str) -> sqlite3.Connection:
    """collection.anki2 用のsqlite3接続(unicase照合順序つき)。"""
    con = sqlite3.connect(col_path)
    con.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    return con


def find_collection_path(explicit: str = None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            raise RepairError(f"コレクションが見つかりません: {explicit}")
        return explicit
    pattern = os.path.join(os.path.expandvars(r"%APPDATA%"), "Anki2", "*", "collection.anki2")
    found = sorted(glob.glob(pattern))
    if not found:
        raise RepairError("Ankiのコレクションが見つかりません。--collection で指定してください。")
    if len(found) > 1:
        raise RepairError(
            "Ankiのプロファイルが複数あります。--collection で指定してください:\n  "
            + "\n  ".join(found)
        )
    return found[0]


def assert_not_locked(col_path: str) -> None:
    try:
        con = sqlite3.connect(col_path, timeout=1.0)
        try:
            con.execute("begin exclusive")
            con.execute("rollback")
        finally:
            con.close()
    except sqlite3.OperationalError as e:
        raise RepairError(f"コレクションがロックされています({e})。Ankiを終了してから実行してください。")


def survey(con: sqlite3.Connection, verbose=print) -> tuple:
    """(col.usn, {テーブル: col.usnより大きいusnの件数}) を返し、状況を表示する。"""
    col_usn = con.execute("select usn from col").fetchone()[0]
    verbose(f"col.usn = {col_usn}(最後に同期が成功した時点のサーバ側USN)\n")
    verbose(f"  {'テーブル':<12}{'行数':>9}{'usn最大':>9}{'col.usnより大':>14}{'未同期(-1)':>11}")
    over = {}
    for (name,) in con.execute("select name from sqlite_master where type='table' order by name"):
        cols = [r[1] for r in con.execute(f"pragma table_info({name})")]
        if "usn" not in cols:
            continue
        total = con.execute(f"select count(*) from {name}").fetchone()[0]
        mx = con.execute(f"select max(usn) from {name}").fetchone()[0]
        gt = con.execute(f"select count(*) from {name} where usn>?", (col_usn,)).fetchone()[0]
        pending = con.execute(f"select count(*) from {name} where usn=-1").fetchone()[0]
        verbose(f"  {name:<12}{total:>9}{str(mx):>9}{gt:>14}{pending:>11}")
        if name in REPAIR_TABLES and gt:
            over[name] = gt
    verbose("")
    return col_usn, over


def repair(col_path: str, apply: bool, backup_dir: str, verbose=print) -> int:
    verbose(f"コレクション: {col_path}")
    assert_not_locked(col_path)

    con = connect(col_path)
    try:
        col_usn, over = survey(con, verbose)
    finally:
        con.close()

    total_over = sum(over.values())
    if not total_over:
        verbose(
            "col.usnより新しいusnを持つ行はありません。この症状(同期のたびに"
            "大量ダウンロード)の原因はここにはありません。"
        )
        return 0

    verbose(
        f"直す対象: {total_over:,} 件 "
        f"({' / '.join(f'{k} {v:,}' for k, v in over.items())})\n"
        "これらの行のusnを col.usn まで下げ、col.scm を進めて全同期を要求させます。\n"
        "usnは同期の記帳専用の列で、カードの内容・スケジューリング・復習履歴には\n"
        "一切関係しません。"
    )
    if not apply:
        verbose("\n[下見のみ] 何も書き換えていません。実際に直すには --apply を付けてください。")
        return 0

    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"collection_before_usn_repair_{stamp}.anki2")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(col_path + suffix):
            shutil.copy2(col_path + suffix, backup_path + suffix)
    verbose(f"\nバックアップを作成しました: {backup_path}")

    now_ms = int(datetime.datetime.now().timestamp() * 1000)
    con = connect(col_path)
    try:
        cards_before = con.execute("select count(*) from cards").fetchone()[0]
        revlog_before = con.execute("select count(*) from revlog").fetchone()[0]
        for name in over:
            con.execute(f"update {name} set usn=? where usn>?", (col_usn, col_usn))
        # スキーマ更新時刻だけを進める(colのusnは触らない。ここを-1にしたのが
        # 今回の不具合の原因だった)。
        con.execute("update col set scm=?, mod=?", (now_ms, now_ms))
        con.commit()

        verbose("")
        col_usn_after, over_after = survey(con, verbose)
        cards_after = con.execute("select count(*) from cards").fetchone()[0]
        revlog_after = con.execute("select count(*) from revlog").fetchone()[0]
        integrity = con.execute("pragma integrity_check").fetchone()[0]
    finally:
        con.close()

    verbose(f"cards: {cards_before} → {cards_after}(変わらないこと)")
    verbose(f"revlog: {revlog_before} → {revlog_after}(変わらないこと)")
    verbose(f"integrity_check: {integrity}")
    if cards_before != cards_after or revlog_before != revlog_after:
        raise RepairError("件数が変わっています。バックアップから戻してください: " + backup_path)
    if over_after:
        raise RepairError(f"直しきれていません: {over_after}")

    verbose(
        "\n完了しました。Ankiを起動して同期し、**「アップロード」**を選んでください"
        "(サーバ側にも古いusnの行が残っているため、ローカルを直すだけでは"
        "再発します)。他の端末では次回の同期で「ダウンロード」を選んでください。"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="同期のたびに大量ダウンロードが発生する状態(col.usnと行のusnの不整合)を直す。"
    )
    parser.add_argument("--collection", help="collection.anki2のパス(既定: %%APPDATA%%\\Anki2から自動検出)")
    parser.add_argument("--apply", action="store_true", help="実際に書き換える(既定は下見のみ)")
    parser.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR, help=f"バックアップ先(既定: {DEFAULT_BACKUP_DIR})")
    args = parser.parse_args(argv)
    try:
        return repair(find_collection_path(args.collection), args.apply, args.backup_dir)
    except RepairError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
