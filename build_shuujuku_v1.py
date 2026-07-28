# -*- coding: utf-8 -*-
# ==================================================================
# 習熟用(音読方式) — 正式ファイル (v1)
# 元は「ATSU方式(PDF再現・音読用)」の引き継ぎプロンプトをベースに、
# 以下2点を変更した:
#   1. 1項目=1カード(旧: 2項目=1カード)
#   2. 出力先デッキを固定(旧: 依頼のたびに可変)
#
# model ID: 1901020103491 (旧プロンプトと同一、フィールド構成
#   Num/Content は不変のため、Anki GUI側の変更は不要)
# deck: 02.単語・MindTips::習熟用 (固定)
#
# 「表裏同一・出題形式にしない」ルールはクイズ形式ではなく、
# 表示された内容をそのまま音読して練習するためのルール。
# 答えを隠す・当てさせる設計は一切しないこと。
#
# 入口は2つ、どちらもこのファイルのbuild_deck()を使う:
#   a) 直接チャット入力(PDF・質問・表現などをAIが都度items化)
#   b) DailyConversationのシート行(AIが解説を読み、文法パターンを
#      抽象化し、新しい例文を書き起こしてitems化)
#      → 類似表現(英文)をそのまま流用しない。あくまで同じ文法の
#        別の文章を新しく考えて examples に入れること。
# ==================================================================
import genanki
import html
import re

MODEL_ID = 1901020103491  # 旧「ATSU方式」プロンプトと同一(フィールド不変)
DECK_ID = 1907280020001   # 「習熟用」固定デッキ(新規)
DECK_NAME = '02.単語・MindTips::習熟用'

# NOTE(2026-07-24): 貼り付け時の文字化けから機械的に復元。以下は復元確度が
# 低いため、実際にAnkiで表示を見て違和感があれば修正すること
# (影響はpattern/meaning内のハイライト表示のみで、データ構造・notetype・
# デッキには一切影響しない)。
PLACEHOLDER_TOKENS = ["動詞/代名詞", "否定文", "形容詞", "代名詞", "主語", "動詞", "名詞", "時制", "数"]
PLACEHOLDER_RE = re.compile("(" + "|".join(re.escape(t) for t in PLACEHOLDER_TOKENS) + r"|\bX\b|\bY\b)")

BASE_CSS = r"""
.card { font-family: -apple-system, "Helvetica Neue", Arial, "Hiragino Sans", sans-serif;
    font-size: 18px; line-height: 1.7; text-align: left; color: #1a1a1a;
    background-color: #ffffff; padding: 16px; }
.night_mode.card { color: #e6e6e6; background-color: #2f2f31; }
*, *::before, *::after { box-sizing: border-box; }
.deck-title { font-size: 15px; font-weight: 700; color:#6b7280; margin-bottom: 10px; }
.night_mode .deck-title { color:#b0b3ba; }
.item-card { margin: 14px 0; padding: 16px; border-radius: 14px; border: 1px solid #e5e7eb; background:#ffffff; }
.night_mode .item-card { background:#3a3a3d; border-color:#55565c; }
.item-head { display:flex; align-items:center; gap:10px; margin-bottom: 10px; }
.item-num { display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:34px; padding:0 8px;
  border-radius: 10px; background:#ede9fe; color:#534ab7; font-weight:800; font-size:17px; }
.night_mode .item-num { background:#4b4470; color:#c9c2f7; }
.pattern-line { font-size: 21px; font-weight: 800; color:#1e3a8a; }
.night_mode .pattern-line { color:#8ab4f8; }
.pattern-line mark, .gloss-line mark { background: #cfe6ff; color:#0b3d91; border-radius:4px; padding:1px 4px; font-weight:800; }
.night_mode .pattern-line mark, .night_mode .gloss-line mark { background:#274a72; color:#bcdcff; }
.pattern-line u, .gloss-line u { text-decoration-color:#534ab7; }
.gloss-line { font-size: 14px; color:#6b7280; margin: 4px 0 12px; }
.night_mode .gloss-line { color:#b0b3ba; }
.ex-row { margin: 8px 0; padding: 10px 12px; border-radius: 10px; background:#f5f6f8; }
.night_mode .ex-row { background:#26262a; }
.ex-en { font-size: 17px; color:#0b3d91; font-weight:600; }
.night_mode .ex-en { color:#bcdcff; }
.ex-en mark { background:#cfe6ff; color:#0b3d91; border-radius:4px; padding:1px 4px; }
.night_mode .ex-en mark { background:#274a72; color:#bcdcff; }
.ex-jp { font-size: 15px; color:#374151; margin-top: 3px; }
.night_mode .ex-jp { color:#cbd5e1; }
.expl-box { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background:#fef7e6; border-left: 3px solid #f0b429; font-size: 14px; color:#78530a; }
.night_mode .expl-box { background:#4a3f22; border-left-color:#f0b429; color:#f0c05a; }
.expl-label { font-size: 11px; font-weight:700; color:#92660a; margin-bottom: 3px; }
.night_mode .expl-label { color:#f0c05a; }
.source-tag { font-size: 11px; color:#9ca3af; margin-top: 10px; text-align: right; }
.night_mode .source-tag { color:#7c8087; }
@media (max-width: 480px) {
  .card { padding: 6px 8px; font-size: 16px; }
  .item-card { padding: 10px; margin: 8px 0; border-radius: 10px; }
  .pattern-line { font-size: 18px; }
  .ex-en { font-size: 15.5px; }
}
"""

FRONT_TMPL = "{{Content}}"
BACK_TMPL = "{{FrontSide}}"  # 表裏同一内容(クイズ化しない)

SHUUJUKU_MODEL = genanki.Model(
    MODEL_ID,
    'ATSU方式 (PDF再現・音読用)',
    fields=[{'name': 'Num'}, {'name': 'Content'}],
    templates=[{'name': 'カード 1', 'qfmt': FRONT_TMPL, 'afmt': BACK_TMPL}],
    css=BASE_CSS,
)


def esc(s):
    return html.escape(s, quote=False)


def mark_placeholders(text_escaped):
    return PLACEHOLDER_RE.sub(lambda m: f"<u>{m.group(0)}</u>", text_escaped)


def mark_pattern(text_escaped):
    return PLACEHOLDER_RE.sub(lambda m: f"<mark>{m.group(0)}</mark>", text_escaped)


def highlight_example_en(en_text, hl_words):
    out = esc(en_text)
    if not hl_words:
        return out
    for w in hl_words:
        w = w.strip().strip(',').strip()
        if not w:
            continue
        pat = re.compile(re.escape(esc(w)), re.IGNORECASE)
        out = pat.sub(lambda m: f"<mark>{m.group(0)}</mark>", out, count=1)
    return out


def render_item(item_num, item):
    pattern_html = mark_pattern(esc(item['pattern']))
    gloss_html = mark_placeholders(esc(item['meaning'])) if item.get('meaning') else ''
    ex_html = []
    for ex in item['examples']:
        en, jp = ex[0], ex[1]
        hl_words = ex[2] if len(ex) > 2 else None
        en_html = highlight_example_en(en, hl_words)
        ex_html.append(
            f'<div class="ex-row"><div class="ex-en">{en_html}</div>'
            f'<div class="ex-jp">{esc(jp)}</div></div>'
        )
    ex_block = ''.join(ex_html)
    expl_block = ''
    if item.get('expl'):
        expl_block = f'<div class="expl-box"><div class="expl-label">解説</div>{esc(item["expl"])}</div>'
    gloss_block = f'<div class="gloss-line">{gloss_html}</div>' if gloss_html else ''
    source_block = ''
    if item.get('source_label'):
        source_block = f'<div class="source-tag">{esc(item["source_label"])}</div>'
    return (
        f'<div class="item-card"><div class="item-head">'
        f'<span class="item-num">{item_num:03d}</span>'
        f'<span class="pattern-line">{pattern_html}</span></div>'
        f'{gloss_block}{ex_block}{expl_block}{source_block}</div>'
    )


def build_guid(item):
    """item['source_key'] は呼び出し側が用意する形式の目安:
    - 直接チャット入力: ('chat', pattern文字列などの一意な値)
    - DailyConversation由来: ('dailyconv', シートのID列の値)
    """
    kind, key = item['source_key']
    return genanki.guid_for('shuujuku', kind, key)


def build_deck(items, deck_title_label="習熟用", start_num=1):
    """items: 1項目=1カードで生成される。各itemは以下の形式:
        {
            "pattern": str,
            "meaning": str または None,
            "examples": [(en, jp) または (en, jp, [ハイライト語句]), ...],
            "expl": str または None,
            "source_key": ("chat"|"dailyconv", 一意な文字列),
            "source_label": str または None (カード右上の出典表示、任意),
        }

    start_num: Numフィールド(ソートフィールド)の開始番号(既定1、呼び出し元が
    省略した場合は従来通りの挙動)。呼び出し元(tts_gui.py)が
    shuujuku_stock.get_next_num()で「これまでにAnkiへ出力した総数+1」を渡す
    ことで、出力するたびに001から採番し直して既存ノートと番号が重複する
    (2026-07-28、片桐からの指摘)のを避けられる。このファイル自体はこの
    引数を受け取って使うだけで、続き番号の管理はしない(正典との差分を
    最小限にするための局所的な変更)。
    """
    deck = genanki.Deck(DECK_ID, DECK_NAME)
    for offset, item in enumerate(items):
        idx = start_num + offset
        content = (
            f'<div class="deck-title">{esc(deck_title_label)} &nbsp;No.{idx:03d}</div>'
            + render_item(idx, item)
        )
        note = genanki.Note(
            model=SHUUJUKU_MODEL,
            fields=[f"{idx:03d}", content],
            guid=build_guid(item),
            due=idx,
        )
        deck.add_note(note)
    return deck
