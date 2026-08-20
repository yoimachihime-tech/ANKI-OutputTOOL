# -*- coding: utf-8 -*-
# ==================================================================
# Grammar DailyConversation (日次英作文添削 v1) — 正典ファイル (Score対応版)
#
# 変更履歴:
# - Similarフィールドを廃止。類似表現の英文はExample、日本語解説はExampleJAへ統合
# - デッキは「02.単語・MindTips::DailyConversation」のサブデッキとして運用
# - Scoreフィールドを新規追加(文法/自然さ/伝わりやすさの3軸スコア + 解説)
#
# 【スプレッドシート】
# https://docs.google.com/spreadsheets/d/1ruIEHQk8J0rjjQQdiaT2NvnjeLrn9pbUqqvrUBJx9BE/
# 「添削結果」シートの列(新スキーマ):
# ID / 日時 / 原文 / 添削後 / 解説 / カテゴリ / 類似表現(英文) / 類似表現(解説) /
# 文法スコア / 自然さスコア / 伝わりやすさスコア / スコア解説 / Anki出力済み
#
# 【標準の出力ルール(必ず守ること)】
# 1. カテゴリが「誤りなし」の行は出力対象から除外する
# 2. ID列が重複している場合、先に出現した行のみを採用し、除外したIDを報告する
# 3. カテゴリに応じて Pattern ラベルを出し分ける(CATEGORY_PATTERN_MAP参照)
# 4. 起源判別のため、全ノートに source::gemini_dailyconv タグを付与する
# 5. guid はスプレッドシートのID列から生成する(genanki.guid_for('dailyconv', id))
# 6. 類似表現の英文/解説の対応があいまいな場合は機械的に推測せず、
#    解釈を提示してユーザーに確認を取る
# ==================================================================
import genanki

CSS = r"""
.card {
  font-family: -apple-system, "Hiragino Sans", "Helvetica Neue", Arial, sans-serif;
  font-size: 17px;
  line-height: 1.75;
  text-align: left;
  max-width: 640px;
  margin: 0 auto;
  padding: 8px 4px 28px 4px;

  --bg: #e7e9ec;
  --fg: #000000;
  --sub: #6b7280;
  --pattern-bg: #eef2ff;
  --pattern-fg: #4338ca;
  --question-bg: #ccd1d7;
  --question-border: #b3b9c1;
  --choice-bg: #dcdfe3;
  --choice-border: #b3b9c1;
  --answer-bg: #ecdca0;
  --answer-border: #c7a83a;
  --why-bg: #c9dfc9;
  --why-border: #3a8f5c;
  --whynot-bg: #f0c9c9;
  --whynot-border: #c94a3f;
  --example-bg: #c7d3e2;
  --example-border: #5c85cf;
  --score-bg: #ded1ec;
  --score-border: #6b46c1;
  color: var(--fg);
  background: var(--bg);
}

.night_mode .card {
  --bg: #1a1c1f;
  --fg: #f0f1f3;
  --sub: #9aa1ab;
  --pattern-bg: #2b2f6b;
  --pattern-fg: #c7cdff;
  --question-bg: #212326;
  --question-border: #34373b;
  --choice-bg: #24272a;
  --choice-border: #383c40;
  --answer-bg: #332b10;
  --answer-border: #8c7620;
  --why-bg: #16241b;
  --why-border: #3a7350;
  --whynot-bg: #271515;
  --whynot-border: #96453c;
  --example-bg: #182130;
  --example-border: #4d76b3;
  --score-bg: #241b30;
  --score-border: #7c5bc4;
}

@media (prefers-color-scheme: dark) {
  .card {
    --bg: #1a1c1f;
    --fg: #f0f1f3;
    --sub: #9aa1ab;
    --pattern-bg: #2b2f6b;
    --pattern-fg: #c7cdff;
    --question-bg: #212326;
    --question-border: #34373b;
    --choice-bg: #24272a;
    --choice-border: #383c40;
    --answer-bg: #332b10;
    --answer-border: #8c7620;
    --why-bg: #16241b;
    --why-border: #3a7350;
    --whynot-bg: #271515;
    --whynot-border: #96453c;
    --example-bg: #182130;
    --example-border: #4d76b3;
    --score-bg: #241b30;
    --score-border: #7c5bc4;
  }
}

.pattern-tag {
  display: inline-block;
  background: var(--pattern-bg);
  color: var(--pattern-fg);
  font-weight: 700;
  font-size: 14px;
  padding: 4px 12px;
  border-radius: 999px;
  margin-bottom: 12px;
  letter-spacing: 0.02em;
}

.block { border-radius: 12px; padding: 14px 16px; margin: 12px 0; }

.question-block { background: var(--question-bg); border: 1px solid var(--question-border); }
.question-label { font-size: 12px; color: var(--sub); font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; }

.choices { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.choice { background: var(--choice-bg); border: 1px solid var(--choice-border); border-radius: 8px; padding: 7px 12px; font-family: "SF Mono", Menlo, monospace; font-size: 15.5px; }

.answer-block { background: var(--answer-bg); border-left: 5px solid var(--answer-border); }
.answer-block .label { font-weight: 700; font-size: 12.5px; color: var(--answer-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px;}
.answer-block .sentence { font-size: 18px; font-weight: 600; }

.example-block { background: var(--example-bg); border-left: 5px solid var(--example-border); }
.example-block .label { font-weight: 700; font-size: 12.5px; color: var(--example-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.example-item { margin: 0 0 10px 0; }
.example-item:last-child { margin-bottom: 0; }
.example-sentence { font-size: 16px; }
.example-ja { color: var(--sub); font-size: 14.5px; margin-top: 2px; }

.score-block { background: var(--score-bg); border-left: 5px solid var(--score-border); }
.score-block .label { font-weight: 700; font-size: 12.5px; color: var(--score-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.score-badges { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.score-badge { background: var(--choice-bg); border: 1px solid var(--choice-border); border-radius: 8px; padding: 6px 10px; font-size: 14px; }
.score-badge .num { font-weight: 700; font-family: "SF Mono", Menlo, monospace; }
.score-comment { color: var(--sub); font-size: 14.5px; }

.why-block { background: var(--why-bg); border-left: 5px solid var(--why-border); }
.why-block .label { font-weight: 700; font-size: 12.5px; color: var(--why-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }

.whynot-block { background: var(--whynot-bg); border-left: 5px solid var(--whynot-border); }
.whynot-block .label { font-weight: 700; font-size: 12.5px; color: var(--whynot-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }

b { color: inherit; }
hr.sep { border: none; border-top: 1px solid var(--question-border); margin: 18px 0; }
.ex-num { font-weight: 700; }
"""

SCROLL_SCRIPT = r"""
<script>
(function() {
  function scrollToAnswer() {
    var el = document.getElementById('answer-target');
    if (el) { el.scrollIntoView({behavior: 'smooth', block: 'start'}); }
  }
  setTimeout(scrollToAnswer, 50);
})();
</script>
"""

QUESTION_TEMPLATE_FRONT = r"""
<div class="pattern-tag">{{Pattern}}</div>
<div class="block question-block">
  <div class="question-label">Question</div>
  {{Question}}
  {{#Choices}}
  <div class="choices">
  {{Choices}}
  </div>
  {{/Choices}}
</div>
"""

QUESTION_TEMPLATE_BACK = QUESTION_TEMPLATE_FRONT + r"""
<hr class="sep">
<div class="block answer-block" id="answer-target">
  <div class="label">Answer</div>
  <div class="sentence">{{Answer}}</div>
</div>

{{#Example}}
<div class="block example-block">
  <div class="label">類似表現</div>
  <div class="example-sentence">{{Example}}</div>
  {{#ExampleJA}}<div class="example-ja">{{ExampleJA}}</div>{{/ExampleJA}}
</div>
{{/Example}}

{{#Score}}
<div class="block score-block">
  <div class="label">Self-Assessment</div>
  {{Score}}
</div>
{{/Score}}

<div class="block why-block">
  <div class="label">Why</div>
  {{Why}}
</div>

{{#WhyNot}}
<div class="block whynot-block">
  <div class="label">Why not the others?</div>
  {{WhyNot}}
</div>
{{/WhyNot}}
""" + SCROLL_SCRIPT

MODEL_ID = 1907260020123  # 既存 Grammar Multi (1907250010123) とは完全に別ID。前回作成時から不変
GRAMMAR_DC_MODEL = genanki.Model(
    MODEL_ID,
    'Grammar DailyConversation (日次英作文添削 v1)',
    fields=[
        {'name': 'Pattern'},
        {'name': 'Question'},
        {'name': 'Choices'},
        {'name': 'Answer'},
        {'name': 'Example'},
        {'name': 'ExampleJA'},
        {'name': 'Why'},
        {'name': 'WhyNot'},
        {'name': 'Score'},
    ],
    templates=[
        {'name': '1. 添削問題', 'qfmt': QUESTION_TEMPLATE_FRONT, 'afmt': QUESTION_TEMPLATE_BACK},
    ],
    css=CSS,
)

DECK_ID = 1907260010001
DECK_NAME = '02.単語・MindTips::DailyConversation'
SOURCE_TAG = 'source::gemini_dailyconv'

CATEGORY_PATTERN_MAP = {
    "文法": "誤り訂正問題(文法)",
    "語彙": "誤り訂正問題(語彙)",
    "自然さ": "表現改善問題",
}


def dedupe_rows(rows):
    seen = set()
    deduped = []
    duplicate_ids = []
    for r in rows:
        if r['id'] in seen:
            duplicate_ids.append(r['id'])
            continue
        seen.add(r['id'])
        deduped.append(r)
    return deduped, duplicate_ids


def process_sheet_rows(raw_rows):
    filtered = [r for r in raw_rows if r.get('category') != '誤りなし']
    deduped, duplicate_ids = dedupe_rows(filtered)
    if duplicate_ids:
        print(f"⚠ 重複IDを検出し除外しました: {duplicate_ids}")
    return deduped


def build_score_html(grammar, naturalness, comprehensibility, comment):
    return (
        '<div class="score-badges">'
        f'<span class="score-badge">文法 <span class="num">{grammar}</span>/100</span>'
        f'<span class="score-badge">自然さ <span class="num">{naturalness}</span>/100</span>'
        f'<span class="score-badge">伝わりやすさ <span class="num">{comprehensibility}</span>/100</span>'
        '</div>'
        f'<div class="score-comment">{comment}</div>'
    )


def build_deck(rows, start_num: int = 1):
    """rows の各要素キー: id, original, corrected, explanation, category,
    similar_en_list(list[str]), similar_ja_list(list[str]),
    grammar_score, naturalness_score, comprehensibility_score, score_comment (任意)

    start_num: cards.due(Ankiの新規カードの位置)の開始番号(既定1、呼び出し元が
    省略した場合は1始まりの通し番号)。以前は`enumerate(rows)`の0始まりの
    インデックスをそのままdueにしていたため、出力のたびに0から振り直され、
    別バッチのカードとAnki側で位置が衝突していた(2026-08-20修正)。呼び出し元
    (deck_builder.py→tts_gui.py)がdue_counter.get_next_due("daily")で続き番号を
    渡す。このファイル自体はこの引数を受け取って使うだけで、続き番号の管理は
    しない(正典との差分を最小限にするための局所的な変更。
    build_shuujuku_v1.build_deck()のstart_numと同じ扱い)。
    """
    deck = genanki.Deck(DECK_ID, DECK_NAME)
    for i, r in enumerate(rows):
        pattern = CATEGORY_PATTERN_MAP.get(r['category'], "誤り訂正問題")
        question = (
            "<b>指示:</b> 以下の英文には誤りがあります。誤りを見つけて訂正してください。<br><br>"
            f"{r['original']}"
        )
        answer = r['corrected']
        why = r['explanation']

        en_list = r.get('similar_en_list', [])
        ja_list = r.get('similar_ja_list', [])

        example = "<br>".join(
            f'<span class="ex-num">Ex{idx}.</span> {en}'
            for idx, en in enumerate(en_list, start=1)
        )
        exampleja = "<br>".join(f"└ {ja}" for ja in ja_list)

        score_html = ""
        if all(k in r and r[k] is not None for k in
               ('grammar_score', 'naturalness_score', 'comprehensibility_score', 'score_comment')):
            score_html = build_score_html(
                r['grammar_score'], r['naturalness_score'],
                r['comprehensibility_score'], r['score_comment']
            )

        note = genanki.Note(
            model=GRAMMAR_DC_MODEL,
            fields=[pattern, question, "", answer, example, exampleja, why, "", score_html],
            guid=genanki.guid_for('dailyconv', r['id']),
            tags=[SOURCE_TAG],
            due=start_num + i,
        )
        deck.add_note(note)
    return deck
