# -*- coding: utf-8 -*-
"""Web版のページから、PC上のローカルTTSツールを起動できるようにする(1回だけ実行)。

■ なぜこれが必要か
    Webページから直接プログラムを起動する手段はブラウザに存在しない
    (存在したら、どのサイトも勝手にPCのプログラムを実行できてしまう)。
    唯一の正規の方法が「カスタムURLスキーム」で、Zoomの `zoommtg:` や
    Slackの `slack:` と同じ仕組み。あらかじめ「`ankitts:` で始まるURLを
    開いたら、このプログラムを起動する」とWindows側に登録しておくと、
    ページ上の `<a href="ankitts://start">` を押したときに起動できる。

■ 何をするか
    HKEY_CURRENT_USER\\Software\\Classes\\ankitts に登録するだけ
    (管理者権限は不要。PC全体ではなく、このユーザーにだけ効く)。

■ 使い方
    登録:   python tools\\register_local_tts_protocol.py
    取り消し: python tools\\register_local_tts_protocol.py --unregister

■ 注意
    ブラウザは初回に「このサイトは ankitts を開こうとしています」という
    確認を出す(「常に許可する」にチェックを入れれば次回から出ない)。
    これはブラウザ側の安全機構なので、こちらからは消せない。
"""

import os
import sys
import winreg

SCHEME = "ankitts"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_PY = os.path.join(BASE_DIR, "local_tts_server.py")

# コンソール(黒い画面)を出さずに起動したいので pythonw を使う。
# バッチと同じ実行ファイルを指定しておくこと。
PYTHONW = r"C:\Python314\pythonw.exe"


def register():
    if not os.path.exists(SERVER_PY):
        raise SystemExit("local_tts_server.py が見つかりません: " + SERVER_PY)
    if not os.path.exists(PYTHONW):
        raise SystemExit("pythonw.exe が見つかりません: " + PYTHONW)

    # %1 には "ankitts://start" が渡ってくる。local_tts_server.py は
    # 知らない引数を無視するので、そのまま渡してよい。
    command = '"%s" "%s" "%%1"' % (PYTHONW, SERVER_PY)

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                          r"Software\Classes\%s" % SCHEME) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ,
                          "URL:ANKI TTS Tool")
        # この値があることで「URLスキームである」とWindowsが認識する(中身は空でよい)
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                          r"Software\Classes\%s\shell\open\command" % SCHEME) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, command)

    print("登録しました。")
    print("  スキーム: %s://" % SCHEME)
    print("  実行内容: %s" % command)
    print()
    print("Web版の⚙設定にある「🔊 PCのTTSツールを起動する」から起動できます。")
    print("(初回はブラウザが確認を出します。「常に許可」にすると次回から出ません)")


def unregister():
    for path in (r"Software\Classes\%s\shell\open\command" % SCHEME,
                 r"Software\Classes\%s\shell\open" % SCHEME,
                 r"Software\Classes\%s\shell" % SCHEME,
                 r"Software\Classes\%s" % SCHEME):
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
        except FileNotFoundError:
            pass
    print("登録を取り消しました。")


def show():
    """現在の登録内容を表示する(確認用)。"""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Classes\%s\shell\open\command" % SCHEME) as key:
            print("登録済み: " + winreg.QueryValueEx(key, None)[0])
    except FileNotFoundError:
        print("未登録です。")


if __name__ == "__main__":
    if "--unregister" in sys.argv:
        unregister()
    elif "--show" in sys.argv:
        show()
    else:
        register()
