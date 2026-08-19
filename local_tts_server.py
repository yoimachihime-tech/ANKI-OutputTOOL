# -*- coding: utf-8 -*-
"""apkgを読み込んでTTS音声を付ける、それだけを行うローカルツール。

■ このファイルの位置づけ
    PC版(tts_gui.py)の機能のうち「既存のapkgにTTS音声を付ける」だけを取り出し、
    画面をブラウザに移したもの。処理の実体は従来どおり tts_core.py が行う
    (このファイルにTTSのロジックを書かないこと。tts_gui.py と同じ約束)。

■ なぜブラウザから使うのに、画面もこのツールが配信するのか
    GitHub Pages(https://yoimachihime-tech.github.io)のページから
    http://127.0.0.1 を fetch する構成は、Chrome 151 の
    Local Network Access 権限に阻まれる(実測で LocalNetworkAccessPermissionDenied。
    プログラムからの権限付与も効かなかった)。ページ自体をこのツールが配信すれば
    同一オリジンになり、この制限の対象外になる(実測で確認済み)。
    そのためWeb版からは「リンクでこのページへ遷移する」形で繋ぐ
    (トップレベル遷移は制限を受けないことを確認済み)。

■ 使い方
    「apkgにTTS音声を付ける.bat」をダブルクリック
    → コンソールは出ず、ブラウザで http://127.0.0.1:8765/ が開く
    → 終了は画面の「ツールを終了する」ボタンから
    (コンソールを見ながら動かしたい場合は python local_tts_server.py)

■ 待ち受けは 127.0.0.1 のみ。他のPC・スマホからは到達できない(仕様)。
"""

import http.server
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser

import tts_core

PORT = 8765
ALLOWED_ORIGINS = {"http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT}
OUTPUT_DIR = os.path.join(tts_core.BASE_DIR, "output")
WORK_DIR = os.path.join(tts_core.BASE_DIR, "pending_decks")


# ---------------------------------------------------------------------------
# 状態(単一利用者を前提とした、プロセス内の1セットだけ)
# ---------------------------------------------------------------------------
class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.col = None
        self.source_name = ""      # 読み込んだapkgのファイル名
        self.job = None            # 実行中/直近のジョブ(dict)
        self.cancel = False


STATE = State()


def _reset_job():
    return {
        "running": False, "done": 0, "total": 0, "log": [],
        "finished": False, "error": "", "output_path": "", "cancelled": False,
        "interrupted": False,
    }


def _log(msg):
    job = STATE.job
    if job is not None:
        job["log"].append(msg)
        del job["log"][:-400]   # 際限なく溜めない
    print(msg)


# ---------------------------------------------------------------------------
# apkgの読み込みとフィールドの下調べ
# ---------------------------------------------------------------------------
def _prepare_work_col_path():
    """作業用コレクションのパスを用意する。

    2回目以降の読み込みでは、前回のCollectionが作業ファイルを開いたままだと
    Windowsでは削除できず `WinError 32` になる(実際に踏んだ)。まず前回の
    コレクションを閉じ、それでも消せない場合は別名にして先へ進める。
    """
    with STATE.lock:
        old = STATE.col
        STATE.col = None
    if old is not None:
        try:
            old.close()
        except Exception:  # noqa: BLE001
            pass

    path = os.path.join(WORK_DIR, "_local_tts_work.anki2")
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            path = os.path.join(WORK_DIR, "_local_tts_work_%d.anki2" % int(time.time()))
    return path


def open_apkg(apkg_bytes, filename):
    """apkgを読み込み、ノートタイプとフィールドの一覧(サンプル付き)を返す。

    フィールドごとに「中身のある件数」「既に音声がある件数」「サンプル文字列」を
    返すのは、どのフィールドがTTS対象になりうるかを画面上で判断できるようにするため
    (例: 先頭フィールドがデッキ名だった場合、選ばずに済む)。
    """
    os.makedirs(WORK_DIR, exist_ok=True)
    tmp_apkg = os.path.join(WORK_DIR, "_local_tts_input.apkg")
    with open(tmp_apkg, "wb") as f:
        f.write(apkg_bytes)

    col = tts_core.load_collection(tmp_apkg, _prepare_work_col_path())

    notetypes = []
    for nt in col.models.all():
        name = nt["name"]
        note_ids = col.find_notes('note:"%s"' % name)
        if not note_ids:
            # apkgには使われていない標準ノートタイプ(Basic等)も入ってくるので除く
            continue

        field_names = [f["name"] for f in nt["flds"]]
        count = len(field_names)
        nonempty = [0] * count
        samples = [""] * count
        has_audio = [0] * count

        for nid in note_ids:
            note = col.get_note(nid)
            for i, raw in enumerate(note.fields):
                if i >= count:
                    break
                if tts_core.SOUND_TAG_RE.search(raw):
                    has_audio[i] += 1
                text = tts_core.strip_html_for_tts(tts_core.strip_sound_tags(raw)).strip()
                if text:
                    nonempty[i] += 1
                    if not samples[i]:
                        samples[i] = text[:60]

        notetypes.append({
            "name": name,
            "note_count": len(note_ids),
            "fields": [
                {"index": i, "name": field_names[i], "nonempty": nonempty[i],
                 "has_audio": has_audio[i], "sample": samples[i]}
                for i in range(count)
            ],
        })

    notetypes.sort(key=lambda x: -x["note_count"])
    with STATE.lock:
        STATE.col = col
        STATE.source_name = filename or "deck.apkg"
    return {"filename": STATE.source_name, "notetypes": notetypes}


def _source_transform_for(options):
    """TTSに渡す前のテキスト変換。tts_gui._get_source_transform_for と同じ考え方。"""
    if options.get("exclude_japanese"):
        return tts_core.strip_japanese_sentences
    return None


def _tts_text(raw_field, transform):
    """TTSに実際に渡すテキストを作る(文字数の見積もり・文数の判定用)。

    `tts_core.analyze_targets` の中でやっている手順と同じにしてあるので、
    向こうを変えたらここも合わせること。
    """
    src = tts_core.strip_sound_tags(raw_field)
    if transform:
        src = transform(src)
    return tts_core.strip_html_for_tts(src)


def _build_plan(col, targets, options):
    """処理対象の一覧を組み立てる(ドライランと本番で同じものを使う)。

    `redo_multi_audio` は「音声が2つ以上入ってしまったフィールドだけ作り直す」
    モード。「文ごとにタグを分ける」がONだと複数文のフィールドに音声が
    複数付き、Anki上で再生ボタンが2つ並ぶ。これを直すのに全件を
    force_regen すると、大半を占める1文だけのフィールドまで作り直して
    無駄に時間と割り当てを使うため、該当分だけを選べるようにしてある。
    """
    transform = _source_transform_for(options)
    redo_multi = bool(options.get("redo_multi_audio"))
    force = True if redo_multi else bool(options.get("force_regen"))
    per_sentence = bool(options.get("per_sentence_tags"))

    rows = []
    for t in targets:
        name = t["notetype"]
        fields = [int(i) for i in t.get("fields", [])]
        if not fields:
            continue

        to_process, skip_audio, skip_empty, chars = tts_core.analyze_targets(
            col, name, fields, force, source_transform=transform
        )

        if redo_multi:
            kept = []
            chars = 0
            for nid, field_idx in to_process:
                raw = col.get_note(nid).fields[field_idx]
                if len(tts_core.SOUND_TAG_RE.findall(raw)) < 2:
                    continue
                kept.append((nid, field_idx))
                chars += len(_tts_text(raw, transform))
            to_process = kept
            skip_audio = 0   # このモードでは「音声済みで飛ばす」の意味が変わるため出さない

        # 「文ごとにタグを分ける」がONのとき、再生ボタンが2つ以上になる件数を予告する
        multi_sentence = 0
        if per_sentence:
            for nid, field_idx in to_process:
                text = _tts_text(col.get_note(nid).fields[field_idx], transform)
                if len([s for s in tts_core.split_into_sentences(text) if s.strip()]) > 1:
                    multi_sentence += 1

        rows.append({"notetype": name, "items": len(to_process), "chars": chars,
                     "skip_audio": skip_audio, "skip_empty": skip_empty,
                     "multi_sentence": multi_sentence, "_to_process": to_process})
    return rows, force


def analyze(targets, options):
    """ドライラン。実際には何も生成せず、対象件数と文字数だけを数える。"""
    col = STATE.col
    if col is None:
        raise RuntimeError("apkgが読み込まれていません。")

    rows, _ = _build_plan(col, targets, options)
    totals = {"total_items": 0, "total_chars": 0, "total_skip_audio": 0,
              "total_skip_empty": 0, "total_multi_sentence": 0}
    for r in rows:
        totals["total_items"] += r["items"]
        totals["total_chars"] += r["chars"]
        totals["total_skip_audio"] += r["skip_audio"]
        totals["total_skip_empty"] += r["skip_empty"]
        totals["total_multi_sentence"] += r["multi_sentence"]

    # _to_process は内部用なので画面へは返さない
    public = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    return dict(totals, rows=public)


# ---------------------------------------------------------------------------
# 生成(バックグラウンドスレッド)
# ---------------------------------------------------------------------------
def _run_generate(targets, options, settings):
    """TTSを生成する。

    **途中で止まっても、そこまでの分は必ず書き出す**(2026-08-19)。
    無料枠を使い切った・割り当てに達した場合、tts_core は待っても回復しない
    種類のエラーをリトライせず即座に投げる。以前はその例外で書き出しごと
    飛ばしていたため、何百件生成した分がまるごと失われ、次回また同じ料金を
    払い直すことになっていた。生成済みのノートは既に col 側へ書き込まれて
    いるので、書き出しさえすれば無駄にならない。

    再開もそのまま効く: `[sound:...]` が入ったフィールドは analyze_targets が
    「音声済み」として飛ばすため、同じ画面でもう一度実行すれば続きから進む
    (書き出したapkgを読み込み直した場合も同じ)。
    """
    job = STATE.job
    col = STATE.col
    error = ""
    try:
        transform = _source_transform_for(options)

        # 先に全ノートタイプ分の対象を数えてから走る(進捗の分母を最初に確定させるため)。
        # ドライランと同じ _build_plan を使うので、「件数を数える」で見た数と
        # 実際に処理される数が食い違うことはない。
        rows, force = _build_plan(col, targets, options)
        plan = [(r["notetype"], r["_to_process"]) for r in rows]
        total = sum(len(p[1]) for p in plan)

        job["total"] = total
        if total == 0:
            # 「0件」だけだと原因が分からない。実際に踏んだのは
            # 「apkgを作り直して同じ名前で上書きしたが、ブラウザが同じパスの
            #  選び直しでchangeを発火せず、前回の生成済みコレクションが
            #  残っていた」というケースだったので、その線を最初に案内する。
            skipped = sum(r["skip_audio"] for r in rows)
            hint = "フィールドの選択を確認してください。"
            if skipped:
                hint = ("選んだフィールドのうち %d 件は既に音声が入っているため飛ばしました。\n"
                        "・apkgを作り直した場合: ①でファイルを選び直してください"
                        "(読み込めていれば「既に音声があるフィールド」が0件になります)。\n"
                        "・音声を作り直したい場合: ③の「既存の音声を作り直す」をONにしてください。"
                        % skipped)
            raise RuntimeError("対象が0件です。" + hint)
        _log("合計 %d 件のフィールドにTTSを生成します。" % total)

        base_done = 0
        for name, to_process in plan:
            if STATE.cancel:
                break
            if not to_process:
                continue
            _log("--- %s: %d 件 ---" % (name, len(to_process)))

            def on_progress(done, _total, _base=base_done):
                job["done"] = _base + done

            result = tts_core.generate_tts_for_collection(
                col, name, to_process,
                api_key=settings["api_key"],
                voice=settings["voice"],
                lang=settings["language_code"],
                gap_seconds=float(settings["sentence_gap"]),
                bitrate=int(settings["mp3_bitrate"]),
                per_sentence=bool(settings["per_sentence_tags"]),
                force_regen=force,
                volume_gain_db=float(settings["volume_gain_db"]),
                source_transform=transform,
                log=_log,
                on_progress=on_progress,
                should_cancel=lambda: STATE.cancel,
            )
            base_done += result.processed
            job["done"] = base_done
            if result.cancelled:
                job["cancelled"] = True
                break
    except Exception as e:  # noqa: BLE001
        error = str(e)
        job["interrupted"] = True
        _log("中断しました: " + error)
        traceback.print_exc()

    # 成功・キャンセル・エラーのいずれでも、生成できた分は必ず書き出す。
    # (PC版が「キャンセル時も途中状態を保持する」設計なのと同じ考え方を、
    #  エラーで止まった場合にも広げたもの)
    try:
        if job["done"] > 0:
            os.makedirs(OUTPUT_DIR, exist_ok=True)
            stem = os.path.splitext(os.path.basename(STATE.source_name))[0]
            out_path = os.path.join(OUTPUT_DIR, "%s_TTS.apkg" % stem)
            _log("書き出し中: %s" % out_path)
            tts_core.export_collection(col, out_path)
            job["output_path"] = out_path
            _log("完了しました。" if not error else
                 "ここまでの %d 件を書き出しました。" % job["done"])
    except Exception as e:  # noqa: BLE001
        # 書き出しにも失敗した場合、生成側のエラーを消さずに併記する
        # (原因の切り分けができなくなるため)
        extra = "書き出しにも失敗しました: %s" % e
        error = (error + "\n" + extra) if error else extra
        _log(extra)
        traceback.print_exc()

    job["error"] = error
    job["running"] = False
    job["finished"] = True


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AnkiLocalTTS/1.0"

    def log_message(self, fmt, *args):
        pass

    # -- 補助 ---------------------------------------------------------------
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, BrokenPipeError):
            pass

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        buf = b""
        while len(buf) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(buf)))
            if not chunk:
                break
            buf += chunk
        return buf

    # -- ルーティング -------------------------------------------------------
    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/":
            self._send(200, PAGE_HTML.encode("utf-8"), "text/html; charset=utf-8")
        elif path == "/api/settings":
            cfg = tts_core.load_config()
            self._json({
                "voice": cfg.get("voice", "en-US-Chirp3-HD-Iapetus"),
                "language_code": cfg.get("language_code", "en-US"),
                "sentence_gap": cfg.get("sentence_gap", 0.5),
                "mp3_bitrate": cfg.get("mp3_bitrate", 64),
                "per_sentence_tags": cfg.get("per_sentence_tags", False),
                "volume_gain_db": cfg.get("volume_gain_db", 0.0),
                "exclude_japanese": cfg.get("exclude_japanese_sentences", False),
                "force_regen": False,
                "has_api_key": bool(cfg.get("api_key")),
            })
        elif path == "/api/progress":
            self._json(STATE.job or _reset_job())
        elif path == "/api/download":
            job = STATE.job or {}
            out = job.get("output_path")
            if not out or not os.path.exists(out):
                self._json({"error": "生成された.apkgがありません。"}, 404)
                return
            with open(out, "rb") as f:
                data = f.read()
            name = urllib.parse.quote(os.path.basename(out))
            self._send(200, data, "application/octet-stream",
                       {"Content-Disposition": "attachment; filename*=UTF-8''%s" % name})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        if not self._origin_ok():
            self._json({"error": "許可されていないオリジンです。"}, 403)
            return
        path = self.path.split("?")[0]
        body = self._read_body()
        try:
            if path == "/api/open":
                filename = urllib.parse.unquote(self.headers.get("X-Filename", ""))
                self._json(open_apkg(body, filename))
                return

            payload = json.loads(body.decode("utf-8")) if body else {}

            if path == "/api/analyze":
                self._json(analyze(payload.get("targets", []), payload.get("options", {})))
            elif path == "/api/generate":
                if STATE.job and STATE.job.get("running"):
                    self._json({"error": "すでに生成中です。"}, 409)
                    return
                if STATE.col is None:
                    self._json({"error": "apkgが読み込まれていません。"}, 400)
                    return
                settings = self._merged_settings(payload.get("settings", {}))
                if not settings["api_key"]:
                    self._json({"error": "Cloud Text-to-Speech のAPIキーが未設定です。"
                                         "config.json の api_key を確認してください。"}, 400)
                    return
                STATE.cancel = False
                STATE.job = _reset_job()
                STATE.job["running"] = True
                threading.Thread(
                    target=_run_generate,
                    args=(payload.get("targets", []), payload.get("options", {}), settings),
                    daemon=True,
                ).start()
                self._json({"ok": True})
            elif path == "/api/cancel":
                STATE.cancel = True
                self._json({"ok": True})
            elif path == "/api/shutdown":
                # コンソールを出さずに起動する(pythonw)ため、画面から終了できる
                # 手段が要る。応答を返し切ってから別スレッドで止める
                # (serve_forever を回しているスレッドから shutdown() を呼ぶと
                #  自分自身を待って固まるため)。
                self._json({"ok": True})
                if SERVER is not None:
                    threading.Thread(target=SERVER.shutdown, daemon=True).start()
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def _merged_settings(self, incoming):
        """画面で変更した値を config.json の値に重ねる(APIキーは常にconfigのもの)。

        APIキーだけは画面から送らせない。ブラウザ側に持ち出す必要が無く、
        持ち出さなければ漏れようが無いため。
        """
        cfg = tts_core.load_config()
        return {
            "api_key": cfg.get("api_key", ""),
            "voice": incoming.get("voice") or cfg.get("voice", "en-US-Chirp3-HD-Iapetus"),
            "language_code": incoming.get("language_code") or cfg.get("language_code", "en-US"),
            "sentence_gap": incoming.get("sentence_gap", cfg.get("sentence_gap", 0.5)),
            "mp3_bitrate": incoming.get("mp3_bitrate", cfg.get("mp3_bitrate", 64)),
            "per_sentence_tags": incoming.get("per_sentence_tags",
                                              cfg.get("per_sentence_tags", False)),
            "volume_gain_db": incoming.get("volume_gain_db", cfg.get("volume_gain_db", 0.0)),
        }


PAGE_HTML = ""  # main() で local_tts_page.html を読み込んで差し替える
SERVER = None   # /api/shutdown から止めるための参照


def _already_running():
    """同じポートで既にこのツールが動いているか。"""
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=1):
            return True
    except OSError:
        return False


def main():
    global PAGE_HTML, SERVER

    # pythonw.exe で起動すると sys.stdout / sys.stderr が None になり、
    # print() が AttributeError で落ちる(_log が print を使っている)。
    # コンソール(黒い画面)を出さずに常駐させるための対応。
    if sys.stdout is None or sys.stderr is None:
        log_file = open(os.path.join(tts_core.BASE_DIR, "local_tts_server.log"),
                        "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log_file

    url = "http://127.0.0.1:%d/" % PORT

    # 二重起動しても「ポートが使用中」で失敗させない。既に動いているものを
    # 使えばよいので、画面だけ開いて終わる(バッチを何度押しても安全にする)。
    if _already_running():
        print("既に起動しています。画面だけ開きます: " + url)
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return 0

    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "local_tts_page.html"), "r", encoding="utf-8") as f:
        PAGE_HTML = f.read()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    SERVER = server
    print("=" * 62)
    print("  ANKI出力ツール — apkgにTTS音声を付ける(ローカル)")
    print("=" * 62)
    print("  ブラウザで開いてください:  " + url)
    print("  終了するには、画面右下の「ツールを終了する」を押すか Ctrl+C")
    print()

    if "--no-browser" not in sys.argv:
        # 既に待ち受けは始まっている(bindはコンストラクタで完了している)ので、
        # serve_forever より前に開いても取りこぼさない。
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
