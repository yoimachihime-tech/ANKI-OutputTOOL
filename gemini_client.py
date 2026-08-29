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
import uuid
import urllib.error
import urllib.request

GEMINI_ENDPOINT_TMPL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# プロンプトはWeb版(docs/)と共有するため外部ファイルに切り出してある
# (2026-07-28、片桐の合意により実施)。プロンプトを改善したときに、
# デスクトップ版とWeb版のどちらか片方だけ直して不一致になる事故を防ぐのが目的。
#
# 置き場所を`docs/shared/`にしているのは、GitHub Pagesが`docs/`配下しか
# 配信しないため。リポジトリ直下の`prompts/`に置くとWeb版から`fetch()`できない。
#   - Python側: _load_shared_prompt()が`open()`で読む
#   - Web側   : `fetch('./shared/xxx.txt')`で読む
#
# プレースホルダは`str.format()`ではなく`{{name}}`形式の単純置換にしてある。
# format()だとプロンプト内のJSON例の波括弧を`{{`にエスケープする必要があり、
# JS側と文面が一致しなくなるため(共有ファイルの意味が薄れる)。
SHARED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "shared")


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


def _is_billing_error(error_detail_text: str) -> bool:
    """429のうち「課金・前払いクレジット切れ」によるものかを判定する
    (2026-07-28追加)。

    Gemini APIは前払いクレジットが尽きた場合も429 RESOURCE_EXHAUSTEDを返すが、
    短期のレート制限と違い待っても回復しない。以前はこれを「レート制限に
    達しました」と表示したうえリトライしており、原因が伝わらず無駄な呼び出しも
    発生していた(2026-07-28に片桐の環境で実際に発生:
    "Your prepayment credits are depleted.")。

    **単なる "billing" という語だけで判定してはいけない**(2026-08-06修正)。
    Googleが無料枠の上限超過で返す標準の文面にも
    "please check your plan and billing details" が含まれるため、以前の
    実装(`"billing" in normalized`)だと**ただの無料枠20回/日の超過まで
    「前払いクレジットが尽きている」と表示**していた。片桐が実際にこの
    誤ったメッセージ(「新しいプロジェクトでキーを作り直してください」)を
    受け取っており、そのとおりに操作しても解決しない案内になっていた。
    前払いクレジット切れの実際の文面は
    "Your prepayment credits are depleted." なので、prepayment または
    credit+deplet だけで十分に判定できる。"""
    normalized = re.sub(r"[\s_-]", "", (error_detail_text or "")).lower()
    return (
        "prepayment" in normalized
        or ("credit" in normalized and "deplet" in normalized)
    )


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
                if _is_billing_error(detail):
                    raise GeminiClientError(
                        "このAPIキーのプロジェクトは前払いクレジットが尽きているため"
                        "利用できません(レート制限ではないので、待っても回復しません)。"
                        "\n\n"
                        "対処: 課金は必須ではありません。"
                        "https://aistudio.google.com/apikey で「APIキーを作成」する際に、"
                        "既存のプロジェクトではなく「新しいプロジェクト」を選んで"
                        "キーを作り直し、⚙設定のキーを差し替えてください"
                        "(2026-07-28にこの方法で解決済み)。\n"
                        "有料のまま使い続ける場合は https://ai.studio/projects で"
                        f"クレジットを追加してください。\n\n詳細: {detail}"
                    ) from e
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
            if e.code >= 500:
                # Google側の一時的な過負荷(503 UNAVAILABLE「currently
                # experiencing high demand」等、2026-07-28に片桐の環境で発生)。
                # 429と違い長期の割り当て超過ではなく、数秒〜数十秒待てば
                # 解消することが多いため、429と同じ回数だけ短い間隔でリトライする。
                if attempt < _MAX_RETRIES - 1:
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise GeminiClientError(
                    "Gemini APIが一時的に混雑しています(モデルの需要が高い状態)。"
                    f"しばらく時間をおいてから再試行してください。\n詳細: {detail}"
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


# プロンプトはWeb版と共有するため外部ファイルに切り出してある(2026-07-29、
# 他の共有プロンプトと同じ理由。以前はこのモジュール内のみのインライン
# 文字列だったが、Web版にDailyConversation→習熟用の連携を追加するにあたり
# 共有化した)。docs/shared/shuujuku_dailyconv_prompt.txt
ROW_TO_ITEM_PROMPT_PATH = os.path.join(SHARED_DIR, "shuujuku_dailyconv_prompt.txt")


# ---------------------------------------------------------------------------
# まとめて生成(バッチ、2026-08-06追加)
# ---------------------------------------------------------------------------
#
# 以前は「単語N件 → N回」「添削結果N行 → N回」と1件ずつ直列に呼んでいた。
# 無料枠の1日あたりの上限は**リクエスト数**で数えられるため(2026-08-06に
# gemini-3.5-flashで20回/日にぶつかった)、1件ずつ呼ぶ方式は上限に極端に
# 当たりやすい。上限値そのものはGoogleの都合でよく変わるので、「上限が
# いくつであれ消費を1/Nにする」こちらのほうが対策として本質的
# (片桐の指摘: 上限を追いかけるカウンタだけでは無意味になりやすい)。
#
# **プロンプトはWeb版と共有しているため、片方だけをバッチ化することは
# できない**(docs/shared/word_card_prompt.txt・shuujuku_dailyconv_prompt.txt
# は入力が複数件・出力がJSON配列という前提に書き換わっている)。Web版と
# 揃えるためにこちらも同じ形に変更してある。

#: 1回のリクエストに詰め込む件数の上限。全件を1回に詰めないのは、件数が
#: 増えると応答が出力トークン上限で途中で切れ、そのバッチが丸ごと失敗する
#: ため。Web版の gemini.js の BATCH_SIZE と同じ値に保つこと。
BATCH_SIZE = 10


def _chunk_for_batch(items: list, size: int = BATCH_SIZE) -> list:
    """itemsをsizeごとのリストに分割する。"""
    return [items[i:i + size] for i in range(0, len(items), size)]


def _align_batch_results(parsed, count: int) -> list:
    """バッチ応答(オブジェクトの配列)を、入力の並び順に対応付け直す。

    各要素の`index`(1始まり、プロンプトで必ず含めるよう指示している)を頼りに
    する。**配列の位置をそのまま信じない**のは、モデルが1件飛ばす・順序を
    入れ替えることがあり、そうなると別の単語の解説が付いたカードが静かに
    出来上がってしまうため(内容が入れ替わっても字面だけでは気づきにくい)。
    `index`が使えない要素だけ、埋まっていない位置へ順に詰める。

    戻り値は長さcountのリストで、生成されなかった位置はNone。
    Web版の gemini.js の alignBatchResults() と同じ挙動にすること。
    """
    out = [None] * count
    leftovers = []

    for entry in parsed if isinstance(parsed, list) else []:
        if not isinstance(entry, dict):
            continue
        idx = entry.get("index")
        if isinstance(idx, bool):  # boolはintのサブクラスなので明示的に弾く
            idx = None
        if isinstance(idx, (int, float)) and float(idx).is_integer():
            idx = int(idx)
        else:
            idx = None
        if idx is not None and 1 <= idx <= count and out[idx - 1] is None:
            out[idx - 1] = entry
        else:
            leftovers.append(entry)

    for entry in leftovers:
        if None not in out:
            break
        out[out.index(None)] = entry
    return out


def generate_shuujuku_items_from_rows(rows: list, api_key: str, model: str) -> list:
    """DailyConversationのシート行(sheets_reader.fetch_pending_rowsの要素)から、
    build_shuujuku_v1.build_deck()に渡せるitem dictをまとめて生成する。

    rows: id, original, corrected, explanation などのキーを持つdictのリスト
    戻り値: rowsと同じ長さのリスト。生成できなかった件はNone(呼び出し側が
            どの行が失敗したかを利用者に伝えられるよう、詰めずに位置を保つ)。
    バッチ全体が失敗した場合はGeminiClientErrorを送出する。
    """
    results = [None] * len(rows)
    done = 0

    for chunk in _chunk_for_batch(rows):
        lines = "\n\n".join(
            f"[{i + 1}]\n原文: {row.get('original', '')}\n"
            f"添削後: {row.get('corrected', '')}\n解説: {row.get('explanation', '')}"
            for i, row in enumerate(chunk)
        )
        prompt = _fill_placeholders(
            _load_shared_prompt(ROW_TO_ITEM_PROMPT_PATH),
            count=str(len(chunk)),
            items=lines,
        )
        parsed = _extract_json_array(call_gemini(prompt, api_key, model))

        for i, entry in enumerate(_align_batch_results(parsed, len(chunk))):
            if entry is None:
                continue
            results[done + i] = _item_from_parsed(
                entry,
                source_key=("dailyconv", chunk[i].get("id", "")),
                source_label="由来: DailyConversation",
            )
        done += len(chunk)

    return results


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


# プロンプトはWeb版と共有するため外部ファイルに切り出してある
# (2026-07-28、単語カードと同じ方式。docs/shared/grammar_multi_prompt.txt)。
GRAMMAR_MULTI_PROMPT_PATH = os.path.join(SHARED_DIR, "grammar_multi_prompt.txt")


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
# 次の断片の先頭が引用符・英字に加えて「(1)」のような連番ラベルの場合も
# 境界とみなす(2026-07-29追加)。「記述式・書き換え問題」でGeminiが
# 「(1) Good lighting helps. (2) It makes the room look spacious.」のように
# 引用符を使わず連番ラベルだけで文を並べることがあり、そのままだと
# 改行が一切入らず1つの段落になってしまっていたための対応。
_SENTENCE_BOUNDARY_LOOKAHEAD = r"(?:[\"'“”‘’A-Za-z]|\(\d+\))"
_JA_EN_BOUNDARY_RE = re.compile(r"([。！？])\s*(?=" + _SENTENCE_BOUNDARY_LOOKAHEAD + r")")
# 英文側が複数文にわたる場合、文末(.!?)+空白+次の文の頭(引用符/大文字/
# 連番ラベル)の境目でも改行する。
_EN_SENTENCE_BREAK_RE = re.compile(r"(?<=[.!?])\s+(?=" + _SENTENCE_BOUNDARY_LOOKAHEAD + r")")


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


def generate_grammar_multi_items_from_question(
    question: str, api_key: str, model: str, batch_key: str = None
) -> list:
    """「AIに質問」タブの質問文から、Grammar Multi(文法・複数出題形式)の
    独立ノート3件分のitem dictを生成する(grammar_multi_builder.build_deck()
    にそのまま渡せる形式)。

    戻り値の各dictは、build_grammar_multi_v1_updated.GRAMMAR_MODELの
    フィールド(pattern, question, choices, answer, example, example_ja,
    why, whynot, example_blank, answer_plain)に対応する値(choices/whynot/exampleはcanon側のヘルパー
    関数でHTML化済み)に加え、guid計算・重複検出用のtopic_key/note_index/
    batch_key/source_keyを持つ。

    batch_key(2026-08-29追加)は**この1回の生成を識別する値**で、guidの末尾に
    足される。同じ質問を投げ直すとGeminiは毎回違う問題を作るのに、以前は
    guidが「質問文+問題番号」だけで決まっていたため、後から生成した問題を
    別のapkgで取り込むと既存ノートと同じguidと判定されて**取り込まれず黙って
    捨てられていた**。省略すると新しい値を採番する(テストから固定値を渡せる
    ようにするための引数で、通常の呼び出しでは指定しない)。
    """
    if not GRAMMAR_MULTI_CANON_AVAILABLE:
        raise GeminiClientError(
            "build_grammar_multi_v1_updated.py が見つからないか、"
            "genankiがインストールされていません。"
        )
    prompt = _fill_placeholders(_load_shared_prompt(GRAMMAR_MULTI_PROMPT_PATH), question=question)
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json_array(text)
    if not parsed:
        raise GeminiClientError(f"Gemini応答が空、または配列ではありません: {text[:300]}")

    topic_key = " ".join(question.strip().casefold().split())
    # このバッチを識別する値。itemに保存され、以後変わらない(guidの安定性は
    # これに依存するので、あとから振り直さないこと)。
    if not batch_key:
        batch_key = uuid.uuid4().hex[:12]
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
            # 「3. 理由想起」の表に出す正解文(2026-08-29追加)。answerと違い
            # **正解の選択肢ラベル「(A) 」を付けない**。TTS対象からも外して
            # あるので[sound:]タグも入らない(「AIに質問」タブのTTS対象は
            # Answer+Exampleのみ)。表で正解が読み上げられてしまうのを
            # 構造的に防ぐためのフィールド。
            "answer_plain": note.get("answer", ""),
            "example": _grammar_multi_canon.example_en(examples) if examples else "",
            "example_ja": _grammar_multi_canon.example_ja(examples) if examples else "",
            # 穴あき版(2026-08-21追加)。Geminiが例文中の学習対象語を<b>で
            # 囲んでこなかった場合は空文字になり、4枚目(例文穴埋め)の
            # カードは作られない。
            "example_blank": _grammar_multi_canon.example_blank(examples) if examples else "",
            "why": note.get("why", ""),
            "whynot": "".join(
                _grammar_multi_canon.whynot_item(w.get("opt", ""), w.get("reason", "")) for w in whynot
            ),
            "topic_key": topic_key,
            "note_index": i,
            "batch_key": batch_key,
            "source_key": ("chat_grammar", f"{topic_key}::{i}::{batch_key}"),
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
# プロンプトを流用せず、generate_shuujuku_items_from_rows()と同じ構造の
# 専用プロンプト・専用のGemini呼び出しで生成する(1回の質問につき
# Gemini呼び出しが1回増える)。

SHUUJUKU_PROMPT_PATH = os.path.join(SHARED_DIR, "shuujuku_prompt.txt")


def generate_shuujuku_item_from_question(question: str, api_key: str, model: str) -> dict:
    """「AIに質問」タブの質問文から、build_shuujuku_v1.build_deck()に渡せる
    item dictを1つ生成する(「3問+習熟用4問目」のうちの4問目)。"""
    prompt = _fill_placeholders(_load_shared_prompt(SHUUJUKU_PROMPT_PATH), question=question)
    text = call_gemini(prompt, api_key, model)
    parsed = _extract_json(text)
    topic_key = " ".join(question.strip().casefold().split())
    return _item_from_parsed(
        parsed,
        source_key=("chat", topic_key),
        source_label="由来: AIに質問",
    )


# 単語カード生成プロンプトも同じ方式で共有する。
WORD_PROMPT_PATH = os.path.join(SHARED_DIR, "word_card_prompt.txt")


def generate_vocab_cards_from_words(pairs: list, api_key: str, model: str) -> list:
    """「単語」タブの入力(未学習の単語+文脈文のペア)から、build_word_v1.build_deck()向けの
    item dict(word/reading/pos/meaning/example/example_ja/example_blank/note)を
    まとめて生成する。

    pairs: (word, context_sentence) のタプルのリスト
    戻り値: pairsと同じ長さのリスト。生成できなかった件はNone(呼び出し側が
            どの単語が失敗したかを利用者に伝えられるよう、詰めずに位置を保つ)。
    バッチ全体が失敗した場合はGeminiClientErrorを送出する。

    wordフィールドはAIに生成させず、入力された単語をそのまま使う(AIによる表記ゆれを防ぐため)。
    **注意: 「習熟用(音読)」ストックとは無関係。この関数の戻り値はword_stock.pyでのみ
    扱い、shuujuku_stock.pyには一切渡さないこと(2026-07-27、片桐の明示的な指示)。**
    """
    results = [None] * len(pairs)
    done = 0

    for chunk in _chunk_for_batch(pairs):
        lines = "\n".join(
            f"[{i + 1}] 単語: {word}\n    文脈: {(context or '').strip() or '(なし)'}"
            for i, (word, context) in enumerate(chunk)
        )
        prompt = _fill_placeholders(
            _load_shared_prompt(WORD_PROMPT_PATH),
            count=str(len(chunk)),
            items=lines,
        )
        parsed = _extract_json_array(call_gemini(prompt, api_key, model))

        for i, entry in enumerate(_align_batch_results(parsed, len(chunk))):
            if entry is None:
                continue
            word, context_sentence = chunk[i]
            results[done + i] = {
                "word": word.strip(),
                "reading": entry.get("reading", ""),
                "pos": entry.get("pos", ""),
                "meaning": entry.get("meaning", ""),
                "example": entry.get("example", ""),
                "example_ja": entry.get("example_ja", ""),
                "example_blank": entry.get("example_blank", ""),
                "note": entry.get("note", ""),
                "context_sentence": (context_sentence or "").strip(),
            }
        done += len(chunk)

    return results


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

# system_instruction・responseSchemaは、他のプロンプトと同じ理由(Web版と
# 片方だけ直して不一致になる事故を防ぐ)でdocs/shared/へ切り出してある
# (2026-07-29、Web版のDailyConversation対応時)。Web側は
# docs/lib/gemini.jsのcorrectEnglishText()が同じ2ファイルをfetchで読む。
CORRECTION_SYSTEM_INSTRUCTION_PATH = os.path.join(SHARED_DIR, "correction_system_instruction.txt")
CORRECTION_RESPONSE_SCHEMA_PATH = os.path.join(SHARED_DIR, "correction_response_schema.json")


def _load_shared_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise GeminiClientError(
            f"共有JSONファイルを読み込めませんでした: {path}\n{e}"
        ) from e


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
        "system_instruction": {
            "parts": [{"text": _load_shared_prompt(CORRECTION_SYSTEM_INSTRUCTION_PATH)}]
        },
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _load_shared_json(CORRECTION_RESPONSE_SCHEMA_PATH),
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
