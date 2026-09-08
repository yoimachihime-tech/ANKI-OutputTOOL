#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/migrate_grammar_multi_answerja.py
----------------------------------------
Ankiコレクション上の「Grammar Multi (文法・複数出題形式)」ノートタイプを、
2026-09-08の新しい定義へ**学習履歴を保ったまま**移行する。

【何を直すための移行か】
片桐から2点の報告を受けた(実データ178ノート・515カードで裏付けを取った)。

  (1)「選択問題の表面に答えが出てきてしまっている」
      → カード3「3. 理由想起」。表が Question + Choices + AnswerPlain で、
        選択肢と正解が同時に出ていた。表に答えを出すのは2026-08-29に
        入れた意図どおりの設計(「なぜこの答えになるのか説明できますか?」)
        だったが、出題として成立していないと判断されていた: 片桐が目にした
        61枚のうち47枚が保留され、**うち46枚は一度も回答せずに保留**。
      → 表から答えを外すとカード1「1. 判断問題」と同一内容になるため、
        答えを外すのではなく**出題形式ごと差し替えた**(片桐の選択:
        「削除して他の出題方法を検討」)。新形式は「3. 誤答理由の想起」で、
        表は Question + Choices のみ、問いは「正解を選び、他の選択肢が
        なぜ誤りかを説明できますか?」。**Answer も AnswerPlain も表に
        出さない**。

  (2)「答えの候補がない状態で答える問題形式の場合、空白に入る単語の候補が
      多すぎで絞れない。最低限日本語訳を載せて貰えれば想定出来る状態」
      → カード2「2. セルフチェック」。表が Question だけで、選択肢も
        日本語訳も無かった(実例: 'The suspect strongly denied ___ the
        stolen painting to the collector.' → selling / stealing / taking …
        と候補が絞れない)。目にした27枚中15枚が一度も回答せずに保留され、
        15枚すべてが選択問題だった。
      → `AnswerJA`(正解文の日本語訳)フィールドを追加し、カード2の表に出す。
        **ExampleJA を流用してはいけない** —— あれは Example(別の例文)の訳で
        あって問題文の訳ではないので、別の文の意味をヒントとして見せることに
        なる。だからフィールドの追加が必要になっている。

この移行では:
  1. `AnswerJA` フィールドを**末尾に追加**する
  2. テンプレートの ord=2 を「3. 理由想起」→「3. 誤答理由の想起」へ
     作り直し、カード2の表に `{{AnswerJA}}` を出す(定義は共有JSONから読む)
  3. 既存ノートの `AnswerJA` を Gemini の翻訳で埋める(`--translate` で
     先にキャッシュを作り、`--apply` がそれを読む。下記「実行手順」)

【なぜテンプレートを削除せず作り直すのか】
削除して別のテンプレートを足すと ord がずれ、既存175枚のカードIDと復習履歴を
捨てることになる。スロットを作り直せば、選択問題の87枚はカードIDのまま新しい
出題形式に変わり、履歴も残る。

ただし新しい ord=2 は `req` が all[Choices] になるため、**選択肢を持たない
ノート(誤り訂正・記述式)の ord=2 は空カードになる**。これは意図した結果で、
移行後に [ツール]→[空のカードを削除] で消すこと(件数と失われる復習回数は
下見で表示する)。

【!! 新しいapkgを取り込む前に、必ずこの移行を先に済ませること !!】
ツールが出力するノートタイプは11フィールドになった。**移行していない
コレクション(10フィールド)に新しいapkgを取り込むと、Ankiは同じ名前で
別IDのノートタイプ「Grammar Multi (文法・複数出題形式)+」を作ってしまう**
(2026-08-21のExampleBlank追加時に実データのコピーで確認済みの挙動)。

【実行手順】
1. 日本語訳をGeminiに作らせてキャッシュへ書き出す(**コレクションには触らない**。
   普通のPythonで動く。config.json の gemini_api_key / gemini_model を使う):

       C:\\Python314\\python.exe tools/migrate_grammar_multi_answerja.py \\
           --translate --apkg "temp/02.単語・MindTips__文法・用法.apkg"

   `--apkg` を渡すとエクスポート済みのapkgから英文を読む(Ankiを起動したままで
   よい)。渡さなければコレクションを読む(Ankiは終了しておくこと)。
   キャッシュは `temp/grammar_multi_answerja.json`。**呼び出しが途中で失敗
   しても成功分は保存する**ので、再実行すると足りない分だけを取りに行く
   (無料枠の1日あたり上限に当たったとき、翌日に続きから再開できる)。

2. **Ankiを終了**して、コレクションを書き換える(`anki`パッケージのある
   実行環境で動かすこと。genankiは使わない):

       "%LOCALAPPDATA%\\AnkiProgramFiles\\.venv\\Scripts\\python.exe" \\
           tools/migrate_grammar_multi_answerja.py            # 下見(何も書き換えない)
       ...同上... tools/migrate_grammar_multi_answerja.py --apply   # 実際に書き換える

3. Ankiを起動し、[ツール]→[空のカードを削除] を実行する。
4. 同期は**必ず「アップロード」**を選ぶ(フィールド追加=スキーマ変更のため)。

【学習履歴について】
notes の flds(AnswerJAの追加)と notetype 定義だけを変更し、cards/revlog は
直接触らない。ノートID・カードIDは変わらないので、既存カードの間隔・FSRSの
状態・復習履歴はそのまま残る(migrate_grammar_multi_answerplain.py と同じ方針)。

【colテーブルのusnは絶対に触らないこと】
notes/cards/revlogの usn = -1 は「ローカルで変更した、未アップロード」の印だが、
**colテーブルのusnは「最後に同期が成功した時点のサーバ側USN」**という別物。
ここを-1にすると以後の同期のたびにコレクションのほぼ全体が送り直されてくる
(2026-08-20に実際に起こして tools/repair_sync_usn.py で復旧した)。
このスクリプトは col.models.update_dict / col.update_note しか使わず、
usn には一切触らない。
"""

import argparse
import datetime
import io
import json
import os
import re
import shutil
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED_DEFS_PATH = os.path.join(BASE_DIR, "docs", "shared", "card_defs.json")
DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")
DEFAULT_CACHE_PATH = os.path.join(BASE_DIR, "temp", "grammar_multi_answerja.json")

NOTETYPE_NAME = "Grammar Multi (文法・複数出題形式)"
NEW_FIELD = "AnswerJA"

# 移行前のコレクション側のテンプレート名。ord=2 の名前だけが変わる。
OLD_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "3. 理由想起", "4. 例文穴埋め"]
NEW_TEMPLATES = ["1. 判断問題", "2. セルフチェック", "3. 誤答理由の想起", "4. 例文穴埋め"]

WHYNOT_ORD = 2  # 作り直す「3. 誤答理由の想起」。移行後は選択肢ありノートにだけ生える

SOUND_TAG_RE = re.compile(r"(<br\s*/?>\s*)?\[sound:[^\]]+\]", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")
# 先頭の正解ラベル。「(A) 」のほか、旧・手書きノートの「(A) &mdash; 」
# 「(A) — 」という区切り付きの形にも対応する(実データで両方を確認)。
# 選択肢は(A)〜(D)しか使わないので範囲を絞ってあり、"(I) am ..." のような
# 正当な文を巻き込まない。migrate_grammar_multi_answerplain.py と同じ正規表現。
OPT_PREFIX_RE = re.compile(
    r"^\s*(?:<[^>]+>\s*)*\(\s*[A-Da-d]\s*\)\s*(?:&mdash;|&ndash;|—|–|-|:)?\s*"
)

# Choices フィールドの各選択肢。「(A) text」の text だけを取り出す。
CHOICE_RE = re.compile(r'<div class="choice">\s*\(([A-Da-d])\)\s*(.*?)</div>', re.S)
# Question の英文中の空所。実データで確認した4形。長いものから順に試す
# (「(     )」は「( )」より先に当てないと、括弧だけが残る)。
BLANK_RE = re.compile(r"_{2,}|-{3,}|\(\s{2,}\)|\(\s*\)|（\s*）")


def default_collection_path() -> str:
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Anki2", "ユーザー 1", "collection.anki2",
    )


def source_sentence(answer_html: str, answer_plain: str) -> str:
    """翻訳にかける英文を作る。

    AnswerPlain があればそれを、無ければ Answer から正解ラベルと音声タグを
    剥がしたものを使う(実データでは3件だけ AnswerPlain が空だった)。
    タグは訳文に混ざらないよう落としておく。
    """
    src = (answer_plain or "").strip() or (answer_html or "")
    if not src:
        return ""
    src = OPT_PREFIX_RE.sub("", SOUND_TAG_RE.sub("", src))
    src = TAG_RE.sub("", src)
    return " ".join(src.split())


def choice_texts(choices_html: str) -> list:
    """Choices フィールドから、選択肢の本文だけのリストを返す(記号は落とす)。"""
    out = []
    for _opt, text in CHOICE_RE.findall(choices_html or ""):
        out.append(" ".join(TAG_RE.sub("", text).split()))
    return out


def fill_blank_from_question(question_html: str, filler: str) -> str:
    """Question の英文の空所に正解語句を入れて、完全な英文にして返す。

    **なぜ必要か**: 既存データには `answer` が完全な英文ではなく**空所に入る
    語句だけ**のノートが9件ある(共有プロンプトの規則6は2026-08-29に
    「必ず完全な英文1文」と定めたが、それ以前に生成されたもの)。この場合
    `AnswerPlain` をそのまま訳すと `of` → 「の」、`once again` → 「もう一度」
    のようになり、**文の意味のヒントにならないうえ、正解の語をそのまま
    日本語で書いた状態がカード2の表に出てしまう**(選択肢を伏せている意味が
    無くなる)。そこで Question 側の英文の空所を埋めて、文として訳す。

    英文は日本語の指示文の後ろに単一引用符で囲んで置く決まり(共有プロンプトの
    規則4)なので、最初の `'` から最後の `'` までを英文とみなす。引用符が
    見つからない・空所が見つからない場合は空文字を返す(呼び出し側が
    従来どおり AnswerPlain を使えるように)。
    """
    if not question_html or not filler:
        return ""
    text = re.sub(r"(?i)<br\s*/?>", " ", question_html)
    text = " ".join(TAG_RE.sub("", text).split())
    first, last = text.find("'"), text.rfind("'")
    if first < 0 or last <= first:
        return ""
    english = text[first + 1:last].strip()
    if not BLANK_RE.search(english):
        return ""
    return " ".join(BLANK_RE.sub(filler, english, count=1).split())


def load_shared_notetype() -> dict:
    with io.open(SHARED_DEFS_PATH, encoding="utf-8") as f:
        defs = json.load(f)["defs"]
    return defs["grammar_multi"]["anki_model"]


def load_cache(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with io.open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print("翻訳キャッシュを読めませんでした(%s)。空として扱います: %s" % (e, path))
        return {}
    return data if isinstance(data, dict) else {}


def save_cache(path: str, data: dict) -> None:
    """json_store.write_json と同じ理由で、一時ファイルへ書き切ってから
    os.replace で差し替える(このフォルダはGoogle Drive同期下にあり、
    書き込み中に落ちると中途半端なJSONだけが残るため)。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def collect_sentences(col) -> dict:
    """「日本語訳が要るノート」の {nid文字列: 英文} を返す。

    要るのは**選択肢を持つノート(選択問題)だけ**。AnswerJA を表に出すのは
    カード2「2. セルフチェック」で、これは req が all[Choices] なので
    選択肢の無いノートには生えない —— 訳を作っても表示されるところが無く、
    Gemini の呼び出しを無駄にすることになる。
    """
    out = {}
    for nid in col.find_notes('note:"%s"' % NOTETYPE_NAME):
        note = col.get_note(nid)
        names = [f["name"] for f in note.note_type()["flds"]]
        idx = dict((n, i) for i, n in enumerate(names))
        if "Choices" not in idx or not note.fields[idx["Choices"]].strip():
            continue
        if NEW_FIELD in idx and note.fields[idx[NEW_FIELD]].strip():
            continue  # 既に埋まっている
        plain = note.fields[idx["AnswerPlain"]] if "AnswerPlain" in idx else ""
        sentence = source_sentence(note.fields[idx["Answer"]], plain)
        # 回答が選択肢そのもの(=空所に入る語句だけ)なら、それを訳しても
        # 文の意味にならず正解語の和訳が表に出るだけなので、Question の
        # 英文の空所を埋めて文にしてから訳す(fill_blank_from_question)。
        opts = [t.lower() for t in choice_texts(note.fields[idx["Choices"]])]
        if sentence and sentence.lower() in opts:
            built = fill_blank_from_question(note.fields[idx["Question"]], sentence)
            if built:
                sentence = built
        if sentence:
            out[str(nid)] = sentence
    return out


def collect_sentences_from_apkg(apkg_path: str) -> dict:
    sys.path.insert(0, BASE_DIR)
    import tts_core

    work = os.path.join(BASE_DIR, "temp", "answerja_work.anki2")
    os.makedirs(os.path.dirname(work), exist_ok=True)
    col = tts_core.load_collection(apkg_path, work)
    try:
        return collect_sentences(col)
    finally:
        try:
            col.close()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# --translate: Geminiで日本語訳を作ってキャッシュへ書き出す
#              (コレクションは一切書き換えない)
# ---------------------------------------------------------------------------

def _resolve_gemini_settings(args):
    api_key = args.gemini_api_key
    model = args.gemini_model
    if not api_key or not model:
        cfg_path = os.path.join(BASE_DIR, "config.json")
        cfg = {}
        if os.path.exists(cfg_path):
            with io.open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
        api_key = api_key or cfg.get("gemini_api_key", "")
        model = model or cfg.get("gemini_model", "")
    return api_key, model


def run_translate(args) -> int:
    sys.path.insert(0, BASE_DIR)
    import gemini_client

    api_key, model = _resolve_gemini_settings(args)
    if not api_key:
        print("Gemini APIキーが見つかりません"
              "(config.json の gemini_api_key、または --gemini-api-key)。")
        return 1
    if not model:
        print("Geminiのモデル名が見つかりません"
              "(config.json の gemini_model、または --gemini-model)。")
        return 1

    if args.apkg:
        if not os.path.exists(args.apkg):
            print("apkgが見つかりません: %s" % args.apkg)
            return 1
        needed = collect_sentences_from_apkg(args.apkg)
    else:
        try:
            from anki.collection import Collection
        except ImportError:
            print("コレクションから読むには ankiパッケージが必要です。")
            print("--apkg でエクスポート済みのapkgを渡すこともできます。")
            return 1
        col = Collection(args.collection)
        try:
            needed = collect_sentences(col)
        finally:
            col.close()

    cache = load_cache(args.cache)
    todo = dict((k, v) for k, v in needed.items() if not cache.get(k))
    print("日本語訳が要るノート: %d 件" % len(needed))
    print("  キャッシュに既にある : %d 件" % (len(needed) - len(todo)))
    print("  これから翻訳する     : %d 件" % len(todo))
    if not todo:
        print("翻訳するものがありません。")
        return 0
    calls = (len(todo) + args.batch_size - 1) // args.batch_size
    print("  Gemini呼び出し回数   : 約%d回 (モデル: %s)" % (calls, model))

    keys = sorted(todo)
    done = 0
    # バッチ単位でキャッシュへ書き出す。途中で失敗しても成功分は残るので、
    # 再実行で足りない分だけを取りに行ける(無料枠の1日あたり上限に当たった
    # 場合、翌日に続きから再開できる)。
    for i in range(0, len(keys), args.batch_size):
        part = keys[i:i + args.batch_size]
        try:
            jas = gemini_client.translate_to_japanese(
                [todo[k] for k in part], api_key, model,
                batch_size=args.batch_size,
            )
        except Exception as e:  # noqa: BLE001
            print("翻訳に失敗しました(%d〜%d件目): %s" % (i + 1, i + len(part), e))
            save_cache(args.cache, cache)
            print("ここまでの %d 件をキャッシュに保存しました: %s" % (done, args.cache))
            print("同じコマンドで再実行すると、足りない分だけを取りに行きます。")
            return 1
        for k, ja in zip(part, jas):
            if ja:
                cache[k] = ja
                done += 1
        save_cache(args.cache, cache)
        print("  %d/%d 件" % (min(i + len(part), len(keys)), len(keys)))

    print("%d 件の日本語訳をキャッシュへ保存しました: %s" % (done, args.cache))
    missing = [k for k in keys if not cache.get(k)]
    if missing:
        print("訳せなかったノート: %d 件 (nid: %s%s)" % (
            len(missing), ", ".join(missing[:10]), " …" if len(missing) > 10 else ""))
        print("再実行すると、この分だけをもう一度取りに行きます。")
    print()
    print("次は Anki を終了して、--apply でコレクションを書き換えてください。")
    return 0


# ---------------------------------------------------------------------------
# 下見 / --apply: コレクションの書き換え
# ---------------------------------------------------------------------------

def backup_collection(col_path: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(
        backup_dir, "collection_before_grammar_multi_answerja_%s.anki2" % stamp)
    shutil.copy2(col_path, dest)
    return dest


def run_migrate(args) -> int:
    try:
        from anki.collection import Collection
    except ImportError:
        print("ankiパッケージが必要です。Anki同梱のvenvのpython.exeで実行してください。")
        print("  例: %LOCALAPPDATA%\\AnkiProgramFiles\\.venv\\Scripts\\python.exe")
        return 1

    shared = load_shared_notetype()
    shared_tmpls = shared["tmpls"]
    shared_names = [t["name"] for t in shared_tmpls]
    if shared_names != NEW_TEMPLATES:
        print("共有定義のテンプレート構成が想定と違います: %s" % shared_names)
        print("想定: %s" % NEW_TEMPLATES)
        print("先に `python tools/export_shared_card_defs.py` を実行してください。")
        return 1
    shared_fields = [f["name"] for f in shared["flds"]]
    if NEW_FIELD not in shared_fields:
        print("共有定義に %s がありません: %s" % (NEW_FIELD, shared_fields))
        print("先に `python tools/export_shared_card_defs.py` を実行してください。")
        return 1

    cache = load_cache(args.cache)
    if not cache and args.apply and not args.allow_empty_translations:
        print("翻訳キャッシュが空です: %s" % args.cache)
        print("先に --translate を実行してください(日本語訳が入らないと、")
        print("カード2の表は従来どおり手がかり無しのままになります)。")
        print("訳なしで先にノートタイプだけ移行したい場合は")
        print("--allow-empty-translations を付けてください。")
        return 1

    if args.apply:
        dest = backup_collection(args.collection, args.backup_dir)
        print("バックアップを作成しました: %s" % dest)

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

        field_names = [f["name"] for f in nt["flds"]]
        tmpl_names = [t["name"] for t in nt["tmpls"]]
        print("対象ノートタイプ: %s" % NOTETYPE_NAME)
        print("  現在のフィールド    : %s" % field_names)
        print("  現在のテンプレート  : %s" % tmpl_names)

        if tmpl_names not in (OLD_TEMPLATES, NEW_TEMPLATES):
            print()
            print("!! テンプレート構成が想定と違います。想定:")
            print("   移行前: %s" % OLD_TEMPLATES)
            print("   移行後: %s" % NEW_TEMPLATES)
            print("   手動で確認してから実行してください(このスクリプトは中断します)。")
            return 1
        if "AnswerPlain" not in field_names:
            print()
            print("!! AnswerPlain がありません。先に")
            print("   tools/migrate_grammar_multi_answerplain.py を当ててください。")
            return 1

        add_field = NEW_FIELD not in field_names
        idx = dict((n, i) for i, n in enumerate(field_names))

        will_fill, already, no_cache, not_choice = [], 0, 0, 0
        # 移行後に ord=2 が空カードになるノート(=Choicesが空)のうち、既に
        # そのカードを持っているものの枚数と、溜まっている復習回数。
        empty_whynot, lost_reviews = 0, 0
        nids = col.find_notes('note:"%s"' % NOTETYPE_NAME)
        for nid in nids:
            note = col.get_note(nid)
            if not note.fields[idx["Choices"]].strip():
                not_choice += 1
                for c in note.cards():
                    if c.ord != WHYNOT_ORD:
                        continue
                    empty_whynot += 1
                    lost_reviews += col.db.scalar(
                        "select count(*) from revlog where cid = ?", c.id) or 0
                continue
            if not add_field and note.fields[idx[NEW_FIELD]].strip():
                already += 1
                continue
            ja = cache.get(str(nid))
            if ja:
                will_fill.append((nid, ja))
            else:
                no_cache += 1

        print()
        print("ノート数: %d" % len(nids))
        print("  AnswerJA を埋める(選択問題)        : %d 件" % len(will_fill))
        print("  既に埋まっているので触らない        : %d 件" % already)
        print("  訳がキャッシュに無い                : %d 件" % no_cache)
        if no_cache:
            print("     (--translate を実行すると埋まる。空のままでもカードは")
            print("      作られるが、表に日本語訳が出ないので手がかりが無い)")
        print("  選択肢が無いので対象外              : %d 件" % not_choice)
        print("     (AnswerJAを出すカード2は選択肢のあるノートにしか生えない)")
        print()
        print("  → 空カードになる ord=2 のカード     : %d 枚" % empty_whynot)
        print("     (選択肢を持たないノートの分。新しい ord=2")
        print("      「3. 誤答理由の想起」は req が all[Choices] になるため。")
        print("      [ツール]→[空のカードを削除] で消すこと。放置すると復習時に")
        print("      「The front of this card is blank.」として出題されてしまう。")
        print("      削除で失われる復習履歴: %d 回)" % lost_reviews)
        print()
        print("%sフィールド: %s" % ("追加する" if add_field else "既にある", NEW_FIELD))
        print("テンプレート(名前・qfmt・afmt)とCSSを共有定義の内容へ置き換えます。")
        print("  ord=2 のテンプレート名: %s → %s"
              % (tmpl_names[WHYNOT_ORD], NEW_TEMPLATES[WHYNOT_ORD]))

        if will_fill:
            nid, ja = will_fill[0]
            note = col.get_note(nid)
            print()
            print("埋める内容の例:")
            print("  Answer  : %s" % note.fields[idx["Answer"]][:110])
            print("  AnswerJA: %s" % ja[:110])

        if not args.apply:
            print()
            print("下見のみで終了しました。実際に書き換えるには --apply を付けてください。")
            return 0

        # --- ここから書き換え ---
        if add_field:
            col.models.add_field(nt, col.models.new_field(NEW_FIELD))
        # テンプレートは**ordの順に**当てる(ord=2は名前が変わるので、
        # 名前で引くと見つからない)。
        for i, t in enumerate(nt["tmpls"]):
            src = shared_tmpls[i]
            t["name"] = src["name"]
            t["qfmt"] = src["qfmt"]
            t["afmt"] = src["afmt"]
        nt["css"] = shared["css"]
        col.models.update_dict(nt)
        print("ノートタイプ定義を更新しました(フィールド追加・テンプレート・CSS)。")

        # フィールド追加でインデックスが確定するので取り直す
        nt = col.models.by_name(NOTETYPE_NAME)
        ja_idx = [f["name"] for f in nt["flds"]].index(NEW_FIELD)
        for nid, ja in will_fill:
            note = col.get_note(nid)
            note.fields[ja_idx] = ja
            col.update_note(note)
        print("%d 件の AnswerJA を埋めました。" % len(will_fill))

        print()
        print("完了しました。Ankiを起動して表示を確認し、[ツール]→[空のカードを削除] を")
        print("実行してから、同期は必ず「アップロード」を選んでください。")
        return 0
    finally:
        try:
            col.close()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Grammar Multi に AnswerJA を足し、ord=2 を作り直す移行")
    ap.add_argument("--collection", default=default_collection_path())
    ap.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    ap.add_argument("--cache", default=DEFAULT_CACHE_PATH,
                    help="日本語訳のキャッシュ(--translateが書き、--applyが読む)")
    ap.add_argument("--translate", action="store_true",
                    help="Geminiで日本語訳を作りキャッシュへ保存する(コレクションは触らない)")
    ap.add_argument("--apkg", default="",
                    help="--translate時、コレクションの代わりに読むapkg(Anki起動中でも可)")
    ap.add_argument("--gemini-api-key", default="")
    ap.add_argument("--gemini-model", default="")
    ap.add_argument("--batch-size", type=int, default=30,
                    help="1回のGemini呼び出しで訳す件数(既定30)")
    ap.add_argument("--apply", action="store_true",
                    help="実際に書き換える(既定は下見のみ)")
    ap.add_argument("--allow-empty-translations", action="store_true",
                    help="翻訳キャッシュが空でも --apply を進める")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    if args.translate:
        return run_translate(args)

    if not os.path.exists(args.collection):
        print("コレクションが見つかりません: %s" % args.collection)
        return 1
    return run_migrate(args)


if __name__ == "__main__":
    sys.exit(main())
