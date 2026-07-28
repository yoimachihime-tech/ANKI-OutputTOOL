#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gemini_client.py
-----------------
Gemini API(Generative Language API)への呼び出しをまとめたモジュール。
tts_core.pyのGoogle Cloud TTS呼び出しと同様、urllib.requestで直接REST APIを
叩く方式にしており、公式SDK(google-generativeai等)への依存は持たない。

【現状の位置づけ(2026-07-24時点)】
「AIに質問」タブ、および「習熟用(音読)」ストックへのDailyConversation由来
候補の自動生成、両方からこのモジュールを使う。AI連携はGemini APIを暫定
選択した「仮実装」であり、プロンプトの精度・モデル名は今後の調整が前提。

【APIキー】
config.jsonの"gemini_api_key"に平文で保存する(既存のGoogle Cloud TTSの
"api_key"と同じ方針)。呼び出し側(tts_gui.py)がconfigから読んで渡す。
このモジュール自体はconfig.jsonに依存しない(sheets_writer.py等と同じ設計方針)。

【API消費量の目安(2026-07-28、無料枠の上限に達しやすいため)】
1操作あたりのGemini呼び出し回数:
    - 単語タブ「AIに生成させる」      : 入力した単語1件につき1回(直列)
    - AIに質問タブ「AIに生成させる」  : 2回
      (Grammar Multi 3問で1回 + 習熟用の4問目で1回。この4問目は
       2026-07-28に片桐の要望で追加したもので、消費量が2倍になっている。
       無料枠が厳しい場合はここを任意ボタンに分離する余地がある)
    - DailyConversation「まとめてノート一覧に出力」
                                      : デッキに採用された行1件につき1回(直列)
    - DailyConversation「AIに添削させてシートに追加」
                                      : 1回(複数文をまとめて渡しても1回)
429時のリトライは_MAX_RETRIESで最大2回まで。ただし1日あたりの上限
(_is_daily_quota_error)と判定できた場合は、待っても回復しないため
リトライせず即座に打ち切る。
"""

import json
import os
import re
import time
import urllib.error
import urllib.request

GEMINI_ENDPOINT_TMPL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# 429(レート制限/無料枠の上限超過)時のリトライ回数。tts_core.call_google_tts
# の3回リトライと同じ考え方(2026-07-27追加)。無料枠は「1日あたり」の上限
# であることが多く、リトライしても解決しない場合があるため、無限リトライは
# せずここで打ち切ってGeminiClientErrorとしてユーザーに伝える。
# 2026-07-28、片桐から「上限に達している時にリトライで無駄にAPIを消費して
# しまう」との指摘を受け、3回→2回に減らした(_is_daily_quota_errorで
# 1日あたりの上限と判定できた場合は、この回数を待たずに即打ち切る)。
_MAX_RETRIES = 2
_DEFAULT_RETRY_DELAY_SECONDS = 5.0
_MAX_RETRY_DELAY_SECONDS = 60.0


class GeminiClientError(Exception):
    """Gemini API呼び出し・応答パースに失敗した場合の例外。"""


def _extract_retry_delay_seconds(error_detail_text: str):
    """429エラーのJSON本文から、Google側が示す`retryDelay`(例: "17s")を
    秒数で取り出す。見つからなければNone。"""
    try:
        parsed = json.loads(error_detail_text)
    except (json.JSONDecodeError, TypeError):
        return None
    for detail in parsed.get("error", {}).get("details", []):
        retry_delay = detail.get("retryDelay")
        if isinstance(retry_delay, str) and retry_delay.endswith("s"):
            try:
                return float(retry_delay[:-1])
            except ValueError:
                continue
    return None


def _is_daily_quota_error(error_detail_text: str) -> bool:
    """429エラーのJSON本文が「1日あたり」の上限(RPD: Requests Per Day)を
    示しているかを判定する(2026-07-28追加)。GeminiのQuotaFailure詳細には
    通常 quotaId に "PerDay" のような文字列が含まれる(例:
    "GenerateRequestsPerDayPerProjectPerModel-FreeTier")。1日あたりの
    上限は数分待っても回復しないため、この場合はリトライしても無駄にAPIを
    消費するだけ(片桐からの指摘)。一方、1分あたり等の短期的なレート制限は
    リトライで解決する見込みがあるため区別する。判定できない場合は
    Falseを返し、従来通りのリトライ動作にフォールバックする。"""
    normalized = re.sub(r"[\s_-]", "", (error_detail_text or "")).lower()
    return "perday" in normalized


def _post_gemini_request(url: str, body: dict, api_key: str, timeout: int) -> dict:
    """Gemini APIへのPOSTリクエストを行い、レスポンスのJSONをdictで返す共通処理。
    429(レート制限/無料枠上限)が返った場合は、Google側が示すretryDelay
    (無ければ既定値)だけ待って最大_MAX_RETRIES回リトライする。ただし
    1日あたりの上限超過と判定できる場合は、リトライしても短時間では
    回復しないため即座に打ち切る(_is_daily_quota_error)。"""
    data = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "X-Goog-Api-Key": api_key,
    }
    last_detail = None
    for attempt in range(_MAX_RETRIES):
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            last_detail = detail
            if e.code == 429:
                if _is_daily_quota_error(detail):
                    raise GeminiClientError(
                        "Gemini APIの1日あたりのリクエスト数上限に達しました。"
                        "時間を置いてもすぐには回復しないため、リトライは行わず"
                        "打ち切りました。翌日まで待つか、⚙設定でモデルを変更する、"
                        f"または有料プランへの切り替えをご検討ください。\n詳細: {detail}"
                    ) from e
                if attempt < _MAX_RETRIES - 1:
                    delay = _extract_retry_delay_seconds(detail) or _DEFAULT_RETRY_DELAY_SECONDS
                    time.sleep(min(delay, _MAX_RETRY_DELAY_SECONDS))
                    continue
                raise GeminiClientError(
                    "Gemini APIの利用上限(レート制限)に達しました。しばらく"
                    "時間をおくか、⚙設定でモデルを変更する、または有料プランへの"
                    f"切り替えをご検討ください。\n詳細: {detail}"
                ) from e
            raise GeminiClientError(f"Gemini API呼び出しに失敗しました: {detail}") from e
        except Exception as e:  # noqa: BLE001
            last_detail = str(e)
            raise GeminiClientError(f"Gemini API呼び出しに失敗しました: {e}") from e

    raise GeminiClientError(f"Gemini API呼び出しに失敗しました: {last_detail}")


def call_gemini(prompt: str, api_key: str, model: str, timeout: int = 60) -> str:
    """Gemini APIにプロンプトを送り、生成されたテキストをそのまま返す。"""
    if not api_key:
        raise GeminiClientError("Gemini APIキーが設定されていません。")

    url = GEMINI_ENDPOINT_TMPL.format(model=model)
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    result = _post_gemini_request(url, body, api_key, timeout)

    try:
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise GeminiClientError(f"Gemini APIの応答形式が想定と異なります: {result}") from e


def list_gemini_models(api_key: str, timeout: int = 30) -> list:
    """generateContentに対応しているGeminiモデルの名前一覧を取得する
    (例: "gemini-2.0-flash")。"""
    if not api_key:
        raise GeminiClientError("Gemini APIキーが設定されていません。")

    url = "https://generativelanguage.googleapis.com/v1beta/models"
    req = urllib.request.Request(url, headers={"X-Goog-Api-Key": api_key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise GeminiClientError(f"Geminiモデル一覧の取得に失敗しました: {detail}") from e
    except Exception as e:  # noqa: BLE001
        raise GeminiClientError(f"Geminiモデル一覧の取得に失敗しました: {e}") from e

    names = []
    for m in result.get("models", []):
        if "generateContent" not in m.get("supportedGenerationMethods", []):
            continue
        name = m.get("name", "")
        if name.startswith("models/"):
            name = name[len("models/"):]
        if name:
            names.append(name)
    return sorted(names)


def _extract_json(text: str) -> dict:
    """Gemini応答からJSONオブジェクトを抜き出す(```json ... ``` で囲まれる場合に対応)。"""
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidate = fence_match.group(1) if fence_match else text.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as e:
        raise GeminiClientError(f"Gemini応答をJSONとして解析できませんでした: {text[:300]}") from e


def _item_from_parsed(parsed: dict, source_key: tuple, source_label) -> dict:
    """Geminiが返したJSON(dict)を、build_shuujuku_v1.build_deck()向けのitem形式に整形する。"""
    return {
        "pattern": parsed.get("pattern", ""),
        "meaning": parsed.get("meaning") or None,
        "examples": [tuple(ex) for ex in parsed.get("examples", [])],
        "expl": parsed.get("expl") or None,
        "source_key": source_key,
        "source_label": source_label,
    }


_ROW_TO_ITEM_PROMPT = """あなたは英語学習カード作成のアシスタントです。
以下は、ある英作文の添削結果です。

原文: {original}
添削後: {corrected}
解説: {explanation}

この解説の背景にある「文法パターン」を抽象化し、音読練習用のカードを1つ作ってください。
以下のルールを厳守してください:

1. pattern: 可変部分をプレースホルダー語(動詞、代名詞、否定文、形容詞、名詞、主語、時制、数など)
   に置き換えた、穴埋め形式の英語パターン(例: "She doesn't 動詞")
2. examples: そのパターンを使った、上記の原文・添削後の文とは別の新しい例文を2〜3個
   (英文と日本語訳のペア)。上記の添削後の文をそのまま流用しないこと。
3. meaning: そのパターンの意味・使い方の日本語での簡潔な説明
4. expl: 上記の解説の内容を、必要なら整理して1〜2文で

以下のJSON形式で、JSON以外の文字を含めずに出力してください:
{{
  "pattern": "...",
  "meaning": "...",
  "examples": [["English sentence.", "日本語訳。"], ["English sentence 2.", "日本語訳2。"]],
  "expl": "..."
}}
"""


def generate_shuujuku_item_from_row(row: dict, api_key: str, model: str) -> dict:
    """DailyConversationのシート行(sheets_reader.fetch_pending_rowsの1件分)から、
    build_shuujuku_v1.build_deck()に渡せるitem dictを1つ生成する。

    row: id, original, corrected, explanation などのキーを持つdict
         (sheets_reader.fetch_pending_rowsの戻り値の要素と同じ形式)
    """
    prompt = _ROW_TO_ITEM_PROMPT.format(
        original=row.get("original", ""),
        corrected=row.get("corrected", ""),
        explanation=row.get("explanation", ""),
    )
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json(text)
    return _item_from_parsed(
        parsed,
        source_key=("dailyconv", row.get("id", "")),
        source_label="由来: DailyConversation",
    )


# ---------------------------------------------------------------------------
# Grammar Multi (文法・複数出題形式) — 「AIに質問」タブの出力先(2026-07-27追加)
# ---------------------------------------------------------------------------
#
# 以前は「AIに質問」タブの回答も習熟用(ATSU方式・音読練習用)ストックへ
# 追加していたが、「習熟用タブに飛ぶ内容と同じでダブっている」との指摘を
# 受けた。習熟用は「音読による習熟」が目的、Grammar Multiは「知識を深める」
# ための出題形式であり、目的が異なるため出力先を分離した。
#
# 正典は`build_grammar_multi_v1_updated.py`(claude.aiプロジェクト側からの
# 2026-07-27時点のコピー、MODEL_ID 1907250010123)。CSS・テンプレートHTML・
# choice()/whynot_item()/example_en()/example_ja()ヘルパー関数は記憶から
# 再構築せずこのファイルの定義をそのままインポートして使う。

try:
    import build_grammar_multi_v1_updated as _grammar_multi_canon
    GRAMMAR_MULTI_CANON_AVAILABLE = True
except ImportError:
    GRAMMAR_MULTI_CANON_AVAILABLE = False


_GRAMMAR_MULTI_PROMPT = """あなたは英文法学習カードの作成アシスタントです。
以下の質問について、学習者の理解を深めるための練習問題を3問、
独立したノートとして作成してください(1つの質問に対して複数の練習問題を
作る場合も、1ノートに複数の出題形式を詰め込むのではなく、必ず独立した
ノートを複数作成すること)。

質問: {question}

【出題ルールを厳守】
1. 3問は出題形式を分散させ、同じ形式を繰り返さないこと。原則として以下の3形式:
   (1) 選択問題: choicesにA/B/Cの3択を入れる。1つが正解、2つは誤答とし、
       whynotに各誤答がなぜ誤りかを日本語で書く。
   (2) 誤り訂正問題: choicesは空配列。questionに誤りを含む英文を提示し、
       訂正させる問題文にする。
   (3) 記述式・書き換え問題: choicesは空配列。2文や状況を与えて1文に
       まとめさせる、または指定ニュアンスを含む文を組み立てさせる問題。
   上記に限らず、その都度ふさわしい別形式があれば入れ替えてよい
   (例: 空所補充の記述式など)。ただし3問とも同じ形式にはしないこと。
2. 完全な日本語→英語の全文翻訳問題(パラフレーズのリスクがあるため)は禁止。
   多肢選択の穴埋め・誤り訂正形式を優先すること。
3. patternフィールドには出題形式のラベルのみを入れる
   (例: "選択問題", "誤り訂正問題", "記述式・書き換え問題")。
   文法項目名や正解のヒントになる語は絶対に入れないこと。
4. questionフィールドの本文も、選択肢が示される前に正解を示唆・特定できる
   書き方をしないこと。
5. answerは正解の英文(または訂正後の英文・組み立てた英文)を1つ。
6. examplesは、そのポイントを使った例文を1〜2個(英文と日本語訳のペア)。
   不要なら空配列でよい。
7. whyには、正解の理由・文法解説を日本語で。
8. whynotは選択問題の場合のみ、各誤答について
   {{"opt": "A", "reason": "..."}} 形式のオブジェクトの配列。
   選択問題以外では空配列にすること。
9. choicesは選択問題の場合のみ {{"opt": "A", "text": "..."}} 形式の
   オブジェクトの配列(3択)。選択問題以外では空配列にすること。
10. correct_optは選択問題の場合のみ、正解の選択肢のopt(例: "B")を
    入れること。選択問題以外では空文字""にすること。

以下のJSON形式で、JSON以外の文字を含めずに出力してください(必ず3要素の配列):
[
  {{
    "pattern": "選択問題",
    "question": "...",
    "choices": [{{"opt": "A", "text": "..."}}, {{"opt": "B", "text": "..."}}, {{"opt": "C", "text": "..."}}],
    "answer": "...",
    "correct_opt": "B",
    "examples": [["English sentence.", "日本語訳。"]],
    "why": "...",
    "whynot": [{{"opt": "B", "reason": "..."}}, {{"opt": "C", "reason": "..."}}]
  }},
  {{
    "pattern": "誤り訂正問題",
    "question": "...(誤りを含む英文を提示)",
    "choices": [],
    "answer": "...",
    "correct_opt": "",
    "examples": [],
    "why": "...",
    "whynot": []
  }},
  {{
    "pattern": "記述式・書き換え問題",
    "question": "...",
    "choices": [],
    "answer": "...",
    "correct_opt": "",
    "examples": [],
    "why": "...",
    "whynot": []
  }}
]
"""


def _extract_json_array(text: str) -> list:
    """Gemini応答からJSON配列を抜き出す(```json ... ``` で囲まれる場合に対応)。"""
    fence_match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    candidate = fence_match.group(1) if fence_match else text.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as e:
        raise GeminiClientError(f"Gemini応答をJSON配列として解析できませんでした: {text[:300]}") from e


# 日本語の指示文(「〜しなさい。」等)の直後に、改行なしで引用符付き英文が
# 続く箇所を検出する(2026-07-28追加)。Grammar MultiのQuestionフィールドは
# Geminiが「指示文+英文」を1つの文字列として返すため、そのままでは
# 「選びなさい。'She showed...'」のように改行なしで並んでしまい読みにくい
# (Ankiフィールドはmustacheで生HTML展開されるため、改行させるには明示的な
# <br>が必要)。
_JA_EN_BOUNDARY_RE = re.compile(r"([。！？])\s*(?=[\"'“”‘’A-Za-z])")
# 英文側が複数文にわたる場合、文末(.!?)+空白+次の文の頭(引用符/大文字)の
# 境目でも改行する。
_EN_SENTENCE_BREAK_RE = re.compile(r"(?<=[.!?])\s+(?=[\"'A-Z])")


def _format_question_html(text: str) -> str:
    """日本語の指示文と、それに続く英文の間、および英文が複数文ある場合は
    文と文の間に<br>を挿入する。"""
    if not text:
        return text
    text = _JA_EN_BOUNDARY_RE.sub(r"\1<br><br>", text)
    # 既存の<br>を境に分割し、<br>以外の断片だけに文区切りの<br>を適用する
    # (挿入済みの<br><br>自体を誤って再分割しないため)。
    parts = re.split(r"(<br\s*/?>)", text)
    return "".join(
        p if re.match(r"<br\s*/?>", p) else _EN_SENTENCE_BREAK_RE.sub("<br>", p)
        for p in parts
    )


def _prefix_answer_with_correct_opt(answer: str, choices: list, correct_opt: str) -> str:
    """選択問題(choicesが空でない)の場合、Answerフィールドの先頭に正解の
    選択肢ラベル(例: "(B) ")を付ける(2026-07-28追加。選択肢のうちどれが
    正解かカード裏面を見ただけでは分からないという指摘への対応)。
    誤り訂正・記述式問題(choicesが空)の場合はanswerをそのまま返す。

    correct_opt(Geminiが返す正解のopt)がchoicesの実際のoptと一致しない・
    空文字などの場合は、answerとchoicesの各textを突き合わせて(前後空白・
    大小文字を無視)一致するものを探すフォールバックを行う。それでも
    特定できなければ記号無しのまま返す(誤った記号を付けるより安全)。"""
    if not choices or not answer:
        return answer
    valid_opts = {c.get("opt", "").strip().upper() for c in choices if c.get("opt")}
    opt = (correct_opt or "").strip().upper()
    if opt not in valid_opts:
        normalized_answer = answer.strip().casefold()
        opt = ""
        for c in choices:
            if (c.get("text") or "").strip().casefold() == normalized_answer:
                opt = c.get("opt", "").strip().upper()
                break
    if not opt:
        return answer
    return f"({opt}) {answer}"


def generate_grammar_multi_items_from_question(question: str, api_key: str, model: str) -> list:
    """「AIに質問」タブの質問文から、Grammar Multi(文法・複数出題形式)の
    独立ノート3件分のitem dictを生成する(grammar_multi_builder.build_deck()
    にそのまま渡せる形式)。

    戻り値の各dictは、build_grammar_multi_v1_updated.GRAMMAR_MODELの
    フィールド(pattern, question, choices, answer, example, example_ja,
    why, whynot)に対応する値(choices/whynot/exampleはcanon側のヘルパー
    関数でHTML化済み)に加え、guid計算・重複検出用のtopic_key/note_index/
    source_keyを持つ。
    """
    if not GRAMMAR_MULTI_CANON_AVAILABLE:
        raise GeminiClientError(
            "build_grammar_multi_v1_updated.py が見つからないか、"
            "genankiがインストールされていません。"
        )
    prompt = _GRAMMAR_MULTI_PROMPT.format(question=question)
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json_array(text)
    if not parsed:
        raise GeminiClientError(f"Gemini応答が空、または配列ではありません: {text[:300]}")

    topic_key = " ".join(question.strip().casefold().split())
    items = []
    for i, note in enumerate(parsed):
        choices = note.get("choices") or []
        whynot = note.get("whynot") or []
        examples = [tuple(ex) for ex in note.get("examples", [])]
        items.append({
            "pattern": note.get("pattern", ""),
            "question": _format_question_html(note.get("question", "")),
            "choices": "".join(
                _grammar_multi_canon.choice(c.get("opt", ""), c.get("text", "")) for c in choices
            ),
            "answer": _prefix_answer_with_correct_opt(
                note.get("answer", ""), choices, note.get("correct_opt", "")
            ),
            "example": _grammar_multi_canon.example_en(examples) if examples else "",
            "example_ja": _grammar_multi_canon.example_ja(examples) if examples else "",
            "why": note.get("why", ""),
            "whynot": "".join(
                _grammar_multi_canon.whynot_item(w.get("opt", ""), w.get("reason", "")) for w in whynot
            ),
            "topic_key": topic_key,
            "note_index": i,
            "source_key": ("chat_grammar", f"{topic_key}::{i}"),
            "source_label": "由来: AIに質問",
        })
    return items


# ---------------------------------------------------------------------------
# 「AIに質問」タブ → 習熟用(音読)ストックへの4問目(2026-07-28再追加)
# ---------------------------------------------------------------------------
#
# 以前あったanswer_question_as_shuujuku_item()は、Grammar Multiとの内容
# 重複("習熟用タブに飛ぶ内容と同じでダブっている")を理由に2026-07-27に
# 削除したが、片桐から「AIに質問で出力される3問以外に、4問目として習熟用の
# カードを作って習熟用タブのストックに送ってほしい」との要望を受け、
# generate_grammar_multi_items_from_question()とは別枠の"4問目"として再度
# 追加した。生成される3件(選択問題/誤り訂正問題/記述式)とは出題形式が
# 根本的に異なる(パターン穴埋め+音読用例文)ため、Grammar Multi用の
# プロンプトを流用せず、generate_shuujuku_item_from_row()と同じ構造の
# 専用プロンプト・専用のGemini呼び出しで生成する(1回の質問につき
# Gemini呼び出しが1回増える)。

_QUESTION_TO_SHUUJUKU_ITEM_PROMPT = """あなたは英語学習カード作成のアシスタントです。
以下は、学習者からの英文法に関する質問です。

質問: {question}

この質問の背景にある「文法パターン」を抽象化し、音読練習用のカードを1つ作ってください。
以下のルールを厳守してください:

1. pattern: 可変部分をプレースホルダー語(動詞、代名詞、否定文、形容詞、名詞、主語、時制、数など)
   に置き換えた、穴埋め形式の英語パターン(例: "She doesn't 動詞")
2. examples: そのパターンを使った例文を2〜3個(英文と日本語訳のペア)
3. meaning: そのパターンの意味・使い方の日本語での簡潔な説明
4. expl: 質問への回答・解説を1〜2文で

以下のJSON形式で、JSON以外の文字を含めずに出力してください:
{{
  "pattern": "...",
  "meaning": "...",
  "examples": [["English sentence.", "日本語訳。"], ["English sentence 2.", "日本語訳2。"]],
  "expl": "..."
}}
"""


def generate_shuujuku_item_from_question(question: str, api_key: str, model: str) -> dict:
    """「AIに質問」タブの質問文から、build_shuujuku_v1.build_deck()に渡せる
    item dictを1つ生成する(「3問+習熟用4問目」のうちの4問目)。"""
    prompt = _QUESTION_TO_SHUUJUKU_ITEM_PROMPT.format(question=question)
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json(text)
    topic_key = " ".join(question.strip().casefold().split())
    return _item_from_parsed(
        parsed,
        source_key=("chat", topic_key),
        source_label="由来: AIに質問",
    )


# 単語カード生成プロンプトは、Web版と共有するため外部ファイルに切り出してある
# (2026-07-28、片桐の合意により実施)。プロンプトを改善したときに、
# デスクトップ版とWeb版のどちらか片方だけ直して不一致になる事故を防ぐのが目的。
#
# 置き場所を`docs/shared/`にしているのは、GitHub Pagesが`docs/`配下しか
# 配信しないため。リポジトリ直下の`prompts/`に置くとWeb版から`fetch()`できない。
#   - Python側: 下の_load_shared_prompt()が`open()`で読む
#   - Web側   : `fetch('./shared/word_card_prompt.txt')`で読む
#
# プレースホルダは`str.format()`ではなく`{{word}}`形式の単純置換にしてある。
# format()だとプロンプト内のJSON例の波括弧を`{{`にエスケープする必要があり、
# JS側と文面が一致しなくなるため(共有ファイルの意味が薄れる)。
SHARED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "shared")
WORD_PROMPT_PATH = os.path.join(SHARED_DIR, "word_card_prompt.txt")


def _load_shared_prompt(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError as e:
        raise GeminiClientError(
            f"共有プロンプトファイルを読み込めませんでした: {path}\n{e}"
        ) from e


def _fill_placeholders(template: str, **values) -> str:
    """`{{name}}`形式のプレースホルダを置換する(Web版のJSと同じ方式)。"""
    for name, value in values.items():
        template = template.replace("{{" + name + "}}", str(value))
    return template


def generate_vocab_card_from_word(word: str, context_sentence: str, api_key: str, model: str) -> dict:
    """「単語」タブの入力(未学習の単語+文脈文)から、build_word_v1.build_deck()向けの
    item dict(word/reading/pos/meaning/example/example_ja/example_blank/note)を1つ生成する。

    wordフィールドはAIに生成させず、入力された単語をそのまま使う(AIによる表記ゆれを防ぐため)。
    **注意: 「習熟用(音読)」ストックとは無関係。この関数の戻り値はword_stock.pyでのみ
    扱い、shuujuku_stock.pyには一切渡さないこと(2026-07-27、片桐の明示的な指示)。**
    """
    prompt = _fill_placeholders(
        _load_shared_prompt(WORD_PROMPT_PATH),
        word=word,
        context_sentence=context_sentence,
    )
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json(text)
    return {
        "word": word.strip(),
        "reading": parsed.get("reading", ""),
        "pos": parsed.get("pos", ""),
        "meaning": parsed.get("meaning", ""),
        "example": parsed.get("example", ""),
        "example_ja": parsed.get("example_ja", ""),
        "example_blank": parsed.get("example_blank", ""),
        "note": parsed.get("note", ""),
        "context_sentence": context_sentence.strip(),
    }


# ---------------------------------------------------------------------------
# 英文添削(DailyConversationタブへの直接入力、2026-07-27追加)
# ---------------------------------------------------------------------------
#
# これまでDailyConversationの元データは、Googleフォーム→Apps Script
# (Gemini呼び出し)→「添削結果」シート、という別プロジェクトの工程でしか
# 作れなかった。片桐から実際のApps Scriptのコード(system_instruction・
# responseSchema)の提供を受けたため、その内容をそのままこちらへ移植し、
# アプリ内で直接英文添削→シート追記までできるようにした。
# **system_instructionとresponseSchemaはApps Script側の実装と意味的に
# 同一になるよう保つこと**(採点基準がズレると「添削結果」シート上でGoogle
# フォーム経由の行とこのアプリ経由の行の基準が食い違ってしまうため)。

CORRECTION_SYSTEM_INSTRUCTION = (
    "あなたは英文添削者です。与えられた英文を文単位で確認し、誤りがあれば添削してください。"
    "誤りがない時はcorrectedをoriginalと同一にしてください。解説は日本語で簡潔に書いてください。"
    "さらに、correctedの文で使われている表現について、同じ意味・場面で使われる類似表現をより"
    "自然な言い方で2〜3個挙げてください。各代替表現についてexpressionには英文の完成文1文のみ、"
    "noteにはその表現の使い方やニュアンスの違いを日本語で書いてください。expressionフィールドに"
    "日本語を含めないでください。特に無ければ配列を空にしてください。"
    "加えて、入力された原文(original)そのものを以下3つの観点でそれぞれ0〜100点で評価してください。"
    "1) grammar_score: 文法的な正確さ(誤りが多いほど低くなる) "
    "2) naturalness_score: 母語話者から見た表現の自然さ(文法的に正しくても不自然な言い回しなら低くなる) "
    "3) comprehensibility_score: 英語圏の人にどれだけ意味が伝わるか(全く伝わらない場合は0点付近、"
    "多少不自然でも意味が通じるなら高くする) "
    "score_commentには、なぜその点数になったか、原文中の具体的にどの言い回しが問題だったか、を"
    "日本語で簡潔に説明してください。"
)

CORRECTION_RESPONSE_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "original": {"type": "STRING"},
            "corrected": {"type": "STRING"},
            "explanation": {"type": "STRING"},
            "category": {"type": "STRING", "description": "文法 / 語彙 / 自然さ / 誤りなし のいずれか"},
            "similar_expressions": {
                "type": "ARRAY",
                "description": "類似表現のリスト。無ければ空配列",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "expression": {"type": "STRING", "description": "英文の完成文1文のみ、日本語を含めない"},
                        "note": {"type": "STRING", "description": "日本語のみ、使い方・ニュアンスの説明"},
                    },
                    "required": ["expression", "note"],
                },
            },
            "grammar_score": {"type": "NUMBER", "description": "文法的正確さ 0〜100"},
            "naturalness_score": {"type": "NUMBER", "description": "自然さ 0〜100"},
            "comprehensibility_score": {"type": "NUMBER", "description": "伝わりやすさ 0〜100"},
            "score_comment": {"type": "STRING", "description": "スコアの根拠。具体的な問題表現を含めて日本語で"},
        },
        "required": [
            "original", "corrected", "explanation", "category", "similar_expressions",
            "grammar_score", "naturalness_score", "comprehensibility_score", "score_comment",
        ],
    },
}


def correct_english_text(text: str, api_key: str, model: str, timeout: int = 60) -> list:
    """英文(複数文・段落もまとめて可)をGeminiに添削・採点させる。

    Googleフォーム経由のApps Script(callGeminiForCorrection)と同じ
    system_instruction・responseSchema(構造化出力/JSON Mode)を使うため、
    複数文をまとめて渡した場合はGemini側が文ごとに配列を自動分割して返す
    (Apps Script側の1フォーム送信=1englishTextと同じ挙動)。

    戻り値: dictのリスト。各dictのキーは sheets_reader.fetch_pending_rows()
    が返す行の元になった、Apps Script「添削結果」シートの列と対応する
    (original, corrected, explanation, category,
    similar_expressions: list[{"expression": str, "note": str}],
    grammar_score, naturalness_score, comprehensibility_score, score_comment)。
    シートへの書き込みは行わない(sheets_writer.append_correction_rowsの責務)。
    """
    if not api_key:
        raise GeminiClientError("Gemini APIキーが設定されていません。")
    if not text.strip():
        raise GeminiClientError("添削する英文が空です。")

    url = GEMINI_ENDPOINT_TMPL.format(model=model)
    body = {
        "system_instruction": {"parts": [{"text": CORRECTION_SYSTEM_INSTRUCTION}]},
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": CORRECTION_RESPONSE_SCHEMA,
        },
    }
    result = _post_gemini_request(url, body, api_key, timeout)

    try:
        text_result = result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as e:
        raise GeminiClientError(f"Gemini APIの応答形式が想定と異なります: {result}") from e

    try:
        corrections = json.loads(text_result)
    except json.JSONDecodeError as e:
        raise GeminiClientError(f"Gemini応答をJSONとして解析できませんでした: {text_result[:300]}") from e

    if not isinstance(corrections, list):
        raise GeminiClientError(f"Gemini応答が配列ではありません: {corrections}")

    return corrections


def consolidate_no_error_corrections(corrections: list) -> list:
    """correct_english_text()が返したcorrectionsのうち、category=="誤りなし"の
    ものが複数あっても、シートには1行だけ書き込むよう1件に要約する
    (2026-07-28追加。片桐から「誤りなしの文をわざわざ複数行に分ける必要は
    ない、誤りなしと分かった時点で1つだけシートに入るようにしたい」との
    要望)。誤りがある行(category!="誤りなし")は1文=1行のまま素通しする
    (それぞれ個別にカード化する必要があるため)。

    誤りなしが0件・1件の場合はそのまま返す(要約する意味が無いため)。
    複数ある場合、元のoriginalを改行で連結した1件に要約し、誤りなしの
    最初の出現位置に差し込む(誤りのある文と誤りなしの文が混在していた
    場合も、シート上の並び順が大きく崩れないようにするため)。要約行は
    scoreを持たない(複数文の点数を平均する等の意味付けが無いため空欄)。"""
    no_error = [c for c in corrections if c.get("category") == "誤りなし"]
    if len(no_error) <= 1:
        return corrections

    originals = [c.get("original", "") for c in no_error]
    merged = {
        "original": "\n".join(originals),
        "corrected": "\n".join(originals),
        "explanation": f"{len(no_error)}文とも誤りなしでした。",
        "category": "誤りなし",
        "similar_expressions": [],
        "grammar_score": "",
        "naturalness_score": "",
        "comprehensibility_score": "",
        "score_comment": "",
    }

    result = []
    inserted = False
    for c in corrections:
        if c.get("category") == "誤りなし":
            if not inserted:
                result.append(merged)
                inserted = True
        else:
            result.append(c)
    return result
