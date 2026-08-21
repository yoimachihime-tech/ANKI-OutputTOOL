# -*- coding: utf-8 -*-
# ==================================================================
# Grammar Multi (文法・複数出題形式) — 統合版・単一の正典ファイル (v2)
# model ID: 1907250010123 / deck: 02.単語・MindTips::文法・用法
#
# 【テンプレート構成(2026-08-21に実態へ合わせた)】
# 以前このファイルには「片桐がAnki GUI側でテンプレート2〜4を削除したので
# templates は1つだけ」と書いてあったが、**実際のコレクションには4つとも
# 残っていた**(2026-08-21に実データで確認)。その食い違いのせいで、ツールが
# 作った24ノートは「1. 判断問題」1枚しか生えず、それ以前の131ノートは4枚、
# という不揃いな状態になっていた。片桐の判断で**実態(4テンプレート)に
# 合わせる**ことにし、このファイルに4つとも定義している。
#
# 【2026-08-21の「例文穴埋め」の作り直し】
# 旧「4. 例文穴埋め」は、表で `{{Example}}` を `.masked` クラス付きで出し、
# CSSで `<b>` を透明にして空所に見せる方式だった。しかし**音声タグ
# `[sound:…]` も同じ Example フィールドに入る**ため、Ankiが `[sound:]` を
# CSSより先に処理する仕様により、**隠した語が音声で丸聞こえ**になっていた
# (CLAUDE.mdの「音声が入るフィールドと隠したい答えは物理的に分離すること」
# に、このテンプレートだけ違反していた)。さらに本ツールが作る Example には
# `<b>` が1つも入らないため、新しいカードでは**そもそも穴が開かず**、表に
# 完全な例文と音声がそのまま出ていた。
#
# 対策として `ExampleBlank`(穴あき版・音声タグを持たない)フィールドを
# 追加し、表はそれだけを出す。完全な例文と音声は裏の `{{Example}}` にだけ
# 置く。`ExampleBlank` が空のノートでは表が空になるので、Ankiは4枚目の
# カードを作らない(穴が開かないのに出題してしまう事故を構造的に防ぐ)。
# あわせて、テンプレート3・4にあった
# `<div id="qb-source" style="display:none">{{Question}}</div>` + JS の
# ヒント抽出も撤去した(目印 `<b>状況:</b>` は本ツール製ノートに1件も無く、
# 常に空振りしていた。Questionフィールド全体を非表示でDOMに置くのは、
# ②でQuestionを読み上げ対象に選んだときに「画面に無いのに読まれる」
# 事故のもとでもある)。MODEL_IDは不変(既存ノート/学習履歴と互換)。
#
# 【1ノート=1カードの運用】
# 今後、1つの質問に対して複数の練習問題を作る場合も「1ノートから複数
# カードを生成する」方式は取らず、必ず独立したノートを複数作成すること。
# ==================================================================
import re

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

.ex-num { font-weight: 700; }

/* 「4. 例文穴埋め」の空所。ExampleBlankフィールドの中身。
   旧方式(.masked b でExampleの<b>をCSSで透明にする)は、同じフィールドに
   入っている音声タグが隠した語を読み上げてしまうため廃止した
   (2026-08-21。ファイル冒頭のコメント参照)。 */
.blank { font-family: "SF Mono", Menlo, monospace; letter-spacing: .05em; color: var(--sub); }
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

SELFCHECK_TEMPLATE_FRONT = r"""
<div class="pattern-tag">{{Pattern}}</div>
<div class="block question-block">
  <div class="question-label">Self-Check (no options)</div>
  {{Question}}
</div>
"""

SELFCHECK_TEMPLATE_BACK = SELFCHECK_TEMPLATE_FRONT + r"""
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

# 「3. 理由想起」: 正しい文だけを見せて理由を思い出させる。
# 裏は{{FrontSide}}を使い、Answerの音声タグが裏でもう一度鳴らないようにする
# (Ankiは{{FrontSide}}から[sound:]を取り除く)。
REASON_TEMPLATE_FRONT = r"""
<div class="pattern-tag">{{Pattern}}</div>
<div class="block answer-block">
  <div class="label">Sentence</div>
  <div class="sentence">{{Answer}}</div>
</div>
<div class="question-label" style="margin-top:14px;">Why is this correct?{{#WhyNot}} Why not the alternatives?{{/WhyNot}}</div>
"""

REASON_TEMPLATE_BACK = r"""{{FrontSide}}

<hr class="sep">
<div class="block why-block" id="answer-target">
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

# 「4. 例文穴埋め」: 表は穴あき版(ExampleBlank)だけ。**音声タグを持つ
# Exampleは表に出さない**(隠した語が音声で漏れるのを構造的に防ぐ)。
# 表全体を{{#ExampleBlank}}で囲んであるので、穴あき版が無いノートでは
# 表が空になり、Ankiはこのカードを作らない。
BLANK_TEMPLATE_FRONT = r"""
{{#ExampleBlank}}
<div class="pattern-tag">{{Pattern}}</div>
<div class="block question-block">
  <div class="question-label">Fill in the blank</div>
  <div class="example-sentence">{{ExampleBlank}}</div>
  {{#ExampleJA}}<div class="example-ja">{{ExampleJA}}</div>{{/ExampleJA}}
</div>
{{/ExampleBlank}}
"""

BLANK_TEMPLATE_BACK = r"""{{FrontSide}}

<hr class="sep">
<div class="block example-block" id="answer-target">
  <div class="label">Answer</div>
  <div class="example-sentence">{{Example}}</div>
</div>

<div class="block why-block">
  <div class="label">Why</div>
  {{Why}}
</div>
""" + SCROLL_SCRIPT

MODEL_ID = 1907250010123  # 既存と同一(IDは不変。フィールドは末尾に追加のみ)
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
        # 2026-08-21追加。**必ず末尾に足すこと**(既存ノートのフィールド順が
        # ずれると、コレクション側の中身が別のフィールドへ移動してしまう)。
        {'name': 'ExampleBlank'},
    ],
    templates=[
        {'name': '1. 判断問題', 'qfmt': QUESTION_TEMPLATE_FRONT, 'afmt': QUESTION_TEMPLATE_BACK},
        {'name': '2. セルフチェック', 'qfmt': SELFCHECK_TEMPLATE_FRONT, 'afmt': SELFCHECK_TEMPLATE_BACK},
        {'name': '3. 理由想起', 'qfmt': REASON_TEMPLATE_FRONT, 'afmt': REASON_TEMPLATE_BACK},
        {'name': '4. 例文穴埋め', 'qfmt': BLANK_TEMPLATE_FRONT, 'afmt': BLANK_TEMPLATE_BACK},
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


# 例文中の学習対象語(Geminiに<b>で囲ませている)を空所に置き換えるための正規表現。
_BOLD_RE = re.compile(r"<b>(.*?)</b>", re.IGNORECASE | re.DOTALL)


def blank_out(en: str) -> str:
    """例文1文の <b>…</b> を空所に置き換える。"""
    return _BOLD_RE.sub('<span class="blank">____</span>', en)


def example_blank(pairs):
    """「4. 例文穴埋め」の表に出す、穴あき版の例文HTMLを返す。

    Exampleと同じ採番ラベルを付けるが、**音声タグは一切付かない**
    (音声は完全版のExampleにだけ入れる。同じフィールドに同居させると、
    Ankiが[sound:]をCSSより先に処理する仕様のせいで隠した語が読み上げられて
    しまう)。

    `<b>`で囲まれた語が1つも無い場合は**空文字を返す**。穴が開かないのに
    「Fill in the blank」を出すと、表に答えがそのまま見えてしまうため。
    空を返すとテンプレート4の表が空になり、Ankiはそのカードを作らない。
    """
    if not any(_BOLD_RE.search(str(p[0])) for p in pairs):
        return ""
    return "<br>".join(
        f'<span class="ex-num">Ex{i}.</span> {blank_out(str(p[0]))}'
        for i, p in enumerate(pairs, start=1)
    )

# notes_data はこのファイルを流用する各バッチスクリプト側で定義し、
# genanki.Note(model=GRAMMAR_MODEL, ...) で1ノート=1カードとして追加すること。
