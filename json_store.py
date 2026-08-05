#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
json_store.py
-------------
このソフトが持つ各種の永続化JSON(ストック・カード定義・タブ状態・除外リスト)を
**安全に**読み書きするための共通モジュール(2026-08-05追加)。

【なぜ必要か】
それまで各モジュール(word_stock.py / shuujuku_stock.py / grammar_multi_stock.py /
card_defs.py / tab_notes_state.py / daily_pending_exclusions.py)は、いずれも

    with open(path, "w", encoding="utf-8") as f:
        json.dump(...)

という同じ書き方をしていた。`open(path, "w")`は**開いた時点で既存の中身を
切り捨てる**ため、json.dumpの途中でプロセスが落ちる・Google Driveの同期が
ファイルをロックする等が起きると、中途半端なJSONだけが残る。さらに読み込み側の
`json.load()`にも例外処理が無かったため、一度壊れると次回以降は
`JSONDecodeError`で起動時から操作不能になり、**片桐の実データ(未出力の
単語・習熟用候補など)が失われる**という構成になっていた。

このフォルダがGoogle Drive同期下にあること、CLAUDE.mdに「テストで実データを
上書き・削除する事故を過去に2回起こしている」と記録されていることを踏まえ、
書き込みをアトミックにし、読み込みを壊れに強くする責務をここへ集約した。

【方針】
- 書き込み: 同じフォルダの一時ファイルへ書き切ってから`os.replace()`で置き換える。
  `os.replace()`はWindowsでも「既存ファイルを上書きする」動作がアトミックである
  ことが保証されているため、途中で落ちても**旧版が丸ごと残る**(中途半端な状態に
  ならない)。同じフォルダに一時ファイルを作るのは、別ドライブ/別ボリュームだと
  os.replace()がアトミックにならないため。
- 読み込み: 壊れていた場合は例外を投げず、壊れたファイルを`.corrupt`へ退避した
  うえで既定値を返す。**黙って空にするのではなく退避する**のは、後から手作業で
  中身を救出できる可能性を残すため(JSONの末尾が切れただけなら大半は読める)。
"""

import json
import os
import shutil
import tempfile


def read_json(path: str, default):
    """JSONを読む。ファイルが無い/壊れている場合は`default`を返す。

    壊れていた場合は、そのファイルを `<path>.corrupt` へ退避してから返す
    (次回の書き込みで完全に上書きされて消えてしまう前に、手作業で救出できる
    余地を残すため)。`default`はそのまま返すので、呼び出し側が書き換える
    可能性がある場合は毎回新しいオブジェクトを渡すこと。
    """
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        _quarantine_corrupt_file(path)
        return default


def write_json(path: str, data) -> None:
    """JSONをアトミックに書き込む(一時ファイル + os.replace)。

    書き込み途中で落ちても、既存ファイルは旧版のまま無傷で残る。
    """
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)

    # 同じフォルダに一時ファイルを作る(os.replace()がアトミックであるためには
    # 置換元と置換先が同一ボリューム上にある必要がある)。
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            # OSのバッファに残ったままos.replace()すると、電源断時に「置換は
            # されたが中身が空」になりうるため、明示的にディスクへ吐き出す。
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        # 失敗した場合は一時ファイルを残さない(既存ファイルは触っていないので
        # そのまま旧版が有効なまま残る)。
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _quarantine_corrupt_file(path: str) -> None:
    """壊れたJSONを `<path>.corrupt` へ退避する(失敗しても無視する)。"""
    try:
        shutil.copy2(path, path + ".corrupt")
    except OSError:
        pass
