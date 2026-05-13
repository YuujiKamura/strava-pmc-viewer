# SETUP — strava-pmc-viewer

各 visitor が自分のインフラで動かすための手順。Cloudflare と Strava の無料枠で
完結する。所要時間: 約 20 分。

## 必要なもの

- Strava アカウント (運動データを取りたい本人のもの)
- Cloudflare アカウント (無料登録で OK)
- Node.js 18 以上 + npm (Cloudflare の wrangler CLI を入れるため)
- 普通のブラウザ

## このセットアップで何が起きるか

- **自分の Strava API App** を 1 個作る → Client ID と Client Secret が手に入る
- **自分の Cloudflare Worker** を 1 個立てる → Client Secret を安全に保持して
  Strava の OAuth トークン交換だけを中継する小さなサーバになる
- **自分の GitHub Pages** に SPA を置く → ブラウザだけで動く Strava ビューア
- SPA に「自分の Client ID」と「自分の Worker URL」を貼って完成

このリポの作者 (yuuji) のサーバには一切依存しない。誰かのトークンや運動データが
共有サーバに溜まることもない。rate limit (Strava の 100 reads/15min) は自分の
App だけで使い切れる。

---

## 1. Strava で自分の API Application を作る (5 分)

1. https://www.strava.com/settings/api をブラウザで開く
2. 「Create & Manage Your App」を押す
3. フォームに以下を入力する:
   - **Application Name**: 任意 (例: `my-pmc-viewer`)
   - **Category**: `Visualizer`
   - **Club**: 空のまま
   - **Website**: あとで作る自分の GitHub Pages の URL
     (例: `https://<username>.github.io/strava-pmc-viewer/`)
   - **Authorization Callback Domain**: 上の URL の **host だけ**
     (例: `<username>.github.io`)。`https://` も path も付けない、ホスト名だけ
4. 「Create」を押す
5. 作成後の画面で **Client ID** と **Client Secret** をメモする
   - Client Secret は初回のみ表示される (後で「Show」ボタンで再表示は可能)。
     失くしたら「Refresh」で再発行する
6. (任意) Rate Limit の引き上げ申請: 同じページから「increase」のリンクがある。
   デフォルトは 100 reads / 15min, 1000 reads / day。個人で見るぶんには十分
   なので最初は触らなくていい

### ローカル開発も併用したい場合

Strava の API App は **1 個につき callback domain が 1 個** しか登録できない。
本番用 (GitHub Pages) と開発用 (`localhost`) を併用したいなら、**もう 1 個別の
App を作って** callback domain を `localhost` にしておくと楽。

---

## 2. Cloudflare Worker をデプロイする (10 分)

Worker は Strava の「認可コード ↔ アクセストークン」交換だけを担当する小さな
サーバ。Client Secret はここから外に出ない。

1. https://dash.cloudflare.com で無料アカウントを作る (メール + パスワードだけ)
2. ターミナルで wrangler CLI を入れる:
   ```
   npm install -g wrangler
   ```
3. このリポを fork (または clone) してローカルに持ってくる:
   ```
   git clone https://github.com/<your-username>/strava-pmc-viewer
   cd strava-pmc-viewer/worker
   ```
4. Cloudflare にログイン (ブラウザが開いて認可画面が出る):
   ```
   wrangler login
   ```
5. Strava の Client ID / Secret を Worker の secret として登録する。
   コマンドを打つと値を聞かれるので、1 で控えた値を貼り付ける:
   ```
   wrangler secret put STRAVA_CLIENT_ID
   wrangler secret put STRAVA_CLIENT_SECRET
   ```
6. `worker/wrangler.toml` を開いて `ALLOWED_ORIGIN` を自分の GitHub Pages の
   オリジンに書き換える:
   ```toml
   [vars]
   ALLOWED_ORIGIN = "https://<your-username>.github.io"
   ```
   ローカル開発も併用するならカンマ区切りで複数指定:
   ```toml
   ALLOWED_ORIGIN = "https://<your-username>.github.io,http://localhost:8080"
   ```
   末尾スラッシュは付けない (`https://foo.github.io/` ではなく
   `https://foo.github.io`)
7. デプロイする:
   ```
   wrangler deploy
   ```
8. 完了画面に Worker の URL が出る
   (例: `https://strava-pmc-relay.<your-account>.workers.dev`)。メモする

---

## 3. GitHub Pages にデプロイする (5 分)

SPA 本体 (HTML / CSS / JS) を GitHub Pages で公開する。

1. fork した自分の repo を GitHub で開く
2. Settings → Pages
3. Source: `Deploy from a branch`
4. Branch: `main` / Folder: `/public` を選んで Save
5. 数分後、`https://<your-username>.github.io/strava-pmc-viewer/` が動き始める
6. その URL の host (例: `<your-username>.github.io`) が 1 の Strava App の
   Authorization Callback Domain と一致していることを確認

`/public` ディレクトリを公開できない構成 (org の制約等) の場合は、`public/` の
中身を repo root にコピーした `gh-pages` ブランチを作って公開してもいい。

---

## 4. SPA に自分の値を貼る (1 分)

1. ブラウザで `https://<your-username>.github.io/strava-pmc-viewer/` を開く
2. 「⚙ Setup」セクションを開く (初回アクセス時は自動で開いている)
3. **Strava Client ID** に 1 で控えた Client ID を貼る
4. **Worker URL** に 2 で控えた Worker URL を貼る
5. 「保存」を押す
6. 「Strava と接続」ボタンが有効になる。押すと Strava の認可画面に飛ぶ
7. 認可するとアプリに戻ってきて、年度ボタンが選べるようになる

ここまでで完了。設定値はブラウザの localStorage に保存されるので、次回以降は
貼り直し不要。

---

## トラブルシューティング

### `CORS error` がブラウザコンソールに出る
Worker の `ALLOWED_ORIGIN` と GitHub Pages のオリジンがズレている。`https://`
の有無、末尾スラッシュの有無まで一致させる。`wrangler.toml` を書き換えたら
もう 1 度 `wrangler deploy`。

### Strava 認可後に `401 invalid client` が出る
Strava App の Authorization Callback Domain が GitHub Pages の host と一致して
いない可能性が高い。1 の手順を見直す (`https://` を付けずに host だけ書く)。
また Worker secret の `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` が正しく入って
いるか `wrangler secret list` で確認。

### `429 Too Many Requests` が出る
Strava の rate limit (100 reads / 15min) を踏んでいる。SPA 側にクールダウンは
あるが連打すると詰まることがある。15 分待つと回復する。

### Worker の動きを見たい
別ターミナルで:
```
wrangler tail
```
SPA を操作するとリクエストログが流れる。

### Cloudflare のフリープランで足りるのか
個人利用なら確実に足りる。Worker フリープランは 1 日 10 万リクエスト、Strava の
1 日 1000 reads を踏み切るほうがずっと先に詰まる。

---

## セキュリティ・プライバシーまとめ

- **Client Secret** は自分の Cloudflare Worker のみ保持。ブラウザにも、リポにも、
  yuuji 側のサーバにも置かれない
- **Access Token** はブラウザの localStorage に置かれる。本人のデバイスから外に
  出ない
- **Activity データ** はブラウザ内で取得・計算・描画し、localStorage に同一ユーザー
  用の cache だけ残る。第三者のサーバに送られない
- Strava API Agreement §5.1 + §2.10 (本人データを本人にだけ表示する) の範囲内で
  動くよう設計されている

ただし Strava の ToS は改訂されるので、運用前に
https://www.strava.com/legal/api を一読しておくこと。
