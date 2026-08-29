#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/migrate_grammar_multi_answerplain.py
-------------------------------------------
Ankiコレクション上の「Grammar Multi (文法・複数出題形式)」ノートタイプを、
2026-08-29の新しい定義へ**学習履歴を保ったまま**移行する。

【何を直すための移行か】
片桐から「AIに質問タブで生成したカードの2〜3枚目が、答えが最初から出て
いたり選択肢がそもそも出てこなかったりで勉強に支障がある」と報告を受けた。
実データ(170ノート)を調べたところ、テンプレート2・3が**旧・手書きノート
向けの設計のまま**で、ツール製ノートに対して壊れていた。

  カード2「2. セルフチェック」(表に Choices を出さない設計)
    ・選択肢ありのノート(94件): 設問文が「選択肢から選びなさい」なのに
      選択肢が出ない → 答えようがない。裏の「Why not the others?」も、
      学習者が一度も見ていない選択肢について語っていた。
    ・選択肢なしのノート(76件): Choicesが空だとカード1側の {{#Choices}}
      ブロックも消えるため、**カード1と表・裏が完全に同一**だった。

  カード3「3. 理由想起」(表が {{Answer}} だけ)
    ・Questionを出さないので何の問題だったか分からない。Answerが
      「(A) of」のように語句だけのノートでは、表が「選択問題 / (A) of /
      Why is this correct?」だけになっていた(10件)。
    ・Answerの先頭には正解の選択肢ラベル「(A) 」が付く(93件)。
    ・**Answerには [sound:] タグが入る**(「AIに質問」タブのTTS対象が
      Answer+Example)ため、**表を開いた瞬間に正解が読み上げられていた**
      (170件すべて)。裏は {{FrontSide}} なのでAnkiが音声を除去し、
      音声だけが表にあるという逆転が起きていた。

この移行では:
  1. `AnswerPlain` フィールドを**末尾に追加**する
     (正解ラベル「(A) 」も [sound:] タグも持たない正解文)
  2. テンプレート2・3を作り直す
     - 2: qfmt全体を {{#Choices}} で囲み、選択肢のあるノートにだけ生やす。
          裏では選択肢も見せる(WhyNotが意味を持つように)
     - 3: 表は Question + AnswerPlain で「なぜ?」を問う。
          **音声の入る Answer は表に出さない**
  3. 既存ノートの `AnswerPlain` を、Answer から選択肢ラベルと音声タグを
     機械的に剥がして埋める

【!! 新しいapkgを取り込む前に、必ずこの移行を先に済ませること !!】
ツールが出力するノートタイプは10フィールドになった。**移行していない
コレクション(9フィールド)に新しいapkgを取り込むと、Ankiは同じ名前で
別IDのノートタイプ「Grammar Multi (文法・複数出題形式)+」を作ってしまう**
(2026-08-21のExampleBlank追加時に実データのコピーで確認済みの挙動)。
こうなるとデッキが2つのノートタイプに割れ、テンプレートもCSSも別管理になる。

【実行方法(重要)】
`anki`パッケージが入っている実行環境で動かすこと(genankiは使わない。
ノートタイプ定義は `docs/shared/card_defs.json` から読む):

    "C:\\Users\\<user>\\AppData\\Local\\AnkiProgramFiles\\.venv\\Scripts\\python.exe" \\
        tools/migrate_grammar_multi_answerplain.py          # 下見(何も書き換えない)
    ...同上... tools/migrate_grammar_multi_answerplain.py --apply   # 実際に書き換える

【実行前後の手順】
1. **Ankiを終了しておくこと**(起動中は collection.anki2 がロックされる。
   このスクリプトはロックを検出したら何もせず終了する)。
2. `--apply` で実行する(実行前に自動で backup/ へコレクションを丸ごと退避する)。
3. Ankiを起動し、文法・用法デッキの表示を確認する。
4. **選択肢を持たないノートの「2. セルフチェック」は空カードになる**
   (`req` が all[Choices] になるため)。これは意図した結果で、カード1と
   まったく同じ内容の重複カードを止めるためのもの。**放置すると復習時に
   「The front of this card is blank.」と表示されるカードとして出題されて
   しまう**ので、[ツール]→[空のカードを削除] で消すこと。消すとそのカードの
   復習履歴も一緒に消える(件数と失われる復習回数は下見で表示する)。
5. 同期は**必ず「アップロード」**を選ぶこと(フィールド追加=スキーマ変更のため)。

【学習履歴について】
notes の flds(AnswerPlainの追加)と notetype 定義だけを変更し、cards/revlog は
直接触らない。ノートID・カードIDは変わらないので、既存カードの間隔・FSRSの
状態・復習履歴はそのまま残る(migrate_grammar_multi_blank.py と同じ方針)。
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
NEW_FIELD = "AnswerPlain"
EXPECTED_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "3. 理由想起", "4. 例文穴埋め"]

SELFCHECK_ORD = 1  # 「2. セルフチェック」。移行後は選択肢ありノートにだけ生える

SOUND_TAG_RE = re.compile(r"(<br\s*/?>\s*)?\[sound:[^\]]+\]", re.IGNORECASE)
# 先頭の正解ラベル。「(A) 」のほか、旧・手書きノートの「(A) &mdash; 」
# 「(A) — 」という区切り付きの形にも対応する(実データで両方を確認)。
# 選択肢は(A)〜(D)しか使わないので範囲を絞ってあり、"(I) am ..." のような
# 正当な文を巻き込まない。
OPT_PREFIX_RE = re.compile(
    r"^\s*(?:<[^>]+>\s*)*\(\s*[A-Da-d]\s*\)\s*(?:&mdash;|&ndash;|—|–|-|:)?\s*"
)


def default_collection_path() -> str:
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Anki2", "ユーザー 1", "collection.anki2",
    )


def build_answer_plain(answer_html: str) -> str:
    """既存の Answer から、「3. 理由想起」の表に出す正解文を作る。

    落とすのは2つだけ:
      ・`[sound:…]` タグ(と直前の `<br>`)  … 表で正解が読み上げられるのを防ぐ
      ・先頭の正解ラベル「(A) 」            … 表に答えの記号が見えるのを防ぐ

    `<b>…</b>` による強調は**そのまま残す**(旧・手書きノートは文法ポイントを
    <b>で示しており、理由を思い出すカードではむしろ手がかりとして役に立つ)。
    """
    if not answer_html:
        return ""
    return OPT_PREFIX_RE.sub("", SOUND_TAG_RE.sub("", answer_html)).strip()


def load_shared_notetype() -> dict:
    with open(SHARED_DEFS_PATH, encoding="utf-8") as f:
        defs = json.load(f)["defs"]
    return defs["grammar_multi"]["anki_model"]


def backup_collection(col_path: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(
        backup_dir, f"collection_before_grammar_multi_answerplain_{stamp}.anki2")
    shutil.copy2(col_path, dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description="Grammar Multi のカード2・3を作り直す移行")
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
    shared_fields = [f["name"] for f in shared["flds"]]
    if NEW_FIELD not in shared_fields:
        print(f"共有定義に {NEW_FIELD} がありません: {shared_fields}")
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
        plain_idx = field_names.index(NEW_FIELD) if not add_field else len(field_names)
        answer_idx = field_names.index("Answer")
        choices_idx = field_names.index("Choices")

        will_fill, already, no_answer = [], 0, 0
        # 移行後に「2. セルフチェック」が空カードになるノート(=Choicesが空)の
        # うち、既にそのカードを持っているものの枚数と、溜まっている復習回数。
        empty_selfcheck, lost_reviews = 0, 0
        for nid in nids:
            note = col.get_note(nid)
            plain = build_answer_plain(note.fields[answer_idx])
            if not plain:
                no_answer += 1
            elif not add_field and note.fields[plain_idx].strip():
                already += 1
            else:
                will_fill.append((nid, plain))

            if not note.fields[choices_idx].strip():
                for c in note.cards():
                    if c.ord != SELFCHECK_ORD:
                        continue
                    empty_selfcheck += 1
                    lost_reviews += col.db.scalar(
                        "select count(*) from revlog where cid = ?", c.id) or 0

        print()
        print(f"ノート数: {len(nids)}")
        print(f"  AnswerPlain を埋める              : {len(will_fill)} 件")
        print(f"  既に埋まっているので触らない       : {already} 件")
        print(f"  Answerが空で埋められない           : {no_answer} 件")
        print("     (このノートでは「3. 理由想起」が空カードになる)")
        print()
        print(f"  → 空カードになる「2. セルフチェック」: {empty_selfcheck} 枚")
        print("     (選択肢を持たないノートの分。カード1とまったく同じ内容の")
        print("      重複カードだったものなので、消して問題ない。")
        print("      [ツール]→[空のカードを削除] で消すこと。放置すると復習時に")
        print("      「The front of this card is blank.」として出題されてしまう。")
        print(f"      削除で失われる復習履歴: {lost_reviews} 回)")
        print()
        print(f"{'追加する' if add_field else '既にある'}フィールド: {NEW_FIELD}")
        print("テンプレート2・3のqfmt/afmtとCSSを共有定義の内容へ置き換えます。")

        if will_fill:
            nid, plain = will_fill[0]
            print()
            print("埋める内容の例:")
            print(f"  Answer     : {col.get_note(nid).fields[answer_idx][:110]}")
            print(f"  AnswerPlain: {plain[:110]}")

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
        plain_idx = [f["name"] for f in nt["flds"]].index(NEW_FIELD)
        for nid, plain in will_fill:
            note = col.get_note(nid)
            note.fields[plain_idx] = plain
            col.update_note(note)
        print(f"{len(will_fill)} 件の AnswerPlain を埋めました。")

        print()
        print("完了しました。Ankiを起動して表示を確認し、[ツール]→[空のカードを削除] を")
        print("実行してから、同期は必ず「アップロード」を選んでください。")
        return 0
    finally:
        try:
            col.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    sys.exit(main())
