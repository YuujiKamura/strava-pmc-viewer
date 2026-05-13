# strava-pmc-relay (Cloudflare Worker)

Strava OAuth の `code → token` / `refresh_token → new token` を中継する最小
Worker。`client_secret` をブラウザに置けないので、ここで保持する。

## Setup

```bash
npm install -g wrangler
wrangler login
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
# ALLOWED_ORIGIN は wrangler.toml vars または:
wrangler deploy --var ALLOWED_ORIGIN:"https://<user>.github.io,http://localhost:8080"
```

ローカル開発:
```bash
wrangler dev  # http://localhost:8787
```

## Endpoints

| Method | Path        | Body                              | Returns                           |
|--------|-------------|-----------------------------------|-----------------------------------|
| POST   | `/exchange` | `{ code, redirect_uri }`          | Strava の token レスポンス丸ごと  |
| POST   | `/refresh`  | `{ refresh_token }`               | 新しい token レスポンス           |
| OPTIONS| (any)       | CORS preflight                    | 204                                |

CORS は `ALLOWED_ORIGIN` の最初のホスト (または origin が allowlist 内なら
そのまま) を `Access-Control-Allow-Origin` に返す。
