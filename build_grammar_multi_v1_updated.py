# -*- coding: utf-8 -*-
# ==================================================================
# Grammar Multi (文法・複数出題形式) — 統合版・単一の正典ファイル (v2)
# model ID: 1907250010123 / deck: 02.単語・MindTips::文法・用法
#
# 【重要な変更】
# 片桐がAnki GUI側でテンプレート2〜4(セルフチェック/理由想起/例文穴埋め)を
# 削除し、現在は「1. 判断問題」のみが有効なテンプレートとなっている。
# このファイルはその状態に合わせ、templates を1つだけに削減している。
# MODEL_ID・フィールド構成・CSSは変更なし(既存ノート/学習履歴と完全互換)。
#
# 【1ノート=1カードの運用】
# 今後、1つの質問に対して複数の練習問題を作る場合も「1ノートから複数
# カードを生成する」方式は取らず、必ず独立したノートを複数作成すること。
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
  --core-bg: #d6cde6;
  --core-border: #8567bd;
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
  --core-bg: #201b28;
  --core-border: #7a5fc0;
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
    --core-bg: #201b28;
    --core-border: #7a5fc0;
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

.block {
  border-radius: 12px;
  padding: 14px 16px;
  margin: 12px 0;
}

.question-block {
  background: var(--question-bg);
  border: 1px solid var(--question-border);
}
.question-label { font-size: 12px; color: var(--sub); font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; }

.choices { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.choice {
  background: var(--choice-bg);
  border: 1px solid var(--choice-border);
  border-radius: 8px;
  padding: 7px 12px;
  font-family: "SF Mono", Menlo, monospace;
  font-size: 15.5px;
}

.answer-block {
  background: var(--answer-bg);
  border-left: 5px solid var(--answer-border);
}
.answer-block .label { font-weight: 700; font-size: 12.5px; color: var(--answer-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px;}
.answer-block .sentence { font-size: 18px; font-weight: 600; }

.example-block { background: var(--example-bg); border-left: 5px solid var(--example-border); }
.example-block .label { font-weight: 700; font-size: 12.5px; color: var(--example-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.example-item { margin: 0 0 10px 0; }
.example-item:last-child { margin-bottom: 0; }
.example-sentence { font-size: 16px; }
.example-ja { color: var(--sub); font-size: 14.5px; margin-top: 2px; }

.why-block { background: var(--why-bg); border-left: 5px solid var(--why-border); }
.why-block .label { font-weight: 700; font-size: 12.5px; color: var(--why-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }

.whynot-block { background: var(--whynot-bg); border-left: 5px solid var(--whynot-border); }
.whynot-block .label { font-weight: 700; font-size: 12.5px; color: var(--whynot-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.whynot-item { margin: 4px 0; }
.whynot-item .opt { font-family: "SF Mono", Menlo, monospace; font-weight: 700; }

.core-block { background: var(--core-bg); border-left: 5px solid var(--core-border); font-style: italic; font-size: 15.5px; }
.core-block .label { font-weight: 700; font-size: 12.5px; color: var(--core-border); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; font-style: normal; }

b { color: inherit; }
hr.sep { border: none; border-top: 1px solid var(--question-border); margin: 18px 0; }

.masked b {
  color: transparent;
  background: var(--sub);
  border-radius: 4px;
  padding: 0 2px;
}

.ex-num { font-weight: 700; }

.blank-hint { color: var(--sub); font-size: 14px; margin-bottom: 10px; }
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
  <div class="label">Examples</div>
  <div class="example-sentence">{{Example}}</div>
  {{#ExampleJA}}<div class="example-ja">{{ExampleJA}}</div>{{/ExampleJA}}
</div>
{{/Example}}

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

MODEL_ID = 1907250010123  # 既存と同一(フィールド・IDは不変。テンプレートのみ1つに削減)
GRAMMAR_MODEL = genanki.Model(
    MODEL_ID,
    'Grammar Multi (文法・複数出題形式)',
    fields=[
        {'name': 'Pattern'},
        {'name': 'Question'},
        {'name': 'Choices'},
        {'name': 'Answer'},
        {'name': 'Example'},
        {'name': 'ExampleJA'},
        {'name': 'Why'},
        {'name': 'WhyNot'},
    ],
    templates=[
        {'name': '1. 判断問題', 'qfmt': QUESTION_TEMPLATE_FRONT, 'afmt': QUESTION_TEMPLATE_BACK},
    ],
    css=CSS,
)

def choice(opt, text):
    return f'<div class="choice">({opt}) {text}</div>'

def whynot_item(opt, reason):
    return f'<div class="whynot-item"><span class="opt">({opt})</span> {reason}</div>'

def core(text_en):
    return f'<div class="block core-block"><div class="label">Core Image</div>{text_en}</div>'

def example_en(pairs):
    return "<br>".join(f'<span class="ex-num">Ex{i}.</span> {en}' for i, (en, ja) in enumerate(pairs, start=1))

def example_ja(pairs):
    return "<br>".join(f"└ {ja}" for en, ja in pairs)

# notes_data はこのファイルを流用する各バッチスクリプト側で定義し、
# genanki.Note(model=GRAMMAR_MODEL, ...) で1ノート=1カードとして追加すること。
