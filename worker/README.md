# OAuth トークン交換用 Worker（セットアップ手順）

Web 版の Google ログインを「1 時間で切れる」状態から「一度ログインすれば
しばらく持つ」状態にするための、**client_secret を預かるだけの小さな中継**です。
スプレッドシートの読み書き自体は従来どおりブラウザが直接 Sheets API を呼びます。

処理の中身と設計判断は [`src/index.js`](src/index.js) 冒頭のコメントを参照してください。

---

## 1. Google 側の設定（先にこちらを済ませる）

[Google Cloud Console →「API とサービス」→「認証情報」](https://console.cloud.google.com/apis/credentials)

既存の OAuth クライアント ID（種類「ウェブ アプリケーション」）を開き、
次の 2 つを設定します。**どちらも末尾スラッシュの有無まで完全一致が必要です。**

| 項目 | 値 |
| --- | --- |
| 承認済みの JavaScript 生成元 | `https://yoimachihime-tech.github.io` |
| 承認済みのリダイレクト URI | `https://yoimachihime-tech.github.io/ANKI-OutputTOOL/` |

> **リダイレクト URI は今回新しく必要になった項目です。** これまでの
> GIS token client 方式では不要だったため、未登録のはずです。
> 登録しないと、ログイン時に Google が `redirect_uri_mismatch` エラーを返します。

同じ画面でクライアント ID と**クライアント シークレット**をコピーしておきます
（シークレットは後で Worker に登録します。画面を閉じると再表示できない場合が
あるので、その場合は「シークレットをリセット」で作り直してください）。

---

## 2. Cloudflare アカウントの用意

[dash.cloudflare.com](https://dash.cloudflare.com/sign-up) で無料アカウントを作成します。
**クレジットカードの登録は不要**です（Workers の無料枠は 1 日 10 万リクエストで、
この用途では 1 日数回しか呼ばれません）。

---

## 3. Worker の設定ファイルを書き換える

[`wrangler.toml`](wrangler.toml) の `GOOGLE_CLIENT_ID` を、手順 1 でコピーした
クライアント ID に置き換えます。

```toml
GOOGLE_CLIENT_ID = "xxxxxxxx.apps.googleusercontent.com"
```

`GOOGLE_CLIENT_SECRET` は**このファイルに書かないでください**（Git に載るため）。
次の手順で別途登録します。

---

## 4. デプロイ

リポジトリのルートで、以下を順に実行します（Node.js が必要）。

```bash
cd worker

# 初回のみ。ブラウザが開き、Cloudflare アカウントとの連携を求められる
npx wrangler login

# デプロイ（最後に Worker の URL が表示される）
npx wrangler deploy

# クライアント シークレットを登録する
# （対話式。入力中は画面に何も表示されないが正常）
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

> **`npm install` は不要です。** `npx` が wrangler を npm のキャッシュ
> （プロジェクト外）に取得します。このリポジトリは Google Drive 同期フォルダの
> 中にあるため、`node_modules`（数千ファイル）をここに作らない方が同期が
> 軽く済みます。バージョンを固定したい場合は `npm install` しても構いません
> （`package.json` に wrangler を宣言してあります）。

シークレットの登録をデプロイの後にしているのは、先に Worker を作っておくと
`secret put` が「その名前の Worker が無いが作るか？」という確認を出さずに
済むためです。デプロイ直後からシークレット登録までの間、Worker は
「設定が未完了です」を返しますが、まだ誰も呼んでいないので問題ありません。

デプロイに成功すると、次のような URL が表示されます。

```text
https://anki-tool-oauth.<あなたのサブドメイン>.workers.dev
```

**この URL を控えてください。** 次の手順でアプリに設定します。

---

## 5. アプリ側に Worker の URL を設定する

Web 版（`https://yoimachihime-tech.github.io/ANKI-OutputTOOL/`）を開き、

⚙ 設定 →「スプレッドシート」→ **「ログイン維持用 Worker の URL」**

に手順 4 の URL を貼り付けます（末尾スラッシュは不要）。

保存したら「Google にログイン」を押します。Google の同意画面へ移動し、
許可すると元のページに戻ってきます。以降はページを閉じても、
しばらくはログインし直さずに使えます。

> **Worker の URL を空欄にすると、従来どおりの 1 時間で切れる方式
> （GIS token client）で動きます。** Worker が落ちている・設定を間違えた
> といった場合でも、URL を消せばひとまず今までどおり使えます。

---

## 6. 動作確認

1. ログイン後、ヘッダーの状態表示が「Google にログイン済み」になる
2. **ブラウザのタブを閉じて開き直しても**ログイン済みのままである
3. 「🔄 同期」やDailyConversationタブのシート読み込みが、
   ログインし直さずに動く

---

## 制限事項 — OAuth 同意画面が「テスト」ステータスの場合

Google の仕様で、**同意画面が「テスト」ステータスのままだと
リフレッシュトークンは 7 日で失効します。**
その場合、週に 1 回ログインし直す必要があります
（それでも「1 時間ごと」よりは大幅に改善します）。

失効したときは、アプリが自動で「ログインの有効期限が切れました」と表示し、
保存済みのトークンを破棄します。ログインし直せば復帰します。

7 日制限をなくしたい場合は、Google Cloud Console の
「API とサービス」→「OAuth 同意画面」で**「本番環境」に公開**します。
`spreadsheets` は機密スコープのため、公開すると初回のログイン時に
「このアプリは Google で確認されていません」という警告画面が出ますが、
「詳細」→「（アプリ名）に移動」で先に進めます（本人だけが使う分には
Google の審査を受ける必要はありません）。
