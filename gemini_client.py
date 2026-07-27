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
"""

import json
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
_MAX_RETRIES = 3
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


def _post_gemini_request(url: str, body: dict, api_key: str, timeout: int) -> dict:
    """Gemini APIへのPOSTリクエストを行い、レスポンスのJSONをdictで返す共通処理。
    429(レート制限/無料枠上限)が返った場合は、Google側が示すretryDelay
    (無ければ既定値)だけ待って最大_MAX_RETRIES回リトライする。"""
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
                if attempt < _MAX_RETRIES - 1:
                    delay = _extract_retry_delay_seconds(detail) or _DEFAULT_RETRY_DELAY_SECONDS
                    time.sleep(min(delay, _MAX_RETRY_DELAY_SECONDS))
                    continue
                raise GeminiClientError(
                    "Gemini APIの利用上限(レート制限または無料枠の1日あたりの"
                    "リクエスト数上限)に達しました。しばらく時間をおくか、"
                    "⚙設定でモデルを変更する、または有料プランへの切り替えを"
                    f"ご検討ください。\n詳細: {detail}"
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

以下のJSON形式で、JSON以外の文字を含めずに出力してください(必ず3要素の配列):
[
  {{
    "pattern": "選択問題",
    "question": "...",
    "choices": [{{"opt": "A", "text": "..."}}, {{"opt": "B", "text": "..."}}, {{"opt": "C", "text": "..."}}],
    "answer": "...",
    "examples": [["English sentence.", "日本語訳。"]],
    "why": "...",
    "whynot": [{{"opt": "B", "reason": "..."}}, {{"opt": "C", "reason": "..."}}]
  }},
  {{
    "pattern": "誤り訂正問題",
    "question": "...(誤りを含む英文を提示)",
    "choices": [],
    "answer": "...",
    "examples": [],
    "why": "...",
    "whynot": []
  }},
  {{
    "pattern": "記述式・書き換え問題",
    "question": "...",
    "choices": [],
    "answer": "...",
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
            "question": note.get("question", ""),
            "choices": "".join(
                _grammar_multi_canon.choice(c.get("opt", ""), c.get("text", "")) for c in choices
            ),
            "answer": note.get("answer", ""),
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


_WORD_TO_ITEM_PROMPT = """あなたは、言語学習、特に読書を通じて遭遇した「未知の英単語の記憶定着」と
「本質的理解」を最大化するAnkiカード作成のエキスパートです。

ユーザーから「読書中に出会った英単語」と、その文脈が提示されます。
**文脈は完全な英文とは限りません**(句動詞や、単語同士の組み合わせ・
コロケーションの一部だけが渡されることもあります)。文脈が完全な文でない
場合は、無理に1つの文として解釈しようとせず、その断片が使われる典型的な
状況を踏まえてカードを作成してください。また、文脈が空欄の場合は、対象単語の
最も一般的な用法を基準にカードを作成してください。
単純な1対1の和訳暗記を避け、直感的なコアイメージや語源を軸とした情報を
生成してください。

## 禁止事項・スタイル(最優先)
- アスタリスク禁止: 出力テキスト内でアスタリスク`*`は一切使用しないでください。
- 強調表現: 対象単語やアクセント、重要な語根など強調したい箇所は、必ずHTMLタグ
  <b>と</b>で囲んでください。ダブルクォーテーション"は強調目的では使用せず、
  本来の「引用」等の目的のみに使用してください(TTSでの不要なポーズを防ぐため)。
- 角括弧禁止: 半角の角括弧[ ]は英語TTSソフトで読み上げエラーの原因となるため、
  絶対に使用しないでください。日本語の見出しには【 】や＜ ＞を使用してよい。
- 言語分離: reading/pos/exampleフィールドなど英語のみを出力すべき箇所に、
  日本語や全角記号を一切含めないでください。
- 改行: 文章の区切りには物理的な改行ではなく<br>を使用してください。

## 対象単語
単語: {word}
文脈(完全な文とは限らない。句動詞・単語の組み合わせのみのこともある。
空欄の場合は最も一般的な用法を基準にすること): {context_sentence}

## 出力するフィールド
以下のキーちょうど7つだけを持つJSONオブジェクトを、JSON以外の文字を
含めずに出力してください:

{{
  "reading": "発音記号(IPA)。アクセントのある音節を<b></b>で囲む。例: /<b>ˈsleɪ</b>tɪd/",
  "pos": "品詞(英語で簡潔に)。例: adj. (Past Participle)",
  "meaning": "日本語での簡潔な意味。例: 予定されている",
  "example": "文脈の英文を元にした例文(対象単語を<b></b>で囲む)を1文作り、続けて<br>で区切って
    Ex1. ...<br>Ex2. ... という形式で、上記の課題文とは別の新しい例文を2つ追加する
    (それぞれの例文でも対象単語は<b></b>で囲む)",
  "example_ja": "exampleの各文に対応する日本語訳を<br>区切りで(Ex1/Ex2などの接頭辞は付けない)",
  "example_blank": "exampleの最初の例文について、対象単語をハイフン7つ(-------)で置き換えた
    穴埋め文",
  "note": "日本語での補足説明。まず文体・ニュアンスの解説を書き、<br><br>で段落を分けて
    【派生語・共起表現・対義語】<br>派生語: ...<br>共起表現: ...<br>対義語: ...
    <br><br>【語源・コアイメージ】<br>(語源やコアイメージの解説)という構成にする"
}}
"""


def generate_vocab_card_from_word(word: str, context_sentence: str, api_key: str, model: str) -> dict:
    """「単語」タブの入力(未学習の単語+文脈文)から、build_word_v1.build_deck()向けの
    item dict(word/reading/pos/meaning/example/example_ja/example_blank/note)を1つ生成する。

    wordフィールドはAIに生成させず、入力された単語をそのまま使う(AIによる表記ゆれを防ぐため)。
    **注意: 「習熟用(音読)」ストックとは無関係。この関数の戻り値はword_stock.pyでのみ
    扱い、shuujuku_stock.pyには一切渡さないこと(2026-07-27、片桐の明示的な指示)。**
    """
    prompt = _WORD_TO_ITEM_PROMPT.format(word=word, context_sentence=context_sentence)
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
