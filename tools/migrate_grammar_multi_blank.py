#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/migrate_grammar_multi_blank.py
-------------------------------------
Ankiコレクション上の「Grammar Multi (文法・複数出題形式)」ノートタイプを、
2026-08-21の新しい定義へ**学習履歴を保ったまま**移行する。

【何を直すための移行か】
旧「4. 例文穴埋め」テンプレートは、表で `{{Example}}` を `.masked` クラス付きで
出し、CSSで `<b>` を透明にして空所に見せていた。しかし**音声タグ `[sound:…]`
も同じ Example フィールドに入る**ため、Ankiが `[sound:]` をCSSより先に処理する
仕様により、**隠した語が音声で丸聞こえ**になっていた(片桐のコレクションで
41ノートが該当)。さらに本ツールが作る Example には `<b>` が1つも入らないため、
新しいカードでは**そもそも穴が開かず**、表に完全な例文と音声がそのまま
出ていた(90ノート)。

この移行では:
  1. `ExampleBlank` フィールドを**末尾に追加**する(音声タグを持たない穴あき版)
  2. テンプレート3・4を作り直す
     - 4: 表は ExampleBlank だけ。完全版の Example と音声は裏にだけ置く
     - 3・4: `<div id="qb-source" style="display:none">{{Question}}</div>` +
       JSのヒント抽出を撤去(目印 `<b>状況:</b>` が本ツール製ノートに1件も無く
       常に空振りしていた。Question全体を非表示でDOMに置くのは、②でQuestionを
       読み上げ対象に選んだときに「画面に無いのに読まれる」事故のもとでもある)
  3. `<b>` を持つ既存ノートの ExampleBlank を機械的に埋める
     (Example から音声タグを除き、`<b>…</b>` を空所に置き換える)

【!! 新しいapkgを取り込む前に、必ずこの移行を先に済ませること !!】
ツールが出力するノートタイプは9フィールドになった。**移行していない
コレクション(8フィールド)に新しいapkgを取り込むと、Ankiは同じ名前で
別IDのノートタイプ「Grammar Multi (文法・複数出題形式)+」を作ってしまう**
(2026-08-21に実データのコピーで確認: 元の155ノートは旧ノートタイプに
残り、新しい1ノートだけが「+」側へ入った)。こうなるとデッキが2つの
ノートタイプに割れ、テンプレートもCSSも別管理になる。

    移行を先に済ませてから取り込めば、ノートタイプは1つのまま
    (同コピーで 155→156 ノート、id=1907250010123 のまま を確認済み)。

【実行方法(重要)】
`anki`パッケージが入っている実行環境で動かすこと(genankiは使わない。
ノートタイプ定義は `docs/shared/card_defs.json` から読む):

    "C:\\Users\\<user>\\AppData\\Local\\AnkiProgramFiles\\.venv\\Scripts\\python.exe" \\
        tools/migrate_grammar_multi_blank.py            # 下見(何も書き換えない)
    ...同上... tools/migrate_grammar_multi_blank.py --apply   # 実際に書き換える

【実行前後の手順】
1. **Ankiを終了しておくこと**(起動中は collection.anki2 がロックされる。
   このスクリプトはロックを検出したら何もせず終了する)。
2. `--apply` で実行する(実行前に自動で backup/ へコレクションを丸ごと退避する)。
3. Ankiを起動し、文法・用法デッキの表示を確認する。
4. 同期は**必ず「アップロード」**を選ぶこと(フィールド追加=スキーマ変更のため)。
5. ノートタイプを更新するとAnkiがカードを作り直すため:
   - これまで「1. 判断問題」しか無かったノートにも2〜4枚目が生える
     (ツール側の定義とコレクションの食い違いを解消した結果。片桐の判断で
     実態=4テンプレートに揃えた)
   - ExampleBlank が空のノートでは「4. 例文穴埋め」が**空のカード**になる
     (`req` が all[ExampleBlank] のため)。**放置すると復習時に「The front of
     this card is blank.」と表示されるカードとして出題されてしまう**ので、
     [ツール]→[空のカードを削除] で消すこと。消すとそのカードの復習履歴も
     一緒に消える(件数と失われる復習回数は下見で表示する)。

【学習履歴について】
notes の flds(ExampleBlankの追加)と notetype 定義だけを変更し、cards/revlog は
直接触らない。ノートID・カードIDは変わらないので、既存カードの間隔・FSRSの
状態・復習履歴はそのまま残る(migrate_shuujuku_notetype.py と同じ方針)。
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED_DEFS_PATH = os.path.join(BASE_DIR, "docs", "shared", "card_defs.json")
DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")

NOTETYPE_NAME = "Grammar Multi (文法・複数出題形式)"
NEW_FIELD = "ExampleBlank"
EXPECTED_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "3. 理由想起", "4. 例文穴埋め"]

SOUND_TAG_RE = re.compile(r"(<br\s*/?>\s*)?\[sound:[^\]]+\]", re.IGNORECASE)
BOLD_RE = re.compile(r"<b>(.*?)</b>", re.IGNORECASE | re.DOTALL)


def default_collection_path() -> str:
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Anki2", "ユーザー 1", "collection.anki2",
    )


def build_example_blank(example_html: str) -> str:
    """既存の Example から穴あき版を作る。

    build_grammar_multi_v1_updated.example_blank() と同じ結果になるが、
    こちらは「(en, ja)のペア」ではなく**組み立て済みのExampleフィールド**が
    入力。ex-numラベルはそのまま残し、音声タグだけ落として `<b>…</b>` を
    空所に置き換える。`<b>` が無ければ空文字(穴が開かないので4枚目の
    カードを作らせない)。
    """
    if not BOLD_RE.search(example_html):
        return ""
    src = SOUND_TAG_RE.sub("", example_html).strip()
    return BOLD_RE.sub('<span class="blank">____</span>', src)


def load_shared_notetype() -> dict:
    with open(SHARED_DEFS_PATH, encoding="utf-8") as f:
        defs = json.load(f)["defs"]
    return defs["grammar_multi"]["anki_model"]


def backup_collection(col_path: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(backup_dir, f"collection_before_grammar_multi_blank_{stamp}.anki2")
    shutil.copy2(col_path, dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[3])
    ap.add_argument("--collection", default=default_collection_path())
    ap.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    ap.add_argument("--apply", action="store_true", help="実際に書き換える(既定は下見のみ)")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    if not os.path.exists(args.collection):
        print(f"コレクションが見つかりません: {args.collection}")
        return 1

    try:
        from anki.collection import Collection
    except ImportError:
        print("ankiパッケージが必要です。Anki同梱のvenvのpython.exeで実行してください。")
        print("  例: %LOCALAPPDATA%\\AnkiProgramFiles\\.venv\\Scripts\\python.exe")
        return 1

    shared = load_shared_notetype()
    shared_tmpls = {t["name"]: t for t in shared["tmpls"]}
    missing = [n for n in EXPECTED_TEMPLATES if n not in shared_tmpls]
    if missing:
        print(f"共有定義に想定のテンプレートがありません: {missing}")
        print("先に `python tools/export_shared_card_defs.py` を実行してください。")
        return 1

    if args.apply:
        dest = backup_collection(args.collection, args.backup_dir)
        print(f"バックアップを作成しました: {dest}")

    try:
        col = Collection(args.collection)
    except Exception as e:  # noqa: BLE001
        print(f"コレクションを開けません(Ankiが起動していませんか?): {e}")
        return 1

    try:
        nt = col.models.by_name(NOTETYPE_NAME)
        if nt is None:
            print(f"ノートタイプが見つかりません: {NOTETYPE_NAME}")
            return 1

        field_names = [f["name"] for f in nt["flds"]]
        tmpl_names = [t["name"] for t in nt["tmpls"]]
        print(f"対象ノートタイプ: {NOTETYPE_NAME}")
        print(f"  現在のフィールド    : {field_names}")
        print(f"  現在のテンプレート  : {tmpl_names}")

        if tmpl_names != EXPECTED_TEMPLATES:
            print()
            print("!! テンプレート構成が想定と違います。想定:")
            print(f"   {EXPECTED_TEMPLATES}")
            print("   手動で確認してから実行してください(このスクリプトは中断します)。")
            return 1

        nids = col.find_notes(f'note:"{NOTETYPE_NAME}"')
        add_field = NEW_FIELD not in field_names
        blank_idx = field_names.index(NEW_FIELD) if not add_field else len(field_names)
        ex_idx = field_names.index("Example")

        will_fill, already, no_bold = [], 0, 0
        for nid in nids:
            note = col.get_note(nid)
            blank = build_example_blank(note.fields[ex_idx])
            if not blank:
                no_bold += 1
                continue
            if not add_field and note.fields[blank_idx].strip():
                already += 1
                continue
            will_fill.append((nid, blank))

        # 4枚目が空カードになるノート(= ExampleBlank が埋まらないノート)のうち、
        # 既に「4. 例文穴埋め」のカードを持っているものの枚数と、そのカードに
        # 溜まっている復習回数(空のカードを削除すると一緒に消える分)。
        empty_cards, lost_reviews = 0, 0
        for nid in nids:
            note = col.get_note(nid)
            if build_example_blank(note.fields[ex_idx]):
                continue
            if not add_field and note.fields[blank_idx].strip():
                continue
            for c in note.cards():
                if c.ord != 3:
                    continue
                empty_cards += 1
                lost_reviews += col.db.scalar(
                    "select count(*) from revlog where cid = ?", c.id) or 0

        print()
        print(f"ノート数: {len(nids)}")
        print(f"  ExampleBlank を埋める            : {len(will_fill)} 件")
        print(f"  既に埋まっているので触らない      : {already} 件")
        print(f"  <b> が無く穴あき版を作れない      : {no_bold} 件")
        print(f"  → 空カードになる「4. 例文穴埋め」: {empty_cards} 枚")
        print(f"     ([ツール]→[空のカードを削除] で消すこと。放置すると復習時に")
        print(f"      「The front of this card is blank.」として出題されてしまう。")
        print(f"      削除で失われる復習履歴: {lost_reviews} 回)")
        print()
        print(f"{'追加する' if add_field else '既にある'}フィールド: {NEW_FIELD}")
        print("テンプレート3・4のqfmt/afmtとCSSを共有定義の内容へ置き換えます。")

        if will_fill:
            nid, blank = will_fill[0]
            print()
            print("埋める内容の例:")
            print(f"  Example     : {col.get_note(nid).fields[ex_idx][:110]}")
            print(f"  ExampleBlank: {blank[:110]}")

        if not args.apply:
            print()
            print("下見のみで終了しました。実際に書き換えるには --apply を付けてください。")
            return 0

        # --- ここから書き換え ---
        if add_field:
            col.models.add_field(nt, col.models.new_field(NEW_FIELD))
        for t in nt["tmpls"]:
            src = shared_tmpls[t["name"]]
            t["qfmt"] = src["qfmt"]
            t["afmt"] = src["afmt"]
        nt["css"] = shared["css"]
        col.models.update_dict(nt)
        print("ノートタイプ定義を更新しました(フィールド追加・テンプレート・CSS)。")

        # フィールド追加でインデックスが確定するので取り直す
        nt = col.models.by_name(NOTETYPE_NAME)
        blank_idx = [f["name"] for f in nt["flds"]].index(NEW_FIELD)
        for nid, blank in will_fill:
            note = col.get_note(nid)
            note.fields[blank_idx] = blank
            col.update_note(note)
        print(f"{len(will_fill)} 件の ExampleBlank を埋めました。")

        print()
        print("完了しました。Ankiを起動して表示を確認し、同期は必ず「アップロード」を選んでください。")
        return 0
    finally:
        try:
            col.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
