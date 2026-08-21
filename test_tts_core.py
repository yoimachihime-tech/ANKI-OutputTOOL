#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_tts_core.py
----------------
tts_core.py の「読み上げテキストの組み立て」(strip_display_only_markup /
strip_html_for_tts / split_into_sentences)の回帰テスト。

    C:\\Python314\\python.exe test_tts_core.py

【重要】このテストは片桐の実データにもAPIにも一切触れない(純粋関数だけを
呼ぶ)。Text-to-Speech の割り当ても消費しない。

【何を守っているか】
2026-08-21に片桐から「AIに質問タブで生成したカードにTTS音声を付けると、
Ex2の近辺で描画されていない文字の読み上げが入る」と報告を受けての修正。
原因は、カードの見た目のためにフィールドへ焼き込まれている文字が、そのまま
TTSのソーステキストになっていたこと:

  - 例文の採番ラベル `<span class="ex-num">Ex1.</span>`
    (build_grammar_multi_v1_updated.example_en / docs/lib/gemini.js が入れる)
  - Answer 先頭の選択肢記号「(B) 」(Geminiが選択問題の正解に付けてくる)
  - `<br>` を無条件に ". " へ置換していたことによる二重句点「…nothing.. Ex2.」

実測(片桐のコレクション内の生成済みmp3):
  「Ex1. She avoids eating late at night.」(6語+ラベル) … 3.98秒
  「You should avoid driving in the heavy snow.」(8語)   … 2.09秒
語数が少ないほうが倍近く長く、差の約1.9秒がラベルの読み上げだった。

**タグを消すだけでは足りない**点が肝で、`<[^>]+>` の除去では `<span>` は
消えても中身の「Ex1.」は残る。ラベルの除去はタグ除去より前に行うこと。

同じ固定ケースを Web版にも置いてある(tools/test_tts.mjs の [1]/[1b])。
片方だけ直すと読み上げ内容がデスクトップ版とWeb版でずれるので、
どちらかを変えたら必ず両方を更新すること。
"""

import sys

import tts_core

# Windowsの既定コンソール(cp932)では ✅/❌ が出力できずUnicodeEncodeErrorに
# なるため、出力エンコーディングをUTF-8へ固定する。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001  (古い環境・リダイレクト先によっては使えない)
    pass

_results = []


def check(label, condition):
    _results.append(bool(condition))
    print(("  OK  " if condition else "  NG  ") + label)


def eq(label, got, want):
    check(f"{label}", got == want)
    if got != want:
        print(f"        期待: {want!r}")
        print(f"        実際: {got!r}")


def main():
    print("[1] strip_html_for_tts の基本の整形")
    eq("<br>を文の区切りにし、HTMLエンティティをデコードする",
       tts_core.strip_html_for_tts("She said &quot;hi&quot;.<br>Bye."),
       'She said "hi". Bye.')
    eq("</div>も文の区切りにする",
       tts_core.strip_html_for_tts("<div>First.</div><div>Second.</div>"),
       "First. Second.")
    check("直前が「.」で終わる行の後ろに句点を足さない",
          ".." not in tts_core.strip_html_for_tts("Ends with a period.<br>Next line."))
    eq("空白のみの入力は空文字になる", tts_core.strip_html_for_tts("  "), "")

    print()
    print("[2] 表示のためだけの文字を読み上げから外す")
    # 実データ(Grammar Multi の Example、nid 1787278275406)そのままの文字列
    real_example = (
        '<span class="ex-num">Ex1.</span> It was so dark as to see nothing.<br>'
        '<span class="ex-num">Ex2.</span> Hold it gently so as not to break it.<br>'
        "[sound:tts_ai_ask_0_example-abef.mp3]"
    )
    eq("ex-numラベル(Ex1./Ex2.)は読み上げに入らない",
       tts_core.strip_html_for_tts(tts_core.strip_sound_tags(real_example)),
       "It was so dark as to see nothing. Hold it gently so as not to break it.")
    eq("Answer先頭の選択肢記号「(B) 」は読み上げに入らない",
       tts_core.strip_html_for_tts("(B) The music was so loud as to wake up the whole neighborhood."),
       "The music was so loud as to wake up the whole neighborhood.")
    eq("先頭にタグがあっても選択肢記号だけを落とす",
       tts_core.strip_html_for_tts("<b>(A) Correct answer.</b>"),
       "Correct answer.")
    eq("spanで囲まれていない素の見出しラベルも落とす",
       tts_core.strip_html_for_tts("Ex1. First sentence.<br>2. Second sentence."),
       "First sentence. Second sentence.")
    eq("ラベルだけのフィールドは空文字になる(空欄として飛ばせる)",
       tts_core.strip_html_for_tts('<span class="ex-num">Ex1.</span>'),
       "")

    print()
    print("[3] 誤検出の防止")
    eq('"Yes." "No." のような正当な短文は落とさない',
       tts_core.strip_html_for_tts('Yes.<br>No.<br>He said "hi".'),
       'Yes. No. He said "hi".')
    eq("(A)〜(D)以外の丸括弧は残す",
       tts_core.strip_html_for_tts("(I) am here."),
       "(I) am here.")
    eq("文中の ex-num でないspanは中身を残す",
       tts_core.strip_html_for_tts('<span class="highlight">Keep me.</span>'),
       "Keep me.")

    print()
    print("[4] split_into_sentences(文ごと生成・日本語除外オプションの土台)")
    eq("ラベルを除いた文だけを返す",
       tts_core.split_into_sentences(
           '<span class="ex-num">Ex1.</span> One.<br><span class="ex-num">Ex2.</span> Two.'),
       ["One.", "Two."])
    # 2026-07-27はラベルを次の文へ「結合」して極小mp3を防いでいたが、
    # 2026-08-21に「除去」へ変更した(結合だとラベルごと読み上げられるため)。
    eq("ラベル単体は文として切り出されない(ラベルだけの極小mp3を作らない)",
       tts_core.split_into_sentences("Ex1.<br>Ex2."),
       [])

    print()
    print("[5] 日本語除外オプション(設定ダイアログ)との併用")
    mixed = (
        '<span class="ex-num">Ex1.</span> This is English.<br>'
        '<span class="ex-num">Ex2.</span> これは日本語です。<br>'
        '<span class="ex-num">Ex3.</span> Another English one.'
    )
    eq("日本語を含む文だけが落ち、ラベル除去が二重に効いても壊れない",
       tts_core.strip_html_for_tts(tts_core.strip_japanese_sentences(mixed)),
       "This is English. Another English one.")

    print()
    if all(_results):
        print(f"✅ 全テスト成功 ({len(_results)} 件)")
        return 0
    print(f"❌ {_results.count(False)} 件失敗 ({len(_results)} 件中)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
