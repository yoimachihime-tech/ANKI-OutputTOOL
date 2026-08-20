# -*- coding: utf-8 -*-
# ==================================================================
# 習熟用(音読方式) — 正式ファイル (v2)
# 元は「ATSU方式(PDF再現・音読用)」の引き継ぎプロンプトをベースに、
# 以下2点を変更した:
#   1. 1項目=1カード(旧: 2項目=1カード)
#   2. 出力先デッキを固定(旧: 依頼のたびに可変)
#
# 【v2(2026-08-20)での変更: 1文=1フィールド構成へ】
# v1は `Num` / `Content` の2フィールドで、Contentに英語例文・和訳・意味・
# 解説・出典をすべてHTMLで詰め込んでいた。このため
#   - フィールド単位でTTSをかけると日本語まで英語音声で読み上げてしまい、
#     Contentを解析して英文だけ抜き出す専用ロジック(tts_core.pyの
#     analyze_shuujuku_sentence_targets等)が必要だった
#   - HyperTTS等、フィールド単位で動く一般的なアドオンが使えなかった
# という問題があった。
#
# v2では「ATSU表現・構文120選 (音読用・TTS対応)」と同じ**1文=1フィールド**の
# 様式に合わせ、英文と和訳を別々のフィールドに分けた。これにより
# 英文フィールドだけをTTS対象に選べば済むようになり、上記の専用ロジックは
# 不要になった(tts_core.py側で撤去済み)。
#
# 様式の出所と、参照元との違い:
#   - フィールド名・テンプレート・CSSは「ATSU表現・構文120選 (音読用・TTS対応)」
#     (model_id 1901020500001)からコピーした。フィールド名の `I1` 接頭辞も
#     そのまま残してある(将来120選デッキとフィールドをコピーし合ったり、
#     HyperTTSのプリセットを使い回したりできるようにするため)。
#   - 参照元は2項目=1カードだが**こちらは1項目=1カードなので `I2*` は持たない**。
#   - 参照元は例文が3つまでだが、既存の習熟用ノートに例文4つのものが
#     あったため `I1Ex4EN/JP` を足してある(テンプレート側は
#     `{{#I1Ex4EN}}` の条件分岐なので、3つ以下のカードの見た目は参照元と同じ)。
#   - 参照元に無い `Source`(出典表示)を足してある(v1の `source-tag` 相当)。
#
# model ID: 1787203000001 (v1の1901020103491とは**別物**。フィールド構成が
#   まったく違うため、同じIDのまま出力するとAnki側で既存ノートタイプと
#   衝突するため新しいIDにした。既存50ノートは tools/migrate_shuujuku_notetype.py
#   でこのノートタイプへ移行する)
# deck: 02.単語・MindTips::習熟用 (固定、v1から変更なし)
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

MODEL_ID = 1787203000001  # v2で新規採番(v1: 1901020103491)
DECK_ID = 1907280020001   # 「習熟用」固定デッキ(v1から変更なし)
DECK_NAME = '02.単語・MindTips::習熟用'
MODEL_NAME = 'ATSU方式 (音読用・TTS対応)'

# 1カードに載せられる例文の最大数。参照元(120選)は3つまでだが、既存の
# 習熟用ノートに4つ持つものがあったため4にしてある。これを増やす場合は
# FIELD_ITEM_KEYS と FRONT_TMPL の両方に Ex5 を足すこと。
MAX_EXAMPLES = 4

# NOTE(2026-07-24): 貼り付け時の文字化けから機械的に復元。以下は復元確度が
# 低いため、実際にAnkiで表示を見て違和感があれば修正すること
# (影響はpattern/meaning内のハイライト表示のみで、データ構造・notetype・
# デッキには一切影響しない)。
PLACEHOLDER_TOKENS = ["動詞/代名詞", "否定文", "形容詞", "代名詞", "主語", "動詞", "名詞", "時制", "数"]
PLACEHOLDER_RE = re.compile("(" + "|".join(re.escape(t) for t in PLACEHOLDER_TOKENS) + r"|\bX\b|\bY\b)")

# Ankiフィールド名 → item(build_deck に渡す dict)から値を作るときのキー名。
# 並び順がそのままノートタイプのフィールド順になる。
# item_key は card_defs.py / tools/export_shared_card_defs.py / docs/lib/shuujuku.js
# が共有する「フィールド確定済みitem」のキー名でもある(3者で必ず揃えること)。
FIELD_ITEM_KEYS = [
    ("DeckTitle", "deck_title"),
    ("Num", "num"),
    ("I1Badge", "badge"),
    ("I1PatternEN", "pattern_en"),
    ("I1PatternJP", "pattern_jp"),
    ("I1Ex1EN", "ex1_en"),
    ("I1Ex1JP", "ex1_jp"),
    ("I1Ex2EN", "ex2_en"),
    ("I1Ex2JP", "ex2_jp"),
    ("I1Ex3EN", "ex3_en"),
    ("I1Ex3JP", "ex3_jp"),
    ("I1Ex4EN", "ex4_en"),
    ("I1Ex4JP", "ex4_jp"),
    ("I1Tip", "tip"),
    ("Source", "source"),
    ("AllAudio", "all_audio"),
]
FIELD_NAMES = [name for name, _key in FIELD_ITEM_KEYS]

# ソートフィールドはNum(参照元と同じ2番目のフィールド)。1番目のDeckTitleは
# 全ノートで同じ値になるため、ここを0のままにするとAnkiのブラウザ上で
# ソート列が全部同じ文字列になってしまう。
SORT_FIELD_INDEX = FIELD_NAMES.index("Num")

BASE_CSS = r"""
.card {
    font-family: -apple-system, "Helvetica Neue", Arial, "Hiragino Sans", sans-serif;
    font-size: 18px; line-height: 1.6; text-align: left; color: #1a1a1a;
    background-color: #ffffff; padding: 16px;
}
.night_mode.card { color: #e6e6e6; background-color: #2f2f31; }
*, *::before, *::after { box-sizing: border-box; }

.deck-title { font-size: 15px; font-weight: 700; color:#6b7280; margin-bottom: 10px; }
.night_mode .deck-title { color:#b0b3ba; }

.group-card { margin: 14px 0; padding: 16px; border-radius: 14px; border: 1px solid #e5e7eb; background:#ffffff; }
.night_mode .group-card { background:#3a3a3d; border-color:#55565c; }

.group-num { display:inline-flex; align-items:center; justify-content:center; min-width:30px; height:30px; padding:0 8px;
  border-radius: 9px; background:#ede9fe; color:#534ab7; font-weight:800; font-size:15px; margin-bottom:8px; }
.night_mode .group-num { background:#4b4470; color:#c9c2f7; }

.base-box { background:#f5f6f8; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
.night_mode .base-box { background:#26262a; }
.base-row { display:flex; align-items:center; gap:8px; }
.base-en { font-size: 20px; font-weight: 800; color:#1e3a8a; }
.night_mode .base-en { color:#8ab4f8; }
.base-sep { border-top: 1px dashed #c7cad1; margin: 6px 0; }
.night_mode .base-sep { border-top-color:#55565c; }
.base-jp { font-size: 14px; color:#374151; }
.night_mode .base-jp { color:#cbd5e1; }

.para-label { font-size: 13px; font-weight: 800; color:#9333ea; margin: 4px 0 8px; border-bottom:1px solid #ecdcfb; padding-bottom:4px;}
.night_mode .para-label { color:#c893f5; border-bottom-color:#4a3a5a; }

.ex-block { margin: 6px 0 12px; }
.para-item { display:flex; align-items:center; gap:10px; background:#f5f6f8; border-radius: 10px; padding: 8px 12px; margin: 0; }
.night_mode .para-item { background:#26262a; }
.para-arrow { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border-radius:50%;
  background:#111827; color:#fff; font-size:12px; flex-shrink:0; }
.night_mode .para-arrow { background:#e6e6e6; color:#2f2f31; }
.para-num { font-family: monospace; font-weight:700; color:#111827; font-size:14px; flex-shrink:0; }
.night_mode .para-num { color:#e6e6e6; }
.para-text { font-weight: 700; color:#0b3d91; font-size:17px; flex:1; }
.night_mode .para-text { color:#bcdcff; }

.ex-jp { font-size: 14px; color:#374151; margin: 4px 0 0 14px; }
.night_mode .ex-jp { color:#cbd5e1; }

.base-en mark, .base-jp mark, .para-text mark, .ex-jp mark {
  background:#cfe6ff; color:#0b3d91; border-radius:4px; padding:1px 4px; font-weight:800; }
.night_mode .base-en mark, .night_mode .base-jp mark,
.night_mode .para-text mark, .night_mode .ex-jp mark { background:#274a72; color:#bcdcff; }
.base-en u, .base-jp u { text-decoration-color:#534ab7; }

.tts-btn { flex-shrink:0; }

.tip-box { display:flex; align-items:flex-start; gap:10px; margin-top: 12px; padding: 10px; border-radius: 12px; border:1px solid #e5e7eb; }
.night_mode .tip-box { border-color:#55565c; }
.tip-avatar { width:34px; height:34px; border-radius:50%; border:1px solid #d1d5db; flex-shrink:0;
  display:flex; align-items:center; justify-content:center; font-size:16px; background:#fff; }
.night_mode .tip-avatar { background:#3a3a3d; border-color:#55565c; }
.tip-bubble { background:#2563eb; color:#ffffff; border-radius: 14px; padding: 10px 14px; font-size: 14px; line-height:1.6; }

/* 出典表示(参照元の120選ノートタイプには無い、習熟用だけの追加分)。 */
.source-tag { font-size: 11px; color:#9ca3af; margin-top: 10px; text-align: right; }
.night_mode .source-tag { color:#7c8087; }

.all-audio { display:flex; align-items:center; gap:10px; margin-top: 14px; padding: 8px 12px;
  border-radius: 10px; background:#f5f6f8; font-size: 13px; color:#6b7280; }
.night_mode .all-audio { background:#26262a; color:#b0b3ba; }
.all-audio-label { flex-shrink:0; font-weight:700; }

@media (max-width: 480px) {
  .card { padding: 6px 8px; font-size: 16px; }
  .group-card { padding: 10px; margin: 8px 0; border-radius: 10px; }
  .base-en { font-size: 17px; }
  .para-text { font-size: 15px; }
  .ex-jp { font-size: 13px; }
  .tip-bubble { font-size: 13px; }
}

/* --- 再生ボタンを行の左端に固定（本文の折り返しを壊さない） --- */
.para-item { display: block; position: relative; padding: 8px 12px 8px 48px; }
.para-item .para-arrow { display: none; }
.para-text { display: inline; }
.base-row { position: relative; }
.base-en { display: inline; }
.para-item br, .base-row br { display: none; }
.para-item a, .base-row a { position: absolute; left: 10px; top: 50%;
  transform: translateY(-50%); line-height: 0; }
.para-item a svg, .base-row a svg { width: 28px; height: 28px; }
/* 音声が無い行は左の余白を詰める（:has 未対応環境ではこの2行が無視される） */
.para-item:not(:has(a)) { padding-left: 12px; }
.base-row:has(a) { padding-left: 42px; }
"""


def _example_block(n: int) -> str:
    """例文1件分のテンプレート断片。英文フィールドが空なら和訳ごと省略する
    (参照元の120選ノートタイプと同じ `{{#I1ExnEN}}` 条件分岐)。"""
    return (
        f'{{{{#I1Ex{n}EN}}}}<div class="ex-block">'
        f'<div class="para-item"><span class="para-arrow">&#10148;</span>'
        f'<span class="para-text">{{{{I1Ex{n}EN}}}}</span></div>'
        f'<div class="ex-jp">{{{{I1Ex{n}JP}}}}</div>'
        f'</div>{{{{/I1Ex{n}EN}}}}'
    )


FRONT_TMPL = (
    '<div class="deck-title">{{DeckTitle}} &nbsp;No.{{Num}}</div>'
    '<div class="group-card">'
    '<div class="group-num">{{I1Badge}}</div>'
    '<div class="base-box">'
    '<div class="base-row"><div class="base-en">{{I1PatternEN}}</div></div>'
    '<div class="base-sep"></div>'
    '<div class="base-jp">{{I1PatternJP}}</div>'
    '</div>'
    '<div class="para-label">&#10548; Read it aloud!</div>'
    + "".join(_example_block(n) for n in range(1, MAX_EXAMPLES + 1))
    + '{{#I1Tip}}<div class="tip-box"><div class="tip-avatar">&#128100;</div>'
    '<div class="tip-bubble">{{I1Tip}}</div></div>{{/I1Tip}}'
    '{{#Source}}<div class="source-tag">{{Source}}</div>{{/Source}}'
    '</div>'
    '{{#AllAudio}}<div class="all-audio">'
    '<span class="all-audio-label">&#127911; 通し音声</span>{{AllAudio}}</div>{{/AllAudio}}'
)
BACK_TMPL = "{{FrontSide}}"  # 表裏同一内容(クイズ化しない)

SHUUJUKU_MODEL = genanki.Model(
    MODEL_ID,
    MODEL_NAME,
    fields=[{'name': name} for name in FIELD_NAMES],
    templates=[{'name': 'カード 1', 'qfmt': FRONT_TMPL, 'afmt': BACK_TMPL}],
    css=BASE_CSS,
    sort_field_index=SORT_FIELD_INDEX,
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


def build_fields_dict(item_num, item, deck_title_label="習熟用", example_audio_tags=None):
    """itemを「フィールド確定済みitem」(FIELD_ITEM_KEYSのitem_keyをキーに
    した dict)へ変換する。build_deck()とプレビュー表示の両方から使う。

    example_audio_tags: item['examples']と同じ順序の`[sound:...]`タグ文字列の
    リスト。渡すと対応する英文フィールドの末尾に `<br>` 区切りで追記する
    (フィールド末尾にタグを足すのは、tts_core.generate_tts_for_collection()が
    通常のフィールドに対して行うのと同じ形)。省略時(None)は音声無し。

    docs/lib/shuujuku.js の buildFieldsReadyItem() と**同じ出力**になるよう
    保つこと(tools/verify_web_parity.mjs が突き合わせている)。
    """
    num_str = f"{item_num:03d}"
    values = {
        "deck_title": esc(deck_title_label),
        "num": num_str,
        "badge": num_str,
        "pattern_en": mark_pattern(esc(item["pattern"])),
        "pattern_jp": mark_placeholders(esc(item["meaning"])) if item.get("meaning") else "",
        "tip": esc(item["expl"]) if item.get("expl") else "",
        "source": esc(item["source_label"]) if item.get("source_label") else "",
        # 通し音声(HyperTTS等で後から付ける前提)。このツールからは埋めない。
        "all_audio": "",
    }
    examples = item.get("examples") or []
    for n in range(1, MAX_EXAMPLES + 1):
        i = n - 1
        if i < len(examples):
            ex = examples[i]
            en, jp = ex[0], ex[1]
            hl_words = ex[2] if len(ex) > 2 else None
            en_html = highlight_example_en(en, hl_words)
            tag = example_audio_tags[i] if example_audio_tags and i < len(example_audio_tags) else ""
            values[f"ex{n}_en"] = f"{en_html}<br>{tag}" if tag else en_html
            values[f"ex{n}_jp"] = esc(jp)
        else:
            values[f"ex{n}_en"] = ""
            values[f"ex{n}_jp"] = ""
    return values


def build_guid(item):
    """item['source_key'] は呼び出し側が用意する形式の目安:
    - 直接チャット入力: ('chat', pattern文字列などの一意な値)
    - DailyConversation由来: ('dailyconv', シートのID列の値)

    v2でフィールド構成を変えても**guidの計算方法は変えていない**。
    ここを変えるとAnki側で「既存ノートの更新」ではなく「別ノートの追加」に
    なってしまい、ストックの重複判定・再出力時の上書きが壊れるため。
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
            "source_label": str または None (カード右下の出典表示、任意),
        }

    examples が MAX_EXAMPLES を超える分は捨てられる(v2でフィールド数が
    固定になったため。既存データの最大は4件)。

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
        values = build_fields_dict(idx, item, deck_title_label)
        note = genanki.Note(
            model=SHUUJUKU_MODEL,
            fields=[values[key] for _name, key in FIELD_ITEM_KEYS],
            guid=build_guid(item),
            due=idx,
        )
        deck.add_note(note)
    return deck
