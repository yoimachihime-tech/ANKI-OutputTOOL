# -*- coding: utf-8 -*-
# ==================================================================
# 単語(未学習の単語)カード生成 — v1
#
# 読書中に出会った未知の英単語を、Ankiカード化するための定義。
# 「習熟用(音読)」とは完全に別のノートタイプ・デッキであり、
# ここで生成したカードは習熟用ストック(shuujuku_stock.json)には
# 一切流さない(片桐の明示的な指示、2026-07-27)。単語カードだけの
# 専用ストック(word_stock.py / word_stock.json)を経由する。
#
# model ID: 1907245001123 (既存の実ノートタイプ「Vocab (単語 v1)」と同一。
#   片桐が2026-07-27にエクスポートした「選択中のノート.apkg」を実際に
#   読み込み、フィールド名・カードテンプレート・CSS・デッキを一字一句
#   そのまま複製した。推測は一切含まない)
# deck: 02.単語・MindTips::単語 (固定)
#
# フィールド構成(8個、この順序を変更しないこと): Word / Reading / POS /
#   Meaning / Example / ExampleJA / ExampleBlank / Note
# カードテンプレートは2種類:
#   1. 意味想起(英→日): 単語を見て意味を思い出す
#   2. 語彙想起(文脈→英単語): 意味・文脈から単語を思い出す
# ==================================================================
import genanki

MODEL_ID = 1907245001123
DECK_ID = 1785112749312
DECK_NAME = '02.単語・MindTips::単語'

FIELD_NAMES = [
    'Word', 'Reading', 'POS', 'Meaning', 'Example', 'ExampleJA', 'ExampleBlank', 'Note',
]

TEMPLATE_1_QFMT = """
<div class="block head-block">
  <div class="word-head">
    <span class="word-main">{{Word}}</span>
    <span class="word-reading">{{Reading}}</span>
    <span class="word-pos">{{POS}}</span>
  </div>
</div>
"""

TEMPLATE_1_AFMT = """
<div class="block head-block">
  <div class="word-head">
    <span class="word-main">{{Word}}</span>
    <span class="word-reading">{{Reading}}</span>
    <span class="word-pos">{{POS}}</span>
  </div>
</div>

<hr class="sep">
<div class="block meaning-block">
  <div class="label">Meaning</div>
  <div class="meaning-text">{{Meaning}}</div>
</div>

<div class="block example-block">
  <div class="label">Example</div>
  <div class="example-sentence">{{Example}}</div>
  {{#ExampleJA}}<div class="example-ja">{{ExampleJA}}</div>{{/ExampleJA}}
</div>

{{#Note}}
<div class="block note-block">
  <div class="label">Note</div>
  {{Note}}
</div>
{{/Note}}
"""

TEMPLATE_2_QFMT = """
<div class="context-hint">この意味を表す単語を、下の空所に当てはめてください</div>
<div class="block meaning-block">
  <div class="label">Meaning</div>
  <div class="meaning-text">{{Meaning}} <span class="word-pos">{{POS}}</span></div>
</div>
<div class="blank-sentence">{{ExampleBlank}}</div>
"""

TEMPLATE_2_AFMT = """
<div class="block head-block">
  <div class="word-head">
    <span class="word-main">{{Word}}</span>
    <span class="word-reading">{{Reading}}</span>
    <span class="word-pos">{{POS}}</span>
  </div>
</div>
<hr class="sep">
<div class="block example-block">
  <div class="label">Example</div>
  <div class="example-sentence">{{Example}}</div>
  {{#ExampleJA}}<div class="example-ja">{{ExampleJA}}</div>{{/ExampleJA}}
</div>
{{#Note}}
<div class="block note-block">
  <div class="label">Note</div>
  {{Note}}
</div>
{{/Note}}
"""

BASE_CSS = """
.card {
  font-family: -apple-system, "Hiragino Sans", "Helvetica Neue", Arial, sans-serif;
  font-size: 17px;
  line-height: 1.75;
  text-align: left;
  max-width: 640px;
  margin: 0 auto;
  padding: 8px 4px 28px 4px;

  --bg: #e7e9ec;
  --fg: #1f2328;
  --sub: #6b7280;
  --word-bg: #eef2ff;
  --word-fg: #4338ca;
  --head-bg: #ccd1d7;
  --head-border: #b3b9c1;
  --meaning-bg: #ecdca0;
  --meaning-border: #c7a83a;
  --example-bg: #c7d3e2;
  --example-border: #5c85cf;
  --note-bg: #d6cde6;
  --note-border: #8567bd;
  --word-color: #000000;
  color: var(--fg);
  background: var(--bg);
}

.night_mode .card {
  --bg: #1a1c1f;
  --fg: #f0f1f3;
  --sub: #9aa1ab;
  --word-bg: #2b2f6b;
  --word-fg: #c7cdff;
  --head-bg: #212326;
  --head-border: #34373b;
  --meaning-bg: #332b10;
  --meaning-border: #8c7620;
  --example-bg: #182130;
  --example-border: #4d76b3;
  --note-bg: #201b28;
  --note-border: #7a5fc0;
  --word-color: var(--fg);
}

@media (prefers-color-scheme: dark) {
  .card {
    --bg: #1a1c1f;
    --fg: #f0f1f3;
    --sub: #9aa1ab;
    --word-bg: #2b2f6b;
    --word-fg: #c7cdff;
    --head-bg: #212326;
    --head-border: #34373b;
    --meaning-bg: #332b10;
    --meaning-border: #8c7620;
    --example-bg: #182130;
    --example-border: #4d76b3;
    --note-bg: #201b28;
    --note-border: #7a5fc0;
    --word-color: var(--fg);
  }
}

.head-block {
  background: var(--head-bg);
  border: 1px solid var(--head-border);
}
.word-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.word-main { font-size: 28px; font-weight: 700; color: var(--word-color); }
.word-reading { color: var(--sub); font-size: 15px; font-family: "SF Mono", Menlo, monospace; }
.word-pos {
  display: inline-block;
  background: var(--word-bg);
  color: var(--word-fg);
  font-size: 12.5px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
}

.block { border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
.label { font-weight: 700; font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }

.meaning-block { background: var(--meaning-bg); border-left: 5px solid var(--meaning-border); }
.meaning-block .label { color: var(--meaning-border); }
.meaning-text { font-size: 19px; font-weight: 600; }

.example-block { background: var(--example-bg); border-left: 5px solid var(--example-border); }
.example-block .label { color: var(--example-border); }
.example-sentence { font-size: 16px; }
.example-ja { color: var(--sub); font-size: 14.5px; margin-top: 4px; }

.note-block { background: var(--note-bg); border-left: 5px solid var(--note-border); font-size: 15px; color: var(--word-color); }
.note-block .label { color: var(--note-border); }

.context-hint { color: var(--sub); font-size: 13px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
.blank-sentence { font-size: 17px; background: var(--head-bg); border: 1px solid var(--head-border); border-radius: 12px; padding: 14px 16px; }

b { color: inherit; }
hr.sep { border: none; border-top: 1px solid var(--head-border); margin: 18px 0; }
"""

WORD_MODEL = genanki.Model(
    MODEL_ID,
    'Vocab (単語 v1)',
    fields=[{'name': name} for name in FIELD_NAMES],
    templates=[
        {'name': '1. 意味想起(英→日)', 'qfmt': TEMPLATE_1_QFMT, 'afmt': TEMPLATE_1_AFMT},
        {'name': '2. 語彙想起(文脈→英単語)', 'qfmt': TEMPLATE_2_QFMT, 'afmt': TEMPLATE_2_AFMT},
    ],
    css=BASE_CSS,
)


def build_guid(item):
    """単語テキスト(前後空白除去・小文字化)を一意キーとする。
    同じ単語を複数回生成しても、既存ノートの学習履歴を壊さず上書き対象に
    なるようにするため(genankiの仕様: 同じguidのノートは重複追加されない)。"""
    return genanki.guid_for('word', item['word'].strip().lower())


def build_deck(items):
    """items: 1件=1カードで生成される。各itemは以下のキーを持つdict:
        {
            "word": str,           # 単語そのもの(Wordフィールド)
            "reading": str,        # IPA発音記号
            "pos": str,            # 品詞(英語)
            "meaning": str,        # 日本語での意味
            "example": str,        # 例文(<br>区切り、対象単語は<b></b>)
            "example_ja": str,     # 例文の日本語訳
            "example_blank": str,  # 穴埋め版の例文
            "note": str,           # 日本語での補足説明(派生語・語源など)
        }
    """
    deck = genanki.Deck(DECK_ID, DECK_NAME)
    for item in items:
        note = genanki.Note(
            model=WORD_MODEL,
            fields=[
                item.get('word', ''),
                item.get('reading', ''),
                item.get('pos', ''),
                item.get('meaning', ''),
                item.get('example', ''),
                item.get('example_ja', ''),
                item.get('example_blank', ''),
                item.get('note', ''),
            ],
            guid=build_guid(item),
        )
        deck.add_note(note)
    return deck
