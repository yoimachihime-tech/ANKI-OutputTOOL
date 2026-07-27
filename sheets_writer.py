#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheets_writer.py
----------------
「添削結果」シートへの書き込みを行うモジュール。もともとは「Anki出力済み」列
への書き込み(mark_rows_as_exported)だけだったが、2026-07-27にDailyConversation
タブへの直接入力機能(gemini_client.correct_english_text()の結果を新規行として
追記するappend_correction_rows)を追加した。それぞれの関数は自分が担当する
列・操作の範囲外には一切触れない(mark_rows_as_exportedは既存行の「Anki出力済み」
列のみ、append_correction_rowsは新規行の追加のみで既存行には触れない)。

【セットアップ(初回のみ)】
    1. Google Cloud ConsoleでAPI有効化: Google Sheets API
    2. サービスアカウントを作成し、JSONキーを発行。対象スプレッドシートを
       そのサービスアカウントのメールアドレスと「編集者」権限で共有する
    3. pip install google-api-python-client google-auth
    4. サービスアカウントJSONのパスは、コード中に埋め込まずに環境変数
       (例: SHEETS_WRITER_CREDENTIALS)で管理し、呼び出し側がそこから読んで
       credentials_path として渡す

【設計方針(重要)】
    - このモジュールは「読み取り」を主目的にしない(ID列の読み取りは、
      対象行を特定するための手段としてのみ行う。原文・添削後・スコアなど
      他の列の内容そのものはここでは読み書きしない)
    - 書き込みは「Anki出力済み」列に限定し、他の列には一切触れない
    - 認証情報(サービスアカウントJSON等)は tts_core.py のAPIキー設定
      (config.json)とは別ファイル・別環境変数で管理する
    - 失敗時は例外(SheetsWriterError)を投げるだけにして、呼び出し側
      (GUIやオーケストレーター)がログ表示・リトライを判断できるようにする
    - 本番書き込みの前に dry_run=True で「どの行に何を書く予定か」を
      ログ出力だけして確認できる

【呼び出し方】
    from sheets_writer import mark_rows_as_exported

    result = mark_rows_as_exported(
        spreadsheet_id="1ruIEHQk8J0rjjQQdiaT2NvnjeLrn9pbUqqvrUBJx9BE",
        sheet_name="添削結果",
        row_ids=["1c0859c2-...", "ee048073-..."],
        credentials_path=os.environ["SHEETS_WRITER_CREDENTIALS"],
        dry_run=True,   # まずはドライランで確認してからFalseにする
        log=print,
    )
    print(result.succeeded, result.failed)
"""

import datetime
import uuid
from dataclasses import dataclass

try:
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    GOOGLE_API_AVAILABLE = True
except ImportError:
    GOOGLE_API_AVAILABLE = False

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class SheetsWriterError(Exception):
    """Sheets API呼び出し中に発生したエラーをまとめて示す例外。"""


@dataclass
class MarkExportResult:
    """mark_rows_as_exported() の戻り値。"""

    succeeded: list
    failed: list
    dry_run: bool = False


def _col_letter(index: int) -> str:
    """0始まりの列インデックスをA1表記の列名(A, B, ..., Z, AA, ...)に変換する。"""
    letters = ""
    index += 1
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _get_service(credentials_path: str):
    if not GOOGLE_API_AVAILABLE:
        raise SheetsWriterError(
            "google-api-python-client / google-auth がインストールされていません。"
            "`pip install google-api-python-client google-auth` を実行してください。"
        )
    creds = Credentials.from_service_account_file(credentials_path, scopes=SHEETS_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _find_target_rows(
    service,
    spreadsheet_id: str,
    sheet_name: str,
    id_column_name: str,
    exported_column_name: str,
    row_ids: set,
):
    """ID列を読み取り、row_idsに一致する行番号を特定する。
    戻り値: (row_id -> 行番号 の辞書, Anki出力済み列の0始まり列インデックス)
    """
    header_range = f"{sheet_name}!1:1"
    header_result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=header_range
    ).execute()
    headers = header_result.get("values", [[]])[0] if header_result.get("values") else []

    try:
        id_col_idx = headers.index(id_column_name)
    except ValueError:
        raise SheetsWriterError(f"ヘッダーに「{id_column_name}」列が見つかりません: {headers}")
    try:
        exported_col_idx = headers.index(exported_column_name)
    except ValueError:
        raise SheetsWriterError(f"ヘッダーに「{exported_column_name}」列が見つかりません: {headers}")

    id_col_letter = _col_letter(id_col_idx)
    id_range = f"{sheet_name}!{id_col_letter}2:{id_col_letter}"
    id_result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=id_range
    ).execute()
    id_values = id_result.get("values", [])

    row_map = {}
    for offset, row in enumerate(id_values):
        if row and row[0] in row_ids:
            row_map[row[0]] = offset + 2  # 1行目はヘッダーなのでデータは2行目始まり

    return row_map, exported_col_idx


def mark_rows_as_exported(
    spreadsheet_id: str,
    sheet_name: str,
    row_ids: list,
    credentials_path: str,
    exported_column_name: str = "Anki出力済み",
    id_column_name: str = "ID",
    dry_run: bool = False,
    log=lambda msg: None,
) -> MarkExportResult:
    """指定した行ID(ID列の値)に対応する「Anki出力済み」列に、
    書き込み時刻(YYYY-MM-DD HH:MM:SS)を書き込む。

    Args:
        row_ids: ID列の値のリスト。ここに含まれる行だけが対象。
        dry_run: Trueの場合、実際には書き込まず、書き込み予定の内容をlogに出すだけ。
        log: 進捗・警告メッセージを受け取るコールバック。

    Returns:
        MarkExportResult: 見つかって処理した行ID(succeeded)と、
        ID列に見つからなかった行ID(failed)。

    Raises:
        SheetsWriterError: 認証・API呼び出し・列が見つからない等の失敗時。
    """
    if not row_ids:
        return MarkExportResult(succeeded=[], failed=[], dry_run=dry_run)

    service = _get_service(credentials_path)

    try:
        row_map, exported_col_idx = _find_target_rows(
            service, spreadsheet_id, sheet_name, id_column_name, exported_column_name, set(row_ids)
        )
    except HttpError as e:
        raise SheetsWriterError(f"シートの読み取りに失敗しました: {e}") from e

    exported_col_letter = _col_letter(exported_col_idx)
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    succeeded = []
    failed = [rid for rid in row_ids if rid not in row_map]
    for rid in failed:
        log(f"警告: ID「{rid}」が「{id_column_name}」列に見つかりませんでした。")

    data = []
    for row_id, row_number in row_map.items():
        cell_range = f"{sheet_name}!{exported_col_letter}{row_number}"
        data.append({"range": cell_range, "values": [[timestamp]]})
        prefix = "[ドライラン] " if dry_run else ""
        suffix = "書き込みます(予定)" if dry_run else "書き込みました"
        log(f"{prefix}行{row_number} ({row_id}) の「{exported_column_name}」列に "
            f"{timestamp!r} を{suffix}")
        succeeded.append(row_id)

    if dry_run or not data:
        return MarkExportResult(succeeded=succeeded, failed=failed, dry_run=dry_run)

    try:
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        ).execute()
    except HttpError as e:
        raise SheetsWriterError(f"書き込みに失敗しました: {e}") from e

    return MarkExportResult(succeeded=succeeded, failed=failed, dry_run=dry_run)


# ---------------------------------------------------------------------------
# 添削結果の新規行追記(DailyConversationタブへの直接入力、2026-07-27追加)
# ---------------------------------------------------------------------------
#
# これまで「添削結果」シートへの新規行追加は、Googleフォーム→Apps Script
# (writeToResultSheet)という別プロジェクトの工程でしか行えなかった。ここでは
# gemini_client.correct_english_text()が返した添削結果を、Apps Script側と
# 同じ列構成でシートに追記する。列の並びはシートの実際のヘッダー行を読み
# 取って動的に対応させる(固定の列順を決め打ちしない。手元でシートの列を
# 並べ替えていても壊れないため)。

_CORRECTION_COLUMN_BUILDERS = {
    "ID": lambda c, row_id, now_str: row_id,
    "日時": lambda c, row_id, now_str: now_str,
    "原文": lambda c, row_id, now_str: c.get("original", ""),
    "添削後": lambda c, row_id, now_str: c.get("corrected", ""),
    "解説": lambda c, row_id, now_str: c.get("explanation", ""),
    "カテゴリ": lambda c, row_id, now_str: c.get("category", ""),
    "類似表現(英文)": lambda c, row_id, now_str: "\n".join(
        s.get("expression", "") for s in (c.get("similar_expressions") or [])
    ),
    "類似表現(解説)": lambda c, row_id, now_str: "\n".join(
        s.get("note", "") for s in (c.get("similar_expressions") or [])
    ),
    "文法スコア": lambda c, row_id, now_str: c.get("grammar_score", ""),
    "自然さスコア": lambda c, row_id, now_str: c.get("naturalness_score", ""),
    "伝わりやすさスコア": lambda c, row_id, now_str: c.get("comprehensibility_score", ""),
    "スコア解説": lambda c, row_id, now_str: c.get("score_comment", ""),
    "Anki出力済み": lambda c, row_id, now_str: "",
}


def _fetch_headers(service, spreadsheet_id: str, sheet_name: str) -> list:
    header_range = f"{sheet_name}!1:1"
    header_result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=header_range
    ).execute()
    return header_result.get("values", [[]])[0] if header_result.get("values") else []


def append_correction_rows(
    spreadsheet_id: str,
    sheet_name: str,
    corrections: list,
    credentials_path: str,
    dry_run: bool = False,
    log=lambda msg: None,
) -> list:
    """gemini_client.correct_english_text()が返したcorrections(dictのリスト)を、
    Apps Script(writeToResultSheet)と同じ列構成でシートに新規行として追記する。

    ID列はuuid4で新規採番する(Apps ScriptのUtilities.getUuid()と同じ役割)。
    日時列は現在時刻の文字列を valueInputOption="USER_ENTERED" で書き込むため、
    Apps ScriptのnewDate()と同様にシート側で日時として認識される。
    Anki出力済み列は空文字(未出力)にする。

    Args:
        corrections: gemini_client.correct_english_text()の戻り値。
        dry_run: Trueの場合、実際には書き込まず、追記予定の内容をlogに出すだけ。

    Returns:
        追記した各行のID列の値のリスト(sheets_readerが後で拾える)。

    Raises:
        SheetsWriterError: 認証・API呼び出し・ヘッダー行が空等の失敗時。
    """
    if not corrections:
        return []

    service = _get_service(credentials_path)

    try:
        headers = _fetch_headers(service, spreadsheet_id, sheet_name)
    except HttpError as e:
        raise SheetsWriterError(f"シートの読み取りに失敗しました: {e}") from e
    if not headers:
        raise SheetsWriterError(f"シート「{sheet_name}」のヘッダー行が空です。")

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    new_ids = []
    values = []
    for c in corrections:
        row_id = str(uuid.uuid4())
        new_ids.append(row_id)
        row = []
        for header in headers:
            builder = _CORRECTION_COLUMN_BUILDERS.get(header)
            row.append(builder(c, row_id, now_str) if builder else "")
        values.append(row)

    prefix = "[ドライラン] " if dry_run else ""
    for row_id, c in zip(new_ids, corrections):
        log(f"{prefix}行を追加します(予定): ID={row_id}, original={c.get('original', '')!r}")

    if dry_run:
        return new_ids

    try:
        service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=sheet_name,
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": values},
        ).execute()
    except HttpError as e:
        raise SheetsWriterError(f"シートへの追記に失敗しました: {e}") from e

    log(f"{len(values)} 行をシートに追加しました。")
    return new_ids
