#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sheets_reader.py
----------------
「添削結果」シートから、まだAnki出力していない行(「Anki出力済み」列が空の行)だけを
読み取り専用で取得するモジュール。`sheets_writer.py`(書き込み専用)の対になる。

【設計方針(重要)】
    - このモジュールは読み取りだけを行う。シートへの書き込みは一切行わない
      (書き込みは sheets_writer.py の責務)
    - 取得したデータをそのまま返すだけで、Ankiノート化(genankiでのデッキ生成)は
      行わない(それは deck_builder.py の責務)
    - 認証は sheets_writer.py と同じくサービスアカウント方式のみ

【戻り値の形式】
    build_grammar_dailyconv_v1_final.build_deck() がそのまま受け取れる、
    以下のキーを持つdictのリスト:
        id, original, corrected, explanation, category,
        similar_en_list(list[str]), similar_ja_list(list[str]),
        grammar_score, naturalness_score, comprehensibility_score, score_comment
    (スコアが未入力の行は None になる)
"""

try:
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    GOOGLE_API_AVAILABLE = True
except ImportError:
    GOOGLE_API_AVAILABLE = False

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


class SheetsReaderError(Exception):
    """Sheets API呼び出し中に発生したエラーをまとめて示す例外。"""


def _get_service(credentials_path: str):
    if not GOOGLE_API_AVAILABLE:
        raise SheetsReaderError(
            "google-api-python-client / google-auth がインストールされていません。"
            "`pip install google-api-python-client google-auth` を実行してください。"
        )
    creds = Credentials.from_service_account_file(credentials_path, scopes=SHEETS_SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def _split_multiline(cell: str) -> list:
    return [line.strip() for line in cell.split("\n") if line.strip()]


def _to_int_or_none(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def fetch_pending_rows(
    spreadsheet_id: str,
    sheet_name: str,
    credentials_path: str,
    id_column_name: str = "ID",
    exported_column_name: str = "Anki出力済み",
) -> list:
    """「Anki出力済み」列が空の行だけを取得し、build_deck()向けのdict形式で返す。"""
    service = _get_service(credentials_path)

    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id, range=sheet_name
        ).execute()
    except HttpError as e:
        raise SheetsReaderError(f"シートの読み取りに失敗しました: {e}") from e

    values = result.get("values", [])
    if not values:
        return []

    headers = values[0]
    if id_column_name not in headers:
        raise SheetsReaderError(f"ヘッダーに「{id_column_name}」列が見つかりません: {headers}")
    if exported_column_name not in headers:
        raise SheetsReaderError(f"ヘッダーに「{exported_column_name}」列が見つかりません: {headers}")

    rows = []
    for raw_row in values[1:]:
        # 末尾の空セルは配列から省略されることがあるので、ヘッダー数まで埋める
        padded = raw_row + [""] * (len(headers) - len(raw_row))
        record = dict(zip(headers, padded))

        if not record.get(id_column_name, "").strip():
            continue  # ID空欄の行(末尾の空行など)はスキップ
        if record.get(exported_column_name, "").strip():
            continue  # 既にAnki出力済みの行はスキップ

        rows.append({
            "id": record.get("ID", "").strip(),
            "original": record.get("原文", ""),
            "corrected": record.get("添削後", ""),
            "explanation": record.get("解説", ""),
            "category": record.get("カテゴリ", ""),
            "similar_en_list": _split_multiline(record.get("類似表現(英文)", "")),
            "similar_ja_list": _split_multiline(record.get("類似表現(解説)", "")),
            "grammar_score": _to_int_or_none(record.get("文法スコア")),
            "naturalness_score": _to_int_or_none(record.get("自然さスコア")),
            "comprehensibility_score": _to_int_or_none(record.get("伝わりやすさスコア")),
            "score_comment": record.get("スコア解説", ""),
        })

    return rows
