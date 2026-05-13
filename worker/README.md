# strava-pmc-relay (Cloudflare Worker)

Strava OAuth の `code → token` / `refresh_token → new token` を中継する最小
Worker。`client_secret` をブラウザに置けないので、ここで保持する。

各 visitor が自分の Cloudflare アカウントにこれをデプロイして使う。

## Setup

このディレクトリ単体ではなく、リポ全体のセットアップ手順
**[../SETUP.md](../SETUP.md) の「2. Cloudflare Worker をデプロイする」**
を参照。Strava App の作成 → secret 登録 → `ALLOWED_ORIGIN` 設定 → デプロイの
順で書いてある。

## Endpoints

| Method  | Path        | Body                              | Returns                          |
|---------|-------------|-----------------------------------|----------------------------------|
| POST    | `/exchange` | `{ code, redirect_uri }`          | Strava の token レスポンス丸ごと |
| POST    | `/refresh`  | `{ refresh_token }`               | 新しい token レスポンス          |
| OPTIONS | (any)       | CORS preflight                    | 204                              |

CORS は `ALLOWED_ORIGIN` の最初のホスト (または origin が allowlist 内なら
そのまま) を `Access-Control-Allow-Origin` に返す。

## ローカル開発

```bash
wrangler dev   # http://localhost:8787
```

`ALLOWED_ORIGIN` にカンマ区切りで `http://localhost:8080` を足しておくと、
SPA 側をローカルで動かしているときも CORS が通る。
