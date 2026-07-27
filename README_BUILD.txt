Anki TTS 音声追加ツール - Windows .exe 化の手順
==================================================

前提: Windows PC に Python がインストールされていること
     (未インストールの場合は python.org からダウンロードしてインストール)

--------------------------------------------------------------
ステップ1: 必要なライブラリをインストール
--------------------------------------------------------------
PowerShell または コマンドプロンプトで:

    pip install anki pyinstaller genanki google-api-python-client google-auth

--------------------------------------------------------------
ステップ2: tts_gui.py を実行してみる (exe化する前の動作確認)
--------------------------------------------------------------
    python tts_gui.py

ウィンドウが立ち上がり、apkgファイルを選択→フィールド選択→
APIキー入力→生成、という一連の操作ができればOKです。

--------------------------------------------------------------
ステップ3: .exe にビルドする
--------------------------------------------------------------
tts_gui.py があるフォルダに移動してから(例: cd C:\Users\自分の名前\Desktop)、
以下を1行でそのまま実行してください(PowerShellでもコマンドプロンプトでも
そのまま動きます):

    python -m PyInstaller --onefile --windowed --name AnkiTTSツール --collect-all anki --collect-all tkinterdnd2 --collect-all lameenc --collect-all googleapiclient tts_gui.py

(同じフォルダにある sheets_reader.py / sheets_writer.py / deck_builder.py /
build_grammar_dailyconv_v1_final.py は、tts_gui.py がimportしているため
自動的にexeへ同梱されます。個別の指定は不要です)

(注)
- 複数行に分けて書きたい場合、行末の改行記号は cmd.exe では ^ ですが、
  PowerShellでは ` (バッククォート) です。混乱を避けるため、上記のように
  1行でまとめて実行するのが確実です。
- コマンドを "pyinstaller ..." ではなく "python -m PyInstaller ..." という
  書き方にしているのは、pip installでインストールされる pyinstaller.exe が
  PATH(コマンド検索対象のフォルダ一覧)に含まれていない環境でも確実に
  動くようにするためです。
- 以前のバージョンの手順では単純に
    pyinstaller --onefile --windowed --name AnkiTTSツール anki_tts_gui.py
  としていましたが、この書き方だと ankiパッケージ内のRust製バイナリや
  tkinterdnd2の付属ファイルがexeに含まれず、実行時にエラーになることが
  あります。上記の --collect-all オプション付きコマンドを使ってください。
- --collect-all googleapiclient は、スプレッドシート連携機能に必要です
  (google-api-python-clientはAPI定義のJSONファイルをパッケージ内に持って
  おり、これを同梱しないとexe実行時にSheets APIの初期化で失敗します)。

初回はビルドに数分かかります。完了すると、同じフォルダの中に

    dist\AnkiTTSツール.exe

が生成されます。この .exe **単体**を他のPCにコピーすれば、
Pythonが入っていないPCでも動きます。

--------------------------------------------------------------
別PCへのコピーに関する注意
--------------------------------------------------------------
- コピーするのは dist フォルダの中の AnkiTTSツール.exe 1つだけでOKです
  (tts_gui.py や config.json は不要です)
- スプレッドシート連携を別PCでも使う場合は、そのPCにもサービスアカウントの
  JSONキーを配置し、環境変数 SHEETS_WRITER_CREDENTIALS にパスを設定して
  ください(キーはexeに同梱されません。むやみにコピーしないこと)
- config.json をそのままコピーすると、保存していたAPIキーもその
  PCに引き継がれます。共有したくない場合はコピーしないでください
  (config.json はPCごとに自動生成されるので、コピーしなくても
  そのまま起動できます。初回だけAPIキーの再入力が必要になります)

--------------------------------------------------------------
注意点
--------------------------------------------------------------
- 初回ビルドでウイルス対策ソフトが誤検知することがあります
  (PyInstallerで作られたexeはよく誤検知されます)。心配なら
  Windows Defenderの除外設定に追加してください。
- .exe のサイズは数十MB程度になります(Pythonの実行環境ごと
  同梱されるため)。
- ビルドはWindows上で行う必要があります。Mac/Linux上でビルド
  したファイルはWindowsでは動きません。
