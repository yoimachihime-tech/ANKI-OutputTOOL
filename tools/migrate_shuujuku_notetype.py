#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/migrate_shuujuku_notetype.py
-----------------------------------
Ankiコレクション上の既存の習熟用ノートを、v1「ATSU方式 (PDF再現・音読用)」
(Num/Contentの2フィールド)から v2「ATSU方式 (音読用・TTS対応)」
(DeckTitle/Num/I1PatternEN/… の1文=1フィールド)へ**学習履歴を保ったまま**
移行する。

【なぜapkgの再インポートではダメか】
フィールド構成を変えたapkgを作り直してインポートしても、Ankiのインポータは
新しいguidのノートを「新規」として取り込み、cardsのスケジューリングとrevlogは
復元されない(2026-08-20に120選デッキで確認済み)。そこでこのスクリプトは
**notesテーブルのmid/flds/sfld/csumだけを書き換え、cards/revlogには一切
触らない**。ノートIDもカードIDも変わらないので、間隔・FSRSの状態・復習履歴は
100%そのまま残る。

【実行方法(重要)】
`anki`パッケージが入っている実行環境で動かすこと:

    "C:\\Users\\<user>\\AppData\\Local\\AnkiProgramFiles\\.venv\\Scripts\\python.exe" \\
        tools/migrate_shuujuku_notetype.py            # 下見(何も書き換えない)
    ...同上... tools/migrate_shuujuku_notetype.py --apply   # 実際に書き換える

genankiは使わない(このスクリプトはノートタイプ定義を
`docs/shared/card_defs.json`から読む)。そのため、genankiが入っている
C:\\Python314\\python.exe ではなくAnki同梱のvenvで動かせる。

【実行前後の手順】
1. **Ankiを終了しておくこと**(起動中はcollection.anki2がロックされる。
   このスクリプトはロックを検出したら何もせず終了する)。
2. `--apply`で実行する(実行前に自動でbackup/へコレクションを丸ごと退避する)。
3. Ankiを起動し、習熟用デッキの表示と復習期限を確認する。
4. 同期は**必ず「アップロード」**を選ぶこと(ノートタイプの追加=スキーマ変更の
   ため。col.scmを更新してあるので、Anki側からもフルアップロードを求められる)。

【変換の中身】
v1のContentフィールドは build_shuujuku_v1(v1) の render_item() が組み立てた
HTMLで、CSSクラス名から各パーツを取り出せる。取り出した中身はv1の時点で
html.escape済み・<mark>/<u>付きなので、**再エスケープせずそのまま**新しい
フィールドへ移す(v2のbuild_fields_dict()が作る値と同じ形になる)。
例文ごとに埋め込まれている`[sound:...]`タグは`<div class="ex-en">`の中に
`<br>[sound:…]`の形で入っているので、英文と一緒にI1ExnENへ移る
(=既存の音声ファイルはそのまま鳴り続ける)。
"""

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import sqlite3
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED_DEFS_PATH = os.path.join(BASE_DIR, "docs", "shared", "card_defs.json")
DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")

# v1のノートタイプ。idと名前の両方で探す(片方しか一致しなくても拾えるように)。
V1_MODEL_ID = 1901020103491
V1_MODEL_NAME = "ATSU方式 (PDF再現・音読用)"

# v1 Contentフィールドの構造(build_shuujuku_v1 v1のrender_item()が出力したHTML)。
# 中身のHTML(<mark>/<u>/<br>[sound:…])を保ったまま取り出したいので、
# tts_core.parse_shuujuku_content_html()(表示用にタグを落とす)とは別に持つ。
DECK_TITLE_RE = re.compile(r'<div class="deck-title">(.*?)&nbsp;No\.(\d+)</div>', re.DOTALL)
PATTERN_RE = re.compile(r'<span class="pattern-line">(.*?)</span>', re.DOTALL)
GLOSS_RE = re.compile(r'<div class="gloss-line">(.*?)</div>', re.DOTALL)
EX_ROW_RE = re.compile(
    r'<div class="ex-row"><div class="ex-en">(.*?)</div><div class="ex-jp">(.*?)</div></div>',
    re.DOTALL,
)
EXPL_RE = re.compile(r'<div class="expl-box"><div class="expl-label">[^<]*</div>(.*?)</div>', re.DOTALL)
SOURCE_RE = re.compile(r'<div class="source-tag">(.*?)</div>', re.DOTALL)
SOUND_TAG_RE = re.compile(r"\[sound:[^\]]+\]")


class MigrationError(Exception):
    pass


# ---------------------------------------------------------------------------
# 入力の解決
# ---------------------------------------------------------------------------


def find_collection_path(explicit: str = None) -> str:
    if explicit:
        if not os.path.exists(explicit):
            raise MigrationError(f"コレクションが見つかりません: {explicit}")
        return explicit
    pattern = os.path.join(os.path.expandvars(r"%APPDATA%"), "Anki2", "*", "collection.anki2")
    found = sorted(glob.glob(pattern))
    if not found:
        raise MigrationError(
            "Ankiのコレクションが見つかりません。--collection でパスを指定してください。"
        )
    if len(found) > 1:
        raise MigrationError(
            "Ankiのプロファイルが複数あります。--collection でどれかを指定してください:\n  "
            + "\n  ".join(found)
        )
    return found[0]


def load_v2_def() -> dict:
    """docs/shared/card_defs.json から習熟用v2の定義を読む。

    ここを単一の出所にしているのは、フィールドの並び・item_key・テンプレート・
    CSSがすべて build_shuujuku_v1.py(正典)から書き出されたものだから
    (tools/export_shared_card_defs.py)。このスクリプトが独自にフィールド一覧を
    持つと、正典を直したときに片方だけ古いまま残る。"""
    if not os.path.exists(SHARED_DEFS_PATH):
        raise MigrationError(
            f"{SHARED_DEFS_PATH} がありません。先に "
            "`python tools/export_shared_card_defs.py` を実行してください。"
        )
    with open(SHARED_DEFS_PATH, encoding="utf-8") as f:
        defs = json.load(f)["defs"]
    if "shuujuku" not in defs:
        raise MigrationError("card_defs.json に shuujuku の定義がありません。")
    d = defs["shuujuku"]
    if len(d["fields"]) < 10:
        raise MigrationError(
            "card_defs.json の shuujuku がまだv1(Num/Contentの2フィールド)のようです。"
            "先に `python tools/export_shared_card_defs.py` を実行し直してください。"
        )
    return d


def connect(col_path: str) -> sqlite3.Connection:
    """collection.anki2 用のsqlite3接続を作る。

    Ankiのコレクションはインデックスに `unicase` というカスタム照合順序を
    使っているため、これを登録しないと `pragma integrity_check` などが
    「no such collation sequence: unicase」で失敗する。ここでは大文字小文字を
    無視した比較で代用する(このスクリプトが行う更新・検査の範囲では十分)。"""
    con = sqlite3.connect(col_path)
    con.create_collation("unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower()))
    return con


def assert_not_locked(col_path: str) -> None:
    """Ankiが起動していない(=コレクションがロックされていない)ことを確かめる。"""
    try:
        con = sqlite3.connect(col_path, timeout=1.0)
        try:
            con.execute("begin exclusive")
            con.execute("rollback")
        finally:
            con.close()
    except sqlite3.OperationalError as e:
        raise MigrationError(
            f"コレクションがロックされています({e})。Ankiを終了してから実行してください。"
        )


# ---------------------------------------------------------------------------
# v1 Content の分解
# ---------------------------------------------------------------------------


def parse_v1_content(num: str, content_html: str) -> dict:
    """v1のNum/Contentから、v2のitem_keyをキーにしたフィールド値を作る。

    値はv1の時点でエスケープ済みのHTML片なので、そのまま持ち越す
    (build_shuujuku_v1.build_fields_dict()が新規生成時に作る値と同じ形)。"""
    deck_m = DECK_TITLE_RE.search(content_html)
    pattern_m = PATTERN_RE.search(content_html)
    if not deck_m or not pattern_m:
        raise MigrationError("Contentがv1の形式(deck-title / pattern-line)ではありません。")

    deck_title = deck_m.group(1).strip()
    num_in_content = deck_m.group(2)
    gloss_m = GLOSS_RE.search(content_html)
    expl_m = EXPL_RE.search(content_html)
    source_m = SOURCE_RE.search(content_html)
    rows = EX_ROW_RE.findall(content_html)

    values = {
        "deck_title": deck_title,
        # Numフィールドの値を正とする(Content内の表示と食い違っていたら呼び出し側で警告)。
        "num": num,
        "badge": num,
        "pattern_en": pattern_m.group(1),
        "pattern_jp": gloss_m.group(1) if gloss_m else "",
        "tip": expl_m.group(1) if expl_m else "",
        "source": source_m.group(1) if source_m else "",
        "all_audio": "",
        "_num_in_content": num_in_content,
        "_examples": len(rows),
        "_sound_tags_total": len(SOUND_TAG_RE.findall(content_html)),
    }
    for i, (en, ja) in enumerate(rows, start=1):
        values[f"ex{i}_en"] = en
        values[f"ex{i}_jp"] = ja
    return values


def fields_for(v2_def: dict, values: dict) -> list:
    """v2定義のフィールド順に値を並べる(足りないキーは空文字)。"""
    return [str(values.get(f["item_key"], "")) for f in v2_def["fields"]]


# ---------------------------------------------------------------------------
# ノートタイプの用意
# ---------------------------------------------------------------------------


def ensure_v2_notetype(col_path: str, v2_def: dict, first_field_values, verbose=print) -> dict:
    """v2のノートタイプがコレクションに存在することを保証し、csumの対応表を返す。

    【idを固定値にするための手順】
    Ankiのバックエンド(add_notetype)は「idは0で渡すこと」を要求し、実際のidは
    Anki側が採番する。しかしこのツールが出力するapkgのノートタイプidは
    build_shuujuku_v1.MODEL_ID固定なので、コレクション側のidがそれと違うと
    次にapkgをインポートしたときに**同名の別ノートタイプが増えてしまう**。
    そのため、APIで追加した直後にコレクションを閉じ、notetypes/fields/templates
    の3テーブルのidだけをSQLで固定値へ書き換える(この時点ではまだ1枚も
    ノートがぶら下がっていないので、他のテーブルへの波及は無い)。

    first_field_values: csumを計算したい第1フィールドの値(重複可)。
    csumはAnkiのバックエンド(i18n初期化済みのCollection)が要るため、
    ノートタイプの用意と同じセッションでまとめて計算してしまう。

    戻り値: {第1フィールドの値: csum}
    """
    import anki.lang  # noqa: PLC0415 (anki venvでのみ動く)
    from anki.collection import Collection  # noqa: PLC0415
    from anki.utils import field_checksum  # noqa: PLC0415

    # field_checksum()はAnkiの翻訳バックエンド(strip_html)を使うので、
    # 先にset_lang()しておかないと current_i18n が None のままで落ちる。
    anki.lang.set_lang("en_US")

    model_id = v2_def["model_id"]
    name = v2_def["notetype_name"]
    anki_model = v2_def["anki_model"]
    auto_id = None

    col = Collection(col_path)
    try:
        existing_by_id = col.models.get(model_id)
        existing_by_name = col.models.by_name(name)
        if existing_by_id is not None:
            verbose(f"  ノートタイプ「{name}」は既にあります(id={model_id})。")
        elif existing_by_name is not None:
            # 同じ名前が別のidで存在する。前回の実行がノートタイプ追加と
            # idの固定の間で落ちた場合に起きるので、まだ1枚もノートが
            # ぶら下がっていなければ、そのままidを固定値へ直して続行する。
            note_count = col.db.scalar(
                "select count() from notes where mid=?", existing_by_name["id"]
            )
            if note_count:
                raise MigrationError(
                    f"同じ名前のノートタイプが別のid({existing_by_name['id']})で存在し、"
                    f"ノートが {note_count} 件ぶら下がっています。"
                    "先にAnki上で名前を変えるか整理してから実行してください。"
                )
            auto_id = existing_by_name["id"]
            verbose(
                f"  ノートタイプ「{name}」が別のid({auto_id})で見つかりました"
                "(前回の中断分と思われます)。idを直します。"
            )
        else:
            nt = json.loads(json.dumps(anki_model))  # 破壊しないようコピー
            nt["id"] = 0  # Ankiのバックエンドはid=0を要求する(後でSQLで固定値へ)
            nt["name"] = name
            auto_id = col.models.add_dict(nt).id
            verbose(f"  ノートタイプ「{name}」を追加しました(暫定id={auto_id})。")
        csums = {v: field_checksum(v) for v in set(first_field_values)}
    finally:
        col.close()

    if auto_id is not None:
        con = connect(col_path)
        try:
            con.execute("update notetypes set id=? where id=?", (model_id, auto_id))
            con.execute("update fields set ntid=? where ntid=?", (model_id, auto_id))
            con.execute("update templates set ntid=? where ntid=?", (model_id, auto_id))
            con.commit()
        finally:
            con.close()
        verbose(f"  ノートタイプのidを {auto_id} → {model_id} に固定しました。")
    return csums


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------


def collect_targets(col_path: str) -> tuple:
    """(v1ノートの[(id, num, content, extra_fields)], v1のmid) を返す。"""
    con = connect(col_path)
    try:
        # 絞り込みはPython側で行う(notetypes.nameをSQLで比較すると、Anki本体と
        # 同じ`unicase`の実装が必要になるため)。
        rows = [
            (nid, name)
            for nid, name in con.execute("select id, name from notetypes")
            if nid == V1_MODEL_ID or name == V1_MODEL_NAME
        ]
        if not rows:
            raise MigrationError(
                f"v1のノートタイプ(id={V1_MODEL_ID} / 名前「{V1_MODEL_NAME}」)が見つかりません。"
                "既に移行済みの可能性があります。"
            )
        if len(rows) > 1:
            raise MigrationError(
                "v1のノートタイプ候補が複数あります: " + ", ".join(f"{r[0]}({r[1]})" for r in rows)
            )
        v1_mid, v1_name = rows[0]
        notes = con.execute(
            "select id, flds from notes where mid=? order by id", (v1_mid,)
        ).fetchall()
    finally:
        con.close()
    return notes, v1_mid, v1_name


def migrate(col_path: str, apply: bool, backup_dir: str, verbose=print) -> int:
    v2_def = load_v2_def()
    verbose(f"コレクション: {col_path}")
    verbose(
        f"移行先ノートタイプ: {v2_def['notetype_name']} "
        f"(id={v2_def['model_id']}, フィールド{len(v2_def['fields'])}個)"
    )
    assert_not_locked(col_path)

    notes, v1_mid, v1_name = collect_targets(col_path)
    verbose(f"移行元ノートタイプ: {v1_name} (id={v1_mid}) / 対象ノート {len(notes)} 件")
    if not notes:
        verbose("対象ノートがありません。何もしません。")
        return 0

    # --- 先に全件を変換してみる(1件でも壊れていたら書き換えを始めない) ---
    converted = []
    total_tags = 0
    kept_tags = 0
    max_examples = len(
        [f for f in v2_def["fields"] if re.match(r"^I\d+Ex\d+EN$", f["anki_name"])]
    )
    for nid, flds in notes:
        parts = flds.split("\x1f")
        num, content = parts[0], parts[1]
        # v1のノートタイプにはNum/Contentの他にEnglishText/JapaneseTextが
        # 手で足されていることがある(2026-08-20時点では全ノートで空)。
        # 中身が入っていたら移行先が無いので止める。
        for extra in parts[2:]:
            if extra.strip():
                raise MigrationError(
                    f"note {nid}: Num/Content以外のフィールドに内容があります"
                    f"({extra[:40]}…)。移行先が決まらないため中止します。"
                )
        values = parse_v1_content(num, content)
        if values["_num_in_content"] != num:
            verbose(
                f"  ⚠ note {nid}: Numフィールド({num})とContent内の表示"
                f"(No.{values['_num_in_content']})が食い違っています。Numフィールドを採用します。"
            )
        if values["_examples"] > max_examples:
            raise MigrationError(
                f"note {nid}: 例文が {values['_examples']} 件あり、移行先の "
                f"{max_examples} 件を超えます。build_shuujuku_v1.MAX_EXAMPLES を"
                "増やしてから実行してください。"
            )
        new_fields = fields_for(v2_def, values)
        total_tags += values["_sound_tags_total"]
        kept_tags += sum(len(SOUND_TAG_RE.findall(f)) for f in new_fields)
        converted.append((nid, num, values, new_fields))

    verbose(
        f"変換の下見: {len(converted)} 件すべて解析できました "
        f"(音声タグ {total_tags} 個中 {kept_tags} 個を新フィールドへ引き継ぎ)"
    )
    if total_tags != kept_tags:
        raise MigrationError(
            f"音声タグの数が合いません(元 {total_tags} / 移行後 {kept_tags})。"
            "例文以外の場所にタグが入っている可能性があるため中止します。"
        )

    sample_nid, sample_num, _v, sample_fields = converted[0]
    verbose(f"\n--- 変換例 (note {sample_nid}, Num={sample_num}) ---")
    for f, value in zip(v2_def["fields"], sample_fields):
        shown = value if len(value) <= 70 else value[:70] + "…"
        verbose(f"  {f['anki_name']:<12} = {shown or '(空欄)'}")

    if not apply:
        verbose(
            "\n[下見のみ] 何も書き換えていません。実際に移行するには --apply を付けて実行してください。"
        )
        return 0

    # --- ここから書き換え ---
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(backup_dir, f"collection_before_shuujuku_v2_{stamp}.anki2")
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(col_path + suffix):
            shutil.copy2(col_path + suffix, backup_path + suffix)
    verbose(f"\nバックアップを作成しました: {backup_path}")

    verbose("ノートタイプを用意します...")
    csums = ensure_v2_notetype(
        col_path, v2_def, [f[0] for _n, _m, _v, f in converted], verbose=verbose
    )

    new_mid = v2_def["model_id"]
    sort_index = v2_def["anki_model"]["sortf"]
    now = int(datetime.datetime.now().timestamp())
    now_ms = now * 1000

    con = connect(col_path)
    try:
        cards_before = con.execute("select count(*) from cards").fetchone()[0]
        revlog_before = con.execute("select count(*) from revlog").fetchone()[0]

        for nid, _num, _values, new_fields in converted:
            # csumは第1フィールド(DeckTitle)から作られる。全ノートで同じ値に
            # なるが、これは参照元の「ATSU表現・構文120選」ノートタイプと同じ
            # 構造(先頭がDeckTitle)にした結果で、genankiが出力するapkgとも
            # 一致する。Ankiのブラウザ上で重複マークが付くだけで、guidによる
            # 同一性判定・出力・同期には影響しない。
            # sfldはソートフィールド(sortf=1、Num)の値。
            con.execute(
                "update notes set mid=?, flds=?, sfld=?, csum=?, mod=?, usn=-1 where id=?",
                (
                    new_mid,
                    "\x1f".join(new_fields),
                    new_fields[sort_index],
                    csums[new_fields[0]],
                    now,
                    nid,
                ),
            )

        # スキーマ変更として扱わせる(次回の同期でフルアップロードを求められる)。
        con.execute("update col set scm=?, mod=?, usn=-1", (now_ms, now_ms))
        con.commit()

        cards_after = con.execute("select count(*) from cards").fetchone()[0]
        revlog_after = con.execute("select count(*) from revlog").fetchone()[0]
        left = con.execute("select count(*) from notes where mid=?", (v1_mid,)).fetchone()[0]
        moved = con.execute("select count(*) from notes where mid=?", (new_mid,)).fetchone()[0]
        integrity = con.execute("pragma integrity_check").fetchone()[0]
    finally:
        con.close()

    verbose(f"\n移行しました: {moved} 件が新ノートタイプへ / v1に残り {left} 件")
    verbose(f"  cards: {cards_before} → {cards_after}(変わらないこと) ")
    verbose(f"  revlog: {revlog_before} → {revlog_after}(変わらないこと)")
    verbose(f"  integrity_check: {integrity}")
    if cards_before != cards_after or revlog_before != revlog_after:
        raise MigrationError(
            "cards/revlogの件数が変わっています。バックアップから戻して調査してください: "
            + backup_path
        )
    verbose(
        "\n完了しました。Ankiを起動して習熟用デッキを確認し、"
        "同期では必ず「アップロード」を選んでください。"
    )
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="習熟用ノートをv1(Num/Content)からv2(1文=1フィールド)へ学習履歴ごと移行する。"
    )
    parser.add_argument("--collection", help="collection.anki2のパス(既定: %%APPDATA%%\\Anki2から自動検出)")
    parser.add_argument("--apply", action="store_true", help="実際に書き換える(既定は下見のみ)")
    parser.add_argument(
        "--backup-dir", default=DEFAULT_BACKUP_DIR, help=f"バックアップ先(既定: {DEFAULT_BACKUP_DIR})"
    )
    args = parser.parse_args(argv)

    try:
        col_path = find_collection_path(args.collection)
        return migrate(col_path, apply=args.apply, backup_dir=args.backup_dir)
    except MigrationError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
