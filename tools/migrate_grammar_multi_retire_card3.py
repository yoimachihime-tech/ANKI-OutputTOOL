#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/migrate_grammar_multi_retire_card3.py
-------------------------------------------
Ankiコレクション上の「Grammar Multi (文法・複数出題形式)」から、カード3
「3. 誤答理由の想起」のテンプレートを削除する(2026-10-07)。

【何を直すための移行か】
カード3は表が Question + Choices で、カード1「1. 判断問題」と最後の1行
(「正解を選び、他の選択肢がなぜ誤りかを説明できますか?」)しか違わず、
同じ問題が2回出ていた(片桐の指摘)。このスロットは2026-08-29、2026-09-08と
2度作り直したが、どちらも表がカード1と重なる形から抜け出せなかったため、
廃止して「意味・本質問題」を独立したノートとして足すことにした
(CLAUDE.mdの「カード3の廃止と意味・本質問題」)。

この移行では:
  1. テンプレート ord=2「3. 誤答理由の想起」を削除する
     → そのテンプレートのカードはすべて削除される(回答したことのあるものも含む。
        テンプレート単位の操作なので、未出題のものだけを選んで消すことはできない)
     → 「4. 例文穴埋め」の ord は 3 → 2 になる(カードIDと学習履歴はそのまま)
  2. 残るテンプレート(名前・qfmt・afmt)とCSSを共有定義の内容に揃える

【!! 新しいapkgを取り込む前に、必ずこの移行を先に済ませること !!】
ツールが出力するノートタイプは3テンプレートになった。移行していない
コレクション(4テンプレート)に新しいapkgを取り込むと、Ankiは同じ名前で
別IDの「Grammar Multi (文法・複数出題形式)+」を作ってしまう。

【実行手順】
**Ankiを終了して**、`anki`パッケージのある実行環境で動かす。Python の anki は
Anki本体と同じ版にしておくこと(2026-10-07時点: 本体 26.9.2 /
`C:\\Python314\\python.exe -m pip install --user anki==26.9.2`)。

    C:\\Python314\\python.exe tools/migrate_grammar_multi_retire_card3.py           # 下見
    C:\\Python314\\python.exe tools/migrate_grammar_multi_retire_card3.py --apply   # 実行

実行後の同期は**必ず「アップロード」**を選ぶ(テンプレート削除=スキーマ変更)。
**その前に、スマホなど他の端末の復習をPCへ取り込んでおくこと**
(他端末で同期 → PCで同期 → Ankiを終了 → この移行)。アップロードはPCの内容で
AnkiWebを丸ごと置き換えるため、取り込んでいない復習は消える。

【学習履歴について】
削除されるのはカード3のカードだけ。ノートID・残りのカードIDは変わらないので、
カード1・2・4の間隔・FSRSの状態・復習履歴はそのまま残る。

【colテーブルのusnは絶対に触らないこと】
(2026-08-20の不具合。tools/repair_sync_usn.py を参照)このスクリプトは
col.models.update_dict しか使わず、usn には一切触らない。
"""

import argparse
import datetime
import io
import json
import os
import shutil
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED_DEFS_PATH = os.path.join(BASE_DIR, "docs", "shared", "card_defs.json")
DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")

NOTETYPE_NAME = "Grammar Multi (文法・複数出題形式)"
OLD_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "3. 誤答理由の想起", "4. 例文穴埋め"]
NEW_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "4. 例文穴埋め"]
RETIRED_ORD = 2


def default_collection_path() -> str:
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Anki2", "ユーザー 1", "collection.anki2",
    )


def load_shared_notetype() -> dict:
    with io.open(SHARED_DEFS_PATH, encoding="utf-8") as f:
        return json.load(f)["defs"]["grammar_multi"]["anki_model"]


def backup_collection(col_path: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(backup_dir, "collection_before_retire_card3_%s.anki2" % stamp)
    shutil.copy2(col_path, dest)
    return dest


def run(args) -> int:
    try:
        from anki.collection import Collection
    except ImportError:
        print("ankiパッケージが必要です(Anki本体と同じ版を入れてください)。")
        return 1

    shared = load_shared_notetype()
    shared_names = [t["name"] for t in shared["tmpls"]]
    if shared_names != NEW_TEMPLATES:
        print("共有定義のテンプレート構成が想定と違います: %s" % shared_names)
        print("先に `python tools/export_shared_card_defs.py` を実行してください。")
        return 1

    if args.apply:
        print("バックアップを作成しました: %s" % backup_collection(args.collection, args.backup_dir))

    try:
        col = Collection(args.collection)
    except Exception as e:  # noqa: BLE001
        print("コレクションを開けません(Ankiが起動していませんか?): %s" % e)
        return 1

    try:
        nt = col.models.by_name(NOTETYPE_NAME)
        if nt is None:
            print("ノートタイプが見つかりません: %s" % NOTETYPE_NAME)
            return 1
        names = [t["name"] for t in nt["tmpls"]]
        print("対象ノートタイプ: %s" % NOTETYPE_NAME)
        print("  現在のテンプレート: %s" % names)
        if names == NEW_TEMPLATES:
            print("移行済みです(カード3はありません)。何もしません。")
            return 0
        if names != OLD_TEMPLATES:
            print("!! テンプレート構成が想定と違います。想定: %s" % OLD_TEMPLATES)
            print("   手動で確認してから実行してください(中断します)。")
            return 1

        rows = col.db.all(
            "select c.id, c.queue, c.reps from cards c join notes n on c.nid = n.id"
            " where n.mid = ? and c.ord = ?", nt["id"], RETIRED_ORD)
        answered = [r for r in rows if r[2] > 0]
        suspended_new = [r for r in rows if r[2] == 0 and r[1] == -1]
        new = [r for r in rows if r[2] == 0 and r[1] != -1]
        reviews = sum(col.db.scalar("select count() from revlog where cid = ?", r[0]) or 0
                      for r in answered)
        total_cards = col.db.scalar(
            "select count() from cards c join notes n on c.nid = n.id where n.mid = ?", nt["id"])
        print()
        print("削除される「3. 誤答理由の想起」のカード: %d 枚" % len(rows))
        print("  未出題                : %d 枚" % len(new))
        print("  未出題のまま保留      : %d 枚" % len(suspended_new))
        print("  回答したことがある    : %d 枚(復習 %d 回分。同じノートのカード1の履歴は残る)"
              % (len(answered), reviews))
        print("このノートタイプのカード: %d 枚 → %d 枚" % (total_cards, total_cards - len(rows)))
        print("「4. 例文穴埋め」の ord: 3 → 2(カードIDと学習履歴はそのまま)")

        if not args.apply:
            print()
            print("下見のみで終了しました。実際に書き換えるには --apply を付けてください。")
            return 0

        # --- ここから書き換え ---
        before_ids = set(col.db.list(
            "select c.id from cards c join notes n on c.nid = n.id"
            " where n.mid = ? and c.ord != ?", nt["id"], RETIRED_ORD))
        col.models.remove_template(nt, nt["tmpls"][RETIRED_ORD])
        # 残るテンプレートは並び順どおりに共有定義を当てる
        for t, src in zip(nt["tmpls"], shared["tmpls"]):
            t["name"] = src["name"]
            t["qfmt"] = src["qfmt"]
            t["afmt"] = src["afmt"]
        nt["css"] = shared["css"]
        col.models.update_dict(nt)

        nt = col.models.by_name(NOTETYPE_NAME)
        after_ids = set(col.db.list(
            "select c.id from cards c join notes n on c.nid = n.id where n.mid = ?", nt["id"]))
        print()
        print("テンプレート: %s" % [t["name"] for t in nt["tmpls"]])
        print("残したカード %d 枚のうち、消えたもの: %d 枚(0のはず)"
              % (len(before_ids), len(before_ids - after_ids)))
        print("完了しました。次の同期では必ず「アップロード」を選んでください。")
        return 0
    finally:
        try:
            col.close()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Grammar Multi のカード3「3. 誤答理由の想起」を削除する移行")
    ap.add_argument("--collection", default=default_collection_path())
    ap.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    ap.add_argument("--apply", action="store_true", help="実際に書き換える(既定は下見のみ)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    if not os.path.exists(args.collection):
        print("コレクションが見つかりません: %s" % args.collection)
        return 1
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
