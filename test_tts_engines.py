#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_tts_engines.py
-------------------
2026-10-05に追加した「TTSの音声エンジン(Cloud TTS / Gemini TTS)」まわりの
回帰テスト。

    C:\\Python314\\python.exe test_tts_engines.py

【重要】APIは一切呼ばない(Gemini / Cloud TTS の呼び出しは差し替える)。
config.json も触らない(tts_core.CONFIG_PATH を最初に一時フォルダへ差し替える)。

【何を守っているか】
- "gemini:<モデル>:<音声>" の音声名が Gemini TTS に振り分けられ、Gemini の
  キーが使われること(local_tts_server.py / tts_gui.py はこれに依存している)
- Gemini TTS の音量ゲインはローカルで掛け、上げすぎは音割れ手前で止めること
- Cloud TTS の言語コードは音声名の先頭(en-GB-…)を優先すること
- config.json の保存がアトミックで、壊れていても黙って空にしないこと
- 音声一覧から「言語コードの無い名前」(APIキーでは使えない)を除くこと
"""

import array
import base64
import io
import json
import os
import sys
import tempfile
import wave

import tts_core

# --- 何よりも先に、実データ(config.json)から切り離す -----------------------
_TMP = tempfile.mkdtemp(prefix="tts_engines_test_")
tts_core.CONFIG_PATH = os.path.join(_TMP, "config.json")

import gemini_client  # noqa: E402
import local_tts_server  # noqa: E402

_results = []


def check(label, ok, detail=""):
    _results.append(bool(ok))
    print(("  ✅ " if ok else "  ❌ ") + label + ("" if ok else f"  ({detail})"))


def make_wav(samples, rate=24000):
    """-1.0〜+1.0 のサンプル列から 16bit モノラル WAV を作る。"""
    pcm = array.array("h", (int(round(v * 32767)) for v in samples))
    if sys.byteorder == "big":
        pcm.byteswap()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def main():
    print("[1] Gemini TTS の音声名")
    v = tts_core.make_gemini_voice("gemini-3.8-flash-tts", "Kore")
    check("gemini:<モデル>:<音声> を作って読み戻せる",
          tts_core.parse_gemini_voice(v) == ("gemini-3.8-flash-tts", "Kore"), v)
    check("Cloud の音声名は Gemini 扱いしない",
          tts_core.parse_gemini_voice("en-US-Chirp3-HD-Kore") is None)
    cfg = {"api_key": "cloud-key", "gemini_api_key": "gemini-key"}
    check("Gemini の音声には Gemini のキーを使う",
          tts_core.tts_api_key_for_voice(v, cfg) == "gemini-key")
    check("Cloud の音声には Cloud TTS のキーを使う",
          tts_core.tts_api_key_for_voice("en-US-Chirp3-HD-Kore", cfg) == "cloud-key")
    choices = tts_core.voice_choices(["Kore", "en-US-Chirp3-HD-Kore", "en-US-Neural2-A"])
    check("一覧から言語コードの無い名前(Cloud経由のGemini用。APIキーでは使えない)を除き、"
          "Gemini 3.8 の音声(2モデル×30)を足す",
          choices[:2] == ["en-US-Chirp3-HD-Kore", "en-US-Neural2-A"]
          and len(choices) == 2 + 60 and "Kore" not in choices, choices[:4])

    print()
    print("[2] 音量ゲイン(Gemini TTS はローカルで掛ける)")
    wav = make_wav([0.1, -0.2, 0.05])
    gained = tts_core.apply_gain_to_wav(wav, 6.0)
    peak = tts_core.compute_peak_amplitude(gained)
    check("+6dB で振幅が約2倍になる", abs(peak - 0.2 * 10 ** (6 / 20)) < 0.002, peak)
    loud = tts_core.apply_gain_to_wav(make_wav([0.5, -0.5]), 16.0)
    peak = tts_core.compute_peak_amplitude(loud)
    check("上げすぎて音割れする分は手前で止める", 0.9 < peak < tts_core.CLIPPING_THRESHOLD, peak)
    check("0dB なら何もしない", tts_core.apply_gain_to_wav(wav, 0.0) is wav)

    print()
    print("[3] 合成の振り分け(APIは呼ばない)")
    calls = []

    def fake_speech(text, api_key, model, voice_name, style="", timeout=120):
        calls.append((text, api_key, model, voice_name, style))
        return make_wav([0.25, -0.25, 0.1])

    orig_speech = gemini_client.generate_speech_wav
    gemini_client.generate_speech_wav = fake_speech
    tts_core.GEMINI_TTS_STYLE = "calm"
    try:
        out = tts_core.call_google_tts_wav("Hello.", v, "en-US", "gemini-key", volume_gain_db=6.0)
        check("Gemini の音声は Gemini TTS で合成する(モデル・音声・キー・読み方の指示)",
              calls[-1] == ("Hello.", "gemini-key", "gemini-3.8-flash-tts", "Kore", "calm"), calls[-1:])
        check("音量ゲインが掛かった WAV が返る",
              abs(tts_core.compute_peak_amplitude(out) - 0.25 * 10 ** (6 / 20)) < 0.003)
        if tts_core.LAMEENC_AVAILABLE:
            mp3 = tts_core.call_google_tts("Hello.", v, "en-US", "gemini-key")
            check(".apkg 用(call_google_tts)は MP3 に変換して返す",
                  mp3[:3] == b"ID3" or (mp3[0] == 0xFF and mp3[1] & 0xE0 == 0xE0), mp3[:4])
        else:
            print("  (lameenc が無い環境のため MP3 変換の確認は省略)")

        def boom(*a, **k):
            raise gemini_client.GeminiClientError("上限に達しました")

        gemini_client.generate_speech_wav = boom
        try:
            tts_core.call_google_tts_wav("Hi.", v, "en-US", "k")
            check("Gemini のエラーを TtsApiError にそろえる", False, "例外にならなかった")
        except tts_core.TtsApiError as e:
            check("Gemini のエラーを TtsApiError にそろえる(呼び出し側の扱いを変えずに済む)",
                  "上限" in str(e), e)
    finally:
        gemini_client.generate_speech_wav = orig_speech
        tts_core.GEMINI_TTS_STYLE = ""

    sent = []
    orig_api = tts_core._call_tts_api
    tts_core._call_tts_api = lambda body, key: sent.append(body) or b"mp3"
    try:
        tts_core.call_google_tts("Hi.", "en-GB-Chirp3-HD-Kore", "en-US", "k")
        check("Cloud の言語コードは音声名の先頭(en-GB)を優先する(食い違いで400になっていた)",
              sent[-1]["voice"]["languageCode"] == "en-GB", sent[-1]["voice"])
        tts_core.call_google_tts("Hi.", "custom-voice", "en-US", "k")
        check("音声名に言語が無ければ指定の言語コードを使う",
              sent[-1]["voice"]["languageCode"] == "en-US")
    finally:
        tts_core._call_tts_api = orig_api

    print()
    print("[4] gemini_client.generate_speech_wav のリクエストと応答")
    seen = []
    orig_post = gemini_client._post_gemini_request

    def fake_post(url, body, api_key, timeout, max_retries=2):
        seen.append((url, body, max_retries))
        pcm = array.array("h", [1000, -1000, 500])
        return {"candidates": [{"content": {"parts": [{"inlineData": {
            "mimeType": "audio/L16;codec=pcm;rate=24000",
            "data": base64.b64encode(pcm.tobytes()).decode()}}]}}]}

    gemini_client._post_gemini_request = fake_post
    try:
        out = gemini_client.generate_speech_wav("Hi.", "k", "gemini-3.8-flash-tts", "Puck", style="calm")
        url, body, retries = seen[-1]
        part = body["contents"][0]["parts"][0]
        check("generateContent に音声(Puck)と読み方の指示を送る",
              url.endswith("/gemini-3.8-flash-tts:generateContent")
              and body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Puck"
              and part.get("speechMetadata") == {"style": "calm"}, body)
        check("TTS はテキスト生成より多めにリトライする(1フィールド=1回でレート制限に当たりやすい)",
              retries == 4, retries)
        with wave.open(io.BytesIO(out), "rb") as w:
            check("ヘッダー無しの PCM を 24kHz の WAV に包み直す",
                  w.getframerate() == 24000 and w.getnframes() == 3)
        gemini_client.generate_speech_wav("Hi.", "k", "gemini-2.5-pro-preview-tts", "Puck", style="calm")
        check("読み方の指示は 3.8 より古いモデルには送らない(400を避ける)",
              "speechMetadata" not in seen[-1][1]["contents"][0]["parts"][0])
    finally:
        gemini_client._post_gemini_request = orig_post

    print()
    print("[5] config.json の読み書き(一時フォルダで)")
    tts_core.save_config({"api_key": "x", "voice": v})
    check("保存した設定を読み戻せる", tts_core.load_config() == {"api_key": "x", "voice": v})
    leftovers = [f for f in os.listdir(_TMP) if f.endswith(".tmp")]
    check("一時ファイルを残さない(アトミックに置き換える)", not leftovers, leftovers)
    with open(tts_core.CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write('{"api_key": "x", "voi')   # 書き込み途中で落ちたような壊れ方
    check("壊れた config.json は {} として読む", tts_core.load_config() == {})
    check("壊れた中身は config.json.corrupt に退避して残す(APIキーを手で救出できる)",
          os.path.exists(tts_core.CONFIG_PATH + ".corrupt"))

    print()
    print("[6] ローカルのTTSツール(local_tts_server)")
    check("Gemini の音声でキーが無いと Gemini 用の案内を出す",
          "gemini_api_key" in local_tts_server._missing_key_message({"api_key": "", "voice": v}))
    check("Cloud の音声でキーが無いと Cloud 用の案内を出す",
          "api_key" in local_tts_server._missing_key_message({"api_key": "", "voice": "en-US-Chirp3-HD-Kore"}))
    check("キーがあれば何も言わない",
          local_tts_server._missing_key_message({"api_key": "k", "voice": v}) == "")
    texts = []
    orig_wav = tts_core.call_google_tts_wav
    tts_core.call_google_tts_wav = lambda text, *a, **k: texts.append(text) or make_wav([0.1] * 240)
    try:
        out = local_tts_server.synthesize_test_wav(
            {"voice": v, "language_code": "en-US", "api_key": "k", "volume_gain_db": 0,
             "sentence_gap": 0.5, "gemini_style": "slow"}, "")
        check("テスト再生の文が空なら固定のサンプル文2つを読む",
              texts == list(tts_core.TEST_SAMPLE_SENTENCES), texts)
        check("文と文の間に設定どおりの無音を挟む(0.5秒)",
              abs(tts_core.wav_duration_seconds(out) - (0.01 * 2 + 0.5)) < 0.01,
              tts_core.wav_duration_seconds(out))
        check("読み方の指示が合成に渡る", tts_core.GEMINI_TTS_STYLE == "slow")
        texts.clear()
        local_tts_server.synthesize_test_wav(
            {"voice": v, "language_code": "en-US", "api_key": "k"},
            "One. Two. Three. Four. Five. Six. Seven.")
        check("長い文章を貼られても5文までしか読まない(呼び出しすぎない)", len(texts) == 5, texts)
    finally:
        tts_core.call_google_tts_wav = orig_wav
        tts_core.GEMINI_TTS_STYLE = ""

    print()
    if all(_results):
        print(f"✅ 全テスト成功 ({len(_results)} 件)")
        return 0
    print(f"❌ {_results.count(False)} 件失敗 ({len(_results)} 件中)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
