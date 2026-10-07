#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/backfill_meaning_questions.py
-----------------------------------
Ankiコレクションにある「AIに質問」(Grammar Multi)のうち、**まだ出題されて
いないもの**について、2026-10-07に足した「意味・本質問題」を後から作って
コレクションへ直接追加する。

【なぜ必要か】
新しく「AIに質問」で生成した分には、3問と一緒に意味・本質問題が作られる
(gemini_client.build_grammar_multi_items)。それより前に作ってAnkiへ取り込み
済みで、まだ出題されていない問題には意味・本質問題が無いので、それを足す
(片桐の依頼: 「まだ出て来ていない新規のものに対して、今回の修正を反映したい」)。

【どうやって質問ごとにまとめるか】
Ankiのノートには元の質問文が残っていない。ただし1つの質問から作った3問は、
同じ .apkg に「選択問題 → 誤り訂正問題 → 記述式・書き換え問題」の順で
並んでおり、ノートIDが作成時刻なので数ミリ秒差で続いている。そこで
「5秒以上空いた」か「出題形式の順番が戻った」ところで区切る。
区切りを1つ間違えても、意味・本質問題がその分少し的外れになるだけで、
既存のノートには一切触れない。

【処理の流れ(2段階)】
1. --generate … まだ出題されていない問題をまとめてGeminiに渡し、意味・本質
   問題だけを作らせて temp/meaning_backfill.json へ保存する。**コレクションは
   読むだけ**。途中で失敗しても成功した分は保存され、再実行すると足りない分
   だけを取りに行く。
2. --apply  … キャッシュから意味・本質問題のノートを作り、コレクションへ
   追加する。例文に音声(PC版の config.json の音声設定)を付け、新規カードの
   位置を「文法・用法」デッキの末尾に並べる。引数なしは下見のみ。

どちらも**Ankiを終了してから**、Anki本体と同じ版の anki パッケージで動かす。

    C:\\Python314\\python.exe tools/backfill_meaning_questions.py --generate
    C:\\Python314\\python.exe tools/backfill_meaning_questions.py           # 下見
    C:\\Python314\\python.exe tools/backfill_meaning_questions.py --apply

【作る問題の質】
プロンプトの規則は docs/shared/grammar_multi_prompt.txt の意味・本質問題の節を
そのまま使い、応答は docs/shared/grammar_multi_response_schema.json の
meaning の構造で受け取る。使えない問題を捨てる判定(接頭辞・接尾辞、英語の語句が
無い、正解だけ長い、など)も gemini_client の同じ関数を通す。新規生成と
基準が食い違わないようにするため、ここに別の規則を書かないこと。
加えて、**同じ語句を問う問題は1問だけ**にする(同じ内容の質問を何度か投げて
いる場合があるため)。

【colテーブルのusnは絶対に触らないこと】(tools/repair_sync_usn.py を参照)
このスクリプトは col.add_note / col.sched.reposition_new_cards /
generate_tts_for_collection しか使わず、usn を直接書き換えない。
"""

import argparse
import datetime
import io
import json
import os
import re
import shutil
import sqlite3
import sys
import urllib.parse
import uuid

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import gemini_client  # noqa: E402

DEFAULT_BACKUP_DIR = os.path.join(BASE_DIR, "backup")
DEFAULT_CACHE_PATH = os.path.join(BASE_DIR, "temp", "meaning_backfill.json")
SCHEMA_PATH = os.path.join(BASE_DIR, "docs", "shared", "grammar_multi_response_schema.json")

NOTETYPE_NAME = "Grammar Multi (文法・複数出題形式)"
DECK_NAME = "02.単語・MindTips::文法・用法"
PATTERN_RANK = {"選択問題": 0, "誤り訂正問題": 1, "記述式・書き換え問題": 2}
GROUP_GAP_MS = 5000

# Grammar Multi のフィールド名 → item のキー
FIELD_KEYS = [
    ("Pattern", "pattern"), ("Question", "question"), ("Choices", "choices"),
    ("Answer", "answer"), ("Example", "example"), ("ExampleJA", "example_ja"),
    ("Why", "why"), ("WhyNot", "whynot"), ("ExampleBlank", "example_blank"),
    ("AnswerPlain", "answer_plain"), ("AnswerJA", "answer_ja"),
]

TAG_RE = re.compile(r"<[^>]+>")
SOUND_RE = re.compile(r"\[sound:[^\]]+\]")


def default_collection_path() -> str:
    return os.path.join(
        os.environ.get("APPDATA", os.path.expanduser("~")),
        "Anki2", "ユーザー 1", "collection.anki2",
    )


def plain(html: str) -> str:
    text = SOUND_RE.sub("", html or "")
    text = re.sub(r"(?i)<br\s*/?>", " ", text)
    text = TAG_RE.sub(" ", text)
    return " ".join(text.replace("&nbsp;", " ").split())


# ---------------------------------------------------------------------------
# 未出題の問題を、質問ごとのまとまりに分ける
# ---------------------------------------------------------------------------

def unseen_groups(col_path: str) -> list:
    """[(group_key, [ノートのdict, ...]), ...] を返す(読むだけ)。

    未出題 = そのノートのどのカードにも回答が無い(reps=0)。ただしカードが
    すべて保留になっているノートは除く(片桐が「問題になっていない」と判断して
    よけたもの)。"""
    uri = "file:" + urllib.parse.quote(col_path.replace("\\", "/")) + "?mode=ro"
    db = sqlite3.connect(uri, uri=True)
    try:
        # notetypes.name は Anki 独自の照合順序(unicase)付きなので、素の sqlite では
        # WHERE で比較できない。全件読んで Python 側で探す。
        mids = [i for i, n in db.execute("select id, name from notetypes") if n == NOTETYPE_NAME]
        if not mids:
            raise SystemExit("ノートタイプが見つかりません: %s" % NOTETYPE_NAME)
        mid = mids[0]
        names = [r[0] for r in db.execute(
            "select name from fields where ntid = ? order by ord", (mid,))]
        idx = {n: i for i, n in enumerate(names)}
        stats = {}
        for nid, reps, queue in db.execute(
                "select c.nid, c.reps, c.queue from cards c join notes n on c.nid = n.id"
                " where n.mid = ?", (mid,)):
            s = stats.setdefault(nid, [0, 0, 0])  # reps合計, カード数, 保留数
            s[0] += reps
            s[1] += 1
            s[2] += queue == -1
        notes = []
        for nid, flds in db.execute("select id, flds from notes where mid = ? order by id", (mid,)):
            reps, n_cards, n_susp = stats.get(nid, [0, 0, 0])
            if reps or n_cards == 0 or n_susp == n_cards:
                continue
            f = flds.split("\x1f")
            notes.append({
                "nid": nid,
                "pattern": f[idx["Pattern"]],
                "question": plain(f[idx["Question"]]),
                "choices": plain(f[idx["Choices"]]),
                "answer": plain(f[idx["Answer"]]),
                "why": plain(f[idx["Why"]]),
            })
    finally:
        db.close()

    groups = []
    for note in notes:
        rank = PATTERN_RANK.get(note["pattern"], 0)
        if (not groups
                or note["nid"] - groups[-1][-1]["nid"] > GROUP_GAP_MS
                or rank <= PATTERN_RANK.get(groups[-1][-1]["pattern"], 0)):
            groups.append([])
        groups[-1].append(note)
    return [("g%d" % g[0]["nid"], g) for g in groups]


# ---------------------------------------------------------------------------
# --generate
# ---------------------------------------------------------------------------

def meaning_rules() -> str:
    """共有プロンプトの「意味・本質問題」の節(規則 M1〜M6)を取り出す。"""
    text = gemini_client._load_shared_prompt(gemini_client.GRAMMAR_MULTI_PROMPT_PATH)
    start = text.index("意味・本質問題とは")
    end = text.index("以下のJSON形式で")
    return text[start:end].strip()


def build_prompt(batch: list) -> str:
    lines = []
    for i, (_key, notes) in enumerate(batch, start=1):
        lines.append("[%d]" % i)
        for n in notes:
            lines.append("  - %s: %s" % (n["pattern"], n["question"][:400]))
            if n["choices"]:
                lines.append("    選択肢: %s" % n["choices"][:300])
            lines.append("    解答: %s" % n["answer"][:300])
            if n["why"]:
                lines.append("    解説: %s" % n["why"][:400])
    return (
        "あなたは英文法学習カードの作成アシスタントです。\n"
        "以下は、学習者の質問から作られた英文法の練習問題です。[1] [2] … の1組が、\n"
        "1つの質問から作られた問題です。組ごとに、その問題が扱っている内容について\n"
        "「意味・本質問題」を0〜3問作ってください。\n\n"
        + meaning_rules()
        + "\n\nB1. 組ごとに独立して作り、indexにはその組の番号を入れること。"
        "\nB2. 別の組と同じ語句を問う問題は作らないこと(同じ語句が複数の組に"
        "出てくる場合は、最初の組でだけ作る)。\n\n"
        "練習問題:\n" + "\n".join(lines)
        + "\n\n出力は {\"topics\": [{\"index\": 1, \"meaning\": [...]}, ...]} の形の"
        "JSONのみ。meaningの各要素の形は規則のとおり。"
    )


def response_schema() -> dict:
    with io.open(SCHEMA_PATH, encoding="utf-8") as f:
        meaning = json.load(f)["properties"]["meaning"]
    return {
        "type": "OBJECT",
        "properties": {
            "topics": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {"index": {"type": "INTEGER"}, "meaning": meaning},
                    "required": ["index", "meaning"],
                    "propertyOrdering": ["index", "meaning"],
                },
            },
        },
        "required": ["topics"],
    }


def load_cache(path: str) -> dict:
    if not os.path.exists(path):
        return {"groups": {}}
    with io.open(path, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("groups", {})
    return data


def save_cache(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def run_generate(args) -> int:
    cfg = {}
    cfg_path = os.path.join(BASE_DIR, "config.json")
    if os.path.exists(cfg_path):
        with io.open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    api_key = args.gemini_api_key or cfg.get("gemini_api_key", "")
    model = args.gemini_model or cfg.get("gemini_model", "")
    if not api_key or not model:
        print("Gemini のAPIキー・モデル名が見つかりません(config.json)。")
        return 1

    groups = unseen_groups(args.collection)
    cache = load_cache(args.cache)
    todo = [g for g in groups if g[0] not in cache["groups"]]
    print("まだ出題されていない問題: %d 件 / %d 組" % (sum(len(g[1]) for g in groups), len(groups)))
    print("  キャッシュに既にある組: %d / これから作る組: %d" % (len(groups) - len(todo), len(todo)))
    if not todo:
        return 0
    calls = (len(todo) + args.batch_size - 1) // args.batch_size
    print("  Gemini呼び出し回数: 約%d回 (モデル: %s)" % (calls, model))

    schema = response_schema()
    for start in range(0, len(todo), args.batch_size):
        batch = todo[start:start + args.batch_size]
        try:
            text = gemini_client.call_gemini(
                build_prompt(batch), api_key, model, timeout=180, response_schema=schema)
            topics = json.loads(text).get("topics") or []
        except Exception as e:  # noqa: BLE001
            print("生成に失敗しました(%d〜%d組目): %s" % (start + 1, start + len(batch), e))
            save_cache(args.cache, cache)
            print("ここまでの分は保存しました。同じコマンドで再実行すると続きから作ります。")
            return 1
        by_index = {}
        for t in topics:
            if isinstance(t, dict) and isinstance(t.get("index"), int):
                by_index.setdefault(t["index"], t.get("meaning") or [])
        for i, (key, notes) in enumerate(batch, start=1):
            cache["groups"][key] = {
                "nids": [n["nid"] for n in notes],
                "patterns": [n["pattern"] for n in notes],
                "first_question": notes[0]["question"][:120],
                # 生成1回ぶんを識別する値(guidの末尾に足す。以後変えないこと)
                "batch_key": uuid.uuid4().hex[:12],
                "meaning": by_index.get(i, []),
            }
        save_cache(args.cache, cache)
        print("  %d/%d 組" % (min(start + len(batch), len(todo)), len(todo)))
    cache["model"] = model
    cache["generated_at"] = datetime.datetime.now().isoformat(timespec="seconds")
    save_cache(args.cache, cache)
    print("保存しました: %s" % args.cache)
    return 0


# ---------------------------------------------------------------------------
# 下見 / --apply
# ---------------------------------------------------------------------------

def build_items(cache: dict, skip_targets=()) -> list:
    """キャッシュから追加するitemを作る。[(group_key, item), ...]

    skip_targets: 下見で内容を確かめて、入れないと決めた問題の target
    (--skip-target で指定する。判定の関数では見抜けない、内容の誤りや
    元の問題と食い違うものを人が外すため)。"""
    skip = {" ".join(t.lower().split()) for t in skip_targets}
    seen_targets = set()
    out = []
    for key in sorted(cache["groups"], key=lambda k: int(k[1:])):
        group = cache["groups"][key]
        kept = []
        for j, raw in enumerate(group.get("meaning") or []):
            if not gemini_client._meaning_note_from_raw(raw, "%s:%d" % (group["batch_key"], j)):
                continue
            target = " ".join(str(raw.get("target") or "").lower().split())
            if target in seen_targets or target in skip:
                continue
            seen_targets.add(target)
            kept.append(raw)
        items = gemini_client.build_grammar_multi_items(
            [], kept, "backfill %s" % key, group["batch_key"])
        out.extend((key, it) for it in items)
    return out


def backup_collection(col_path: str, backup_dir: str) -> str:
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(backup_dir, "collection_before_meaning_backfill_%s.anki2" % stamp)
    shutil.copy2(col_path, dest)
    return dest


def run_apply(args) -> int:
    from anki.collection import Collection
    import grammar_multi_builder
    import tts_core

    cache = load_cache(args.cache)
    if not cache["groups"]:
        print("キャッシュが空です。先に --generate を実行してください。")
        return 1
    pairs = build_items(cache, args.skip_target)
    raw_total = sum(len(g.get("meaning") or []) for g in cache["groups"].values())
    print("Geminiが作った意味・本質問題: %d 問 → 追加するもの: %d 問 (%d組から)"
          % (raw_total, len(pairs), len({k for k, _ in pairs})))
    for key, it in pairs:
        print("  [%s] %s" % (key, plain(it["question"])[:90]))
        print("        正解: %s | 例文: %s" % (plain(it["answer"])[:50], "あり" if it["example"] else "なし"))
    if not pairs:
        return 0
    if not args.apply:
        print()
        print("下見のみで終了しました。実際に追加するには --apply を付けてください。")
        return 0

    print("バックアップを作成しました: %s" % backup_collection(args.collection, args.backup_dir))
    col = Collection(args.collection)
    try:
        nt = col.models.by_name(NOTETYPE_NAME)
        if [t["name"] for t in nt["tmpls"]] != ["1. 判断問題", "2. セルフチェック", "4. 例文穴埋め"]:
            print("先に tools/migrate_grammar_multi_retire_card3.py を当ててください。")
            return 1
        did = col.decks.id_for_name(DECK_NAME)
        if not did:
            print("デッキが見つかりません: %s" % DECK_NAME)
            return 1
        names = [f["name"] for f in nt["flds"]]
        existing_guids = set(col.db.list("select guid from notes"))

        # 新規カードの位置: 「文法・用法」デッキ(とその下)の新規カードの末尾に続ける。
        deck_ids = [d.id for d in col.decks.all_names_and_ids() if d.name == DECK_NAME
                    or d.name.startswith(DECK_NAME + "::")]
        start_due = (col.db.scalar(
            "select max(due) from cards where type = 0 and did in %s"
            % ("(" + ",".join(str(i) for i in deck_ids) + ")")) or 0) + 1

        added = []
        for _key, it in pairs:
            guid = grammar_multi_builder.build_guid(it["topic_key"], it["note_index"], it["batch_key"])
            if guid in existing_guids:
                continue  # 再実行しても二重に足さない
            note = col.new_note(nt)
            for fname, ikey in FIELD_KEYS:
                if fname in names:
                    note[fname] = it.get(ikey, "")
            note.guid = guid
            col.add_note(note, did)
            added.append(note.id)
        print("%d 件のノートを追加しました。" % len(added))
        if not added:
            return 0

        cids = col.db.list(
            "select id from cards where nid in %s order by nid, ord"
            % ("(" + ",".join(str(n) for n in added) + ")"))
        # Ankiはノート単位で番号を振る(兄弟カードは同じ位置になる。ツールが
        # .apkgに書く位置と同じ「1ノート1番号」)。
        col.sched.reposition_new_cards(
            card_ids=cids, starting_from=start_due, step_size=1,
            randomize=False, shift_existing=False)
        end_due = col.db.scalar(
            "select max(due) from cards where id in %s" % ("(" + ",".join(str(c) for c in cids) + ")"))
        print("新規カード %d 枚を位置 %d〜%d に並べました(文法・用法デッキの末尾)。"
              % (len(cids), start_due, end_due))
        print("Web版の⚙設定「新規カードの位置」(AIに質問)は %d にしてください"
              "(次に出力するカードと位置が重ならないように)。" % (end_due + 1))

        if args.skip_tts:
            print("音声は付けませんでした(--skip-tts)。")
        else:
            cfg = tts_core.load_config()
            voice = cfg.get("voice", "")
            ex_idx = names.index("Example")
            to_process = [(nid, ex_idx) for nid in added if col.get_note(nid)["Example"].strip()]
            result = tts_core.generate_tts_for_collection(
                col, NOTETYPE_NAME, to_process,
                api_key=tts_core.tts_api_key_for_voice(voice, cfg),
                voice=voice,
                lang=cfg.get("language_code", "en-US"),
                gap_seconds=float(cfg.get("sentence_gap", 0.5)),
                bitrate=int(cfg.get("mp3_bitrate", 64)),
                per_sentence=bool(cfg.get("per_sentence_tags", False)),
                force_regen=False,
                volume_gain_db=float(cfg.get("volume_gain_db", 0.0)),
                source_transform=tts_core.default_source_transform(NOTETYPE_NAME),
                log=print,
            )
            print("例文 %d 件に音声を付けました(音声: %s)。" % (result.processed, voice))
        print()
        print("完了しました。次の同期では必ず「アップロード」を選んでください"
              "(カード3の削除=スキーマ変更のため)。")
        return 0
    finally:
        col.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="未出題の「AIに質問」に意味・本質問題を追加する")
    ap.add_argument("--collection", default=default_collection_path())
    ap.add_argument("--backup-dir", default=DEFAULT_BACKUP_DIR)
    ap.add_argument("--cache", default=DEFAULT_CACHE_PATH)
    ap.add_argument("--generate", action="store_true", help="Geminiで意味・本質問題を作りキャッシュへ保存する")
    ap.add_argument("--batch-size", type=int, default=5, help="1回のGemini呼び出しで扱う組の数(既定5)")
    ap.add_argument("--gemini-api-key", default="")
    ap.add_argument("--gemini-model", default="")
    ap.add_argument("--apply", action="store_true", help="コレクションへ追加する(既定は下見のみ)")
    ap.add_argument("--skip-tts", action="store_true", help="音声を付けない(試験用)")
    ap.add_argument("--skip-target", action="append", default=[],
                    help="入れない問題の target(複数回指定できる)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    if not os.path.exists(args.collection):
        print("コレクションが見つかりません: %s" % args.collection)
        return 1
    if args.generate:
        return run_generate(args)
    return run_apply(args)


if __name__ == "__main__":
    sys.exit(main())
