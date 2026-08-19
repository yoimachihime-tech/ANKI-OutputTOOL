# -*- coding: utf-8 -*-
"""ローカルサーバー方式が成立するかを確かめるためだけの、使い捨ての疎通確認サーバー。

目的:
  GitHub Pages(https://yoimachihime-tech.github.io)で動いているWeb版から、
  同じPC上で動いているこのツール(http://127.0.0.1:8765)を fetch() で呼べるか
  だけを確かめる。ここが通らなければ「PC版をWeb版のバックエンドにする」という
  設計自体が成立しないため、実装より先にこれだけを確認する。

  確認したいのは次の3点:
    1. HTTPSのページから http://127.0.0.1 を呼んでも混在コンテンツで
       ブロックされないこと(localhostは「安全なオリジン」扱いのはず)
    2. CORS(Access-Control-Allow-Origin)が正しく効くこと
    3. Chromeのローカルネットワークアクセス制限(プリフライトや許可プロンプト)に
       引っかからないこと。引っかかる場合、ブラウザは本リクエストを送る前に
       OPTIONSで Access-Control-Request-Private-Network: true を聞いてくる

使い方:
    python tools/localhost_cors_check.py
  そのうえでWeb版のページ( https://yoimachihime-tech.github.io/ANKI-OutputTOOL/ )を
  開き、ブラウザの開発者ツールのコンソールで次を実行する:

    fetch('http://127.0.0.1:8765/ping').then(r => r.json()).then(console.log).catch(console.error)

  コンソールに {ok: true, ...} が出れば成立。エラーになった場合は、この
  サーバー側のログに OPTIONS が記録されているかどうかで原因を切り分ける
  (OPTIONSすら来ていなければブラウザが送信前に握り潰している)。

注意:
  - 待ち受けは 127.0.0.1 のみ(他のPC・スマホからは到達できない。これは仕様)。
  - 確認が済んだらこのファイルは役目を終える。実装には使わない。
"""

import http.server
import json
import sys

PORT = 8765

# 許可するオリジン。ここに無いオリジンにはCORSヘッダーを返さない。
ALLOWED_ORIGINS = {
    "https://yoimachihime-tech.github.io",
    "http://localhost:8000",  # 手元で docs/ を配信して試す場合用
    "http://127.0.0.1:8000",
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _log_request_headers(self, method: str) -> None:
        origin = self.headers.get("Origin", "(なし)")
        print(f"\n>>> {method} {self.path}  Origin: {origin}")
        # プリフライトで何を聞かれているかをそのまま出す。
        # (Workerで Authorization を許可し忘れて2週間気づかなかった事例があるため、
        #  「ブラウザが何を要求したか」を必ず目視できるようにしておく)
        for name in (
            "Access-Control-Request-Method",
            "Access-Control-Request-Headers",
            "Access-Control-Request-Private-Network",
        ):
            value = self.headers.get(name)
            if value:
                print(f"    {name}: {value}")

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            self.send_header("Access-Control-Max-Age", "600")
            # Chromeのローカルネットワークアクセス制限への応答。
            # 要求されていなくても返しておく(害は無い)。
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Allow-Local-Network-Access", "true")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._log_request_headers("OPTIONS")
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._log_request_headers("GET")
        if self.path.split("?")[0] == "/":
            # 「ローカルツール自身がUIを配信する」案の検証用ページ。
            page = ("<!doctype html><meta charset=utf-8><title>waiting</title>"
                    "<h1>local page</h1><script>"
                    "fetch('/ping').then(r=>r.json()).then(j=>{document.title='LOCAL_OK:'+j.ok})"
                    ".catch(e=>{document.title='LOCAL_NG:'+e});"
                    "</script>").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)
            return

        if self.path.split("?")[0] != "/ping":
            self.send_response(404)
            self._cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        body = json.dumps(
            {"ok": True, "tool": "anki-tts-local", "check": "localhost-cors"},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        print("    -> 200 を返した(ブラウザ側のコンソールに {ok: true} が出れば成立)")

    def log_message(self, fmt, *args):  # 既定の1行ログは自前の出力と重複するので黙らせる
        pass


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"127.0.0.1:{PORT} で待ち受け中(Ctrl+C で終了)")
    print("ブラウザで https://yoimachihime-tech.github.io/ANKI-OutputTOOL/ を開き、")
    print("開発者ツールのコンソールで次を実行してください:")
    print(f"\n  fetch('http://127.0.0.1:{PORT}/ping').then(r => r.json()).then(console.log).catch(console.error)\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
