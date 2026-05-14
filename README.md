<img width="1172" height="1200" alt="image" src="https://github.com/user-attachments/assets/cb1fd370-7ab3-4973-afb5-45f635359f18" />

# Strava PMC Viewer

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-57%20passing-brightgreen.svg)](./tests)
[![Strava API](https://img.shields.io/badge/Strava-API%20v3-fc4c02.svg)](https://developers.strava.com/)

Strava のライド記録を **年度ごとに Fitness / Freshness / Form (PMC)** チャートにする
セルフホスト型ビューア。共有サーバを持たず、各 visitor が**自分の Cloudflare Worker** を
1 つ立てるだけで動く。走行データはブラウザの localStorage を出ない。

```
Strava API  ↔  あなたの Cloudflare Worker (OAuth 中継)  ↔  あなたのブラウザ
```

- **走行データ**: ブラウザの localStorage に閉じる、サーバ送信なし
- **Client Secret**: 各 visitor の Worker 内 (`wrangler secret put`)、SPA にもリポにも乗らない
- **運営者ゼロ**: 開発者側のインフラを一切経由しない、共有サーバを持たない構成

## クイックスタート

```bash
git clone https://github.com/YuujiKamura/strava-pmc-viewer.git
cd strava-pmc-viewer/worker
npm install -g wrangler
wrangler login
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
wrangler deploy --var ALLOWED_ORIGIN:"https://YOUR-USERNAME.github.io"
```

そのあと SPA を開いて Client ID + Worker URL を「⚙ Setup」に貼り付ける。
詳細は **[SETUP.md](./SETUP.md)** を参照。

## 何ができるか

- 過去 15 年分のライドを **年度ボタン**で切替表示
- ドラッグで範囲ズーム、任意点クリックで前後 ±3 日のアクティビティ詳細
- 現在時刻の推計 (時間粒度の連続時間減衰、最終ライドから N 時間経過の体力 / 疲労)
- 「あと N 日 H 時間で身体の余裕が戻る」リカバリー予測
- パワーデータの後付け取得 (`suffer_score` / `weighted_average_watts` を埋めて Strava 公式と数値一致)

## 構成

```
public/   SPA 本体 (Chart.js + Hammer.js)、GitHub Pages serve 対象
  js/{pmc,auth,config,cache,strava,util,app}.js
worker/   Cloudflare Worker (OAuth code 交換 + token refresh + rate-status)
tests/    node --test (57 件)
.github/workflows/pages.yml   public/ を GitHub Pages に Actions 経由でデプロイ
```

## セキュリティ

| 防御 | 実装 |
|---|---|
| Client Secret 隔離 | Worker のみ保持、SPA / リポに乗らない |
| CORS fail-closed | `ALLOWED_ORIGIN` allowlist、`*` fallback なし、未マッチは ACAO header 不付与 |
| OAuth state CSRF | RFC 6749 §10.12 準拠 (`crypto.getRandomValues(16)` → sessionStorage で照合) |
| XSS escape | activity 表示時 `escapeHtml` 経由 (5 entity + `String()` coerce) |
| 429 backoff | Strava `Retry-After` 尊重、本ツール側 self-count で上限管理 (900s clamp) |
| 最小権限 scope | `activity:read` / `activity:read_all` を opt-in 切替、scope 変更時 token + cache clear |
| CDN 改ざん検知 | jsdelivr の Chart.js / Hammer / zoom plugin に SRI sha384 hash + `crossorigin` |
| Rate budget 可視化 | Worker `/rate-status` 経由で Strava の `X-RateLimit-*` を取得して UI 表示 |

詳細は [SETUP.md § セキュリティ・プライバシーまとめ](./SETUP.md) と [worker/index.js](./worker/index.js)。

## ToS 準拠

Strava API Agreement **§5.1** (本人 OAuth + 本人 UI 表示) / **§2.10** (他人データ非取扱) /
**§2.14** (非再配布) / **§2.15** (非 sublicense) の範囲で動作。**運用前に最新版を確認**。

## tests

```bash
node --test tests/pmc.test.js tests/pure.test.js tests/security.test.js tests/network.test.js
```

PMC math (20) + pure 関数境界 (20) + CORS/OAuth/XSS/cache 分離 (15) + Strava 429 backoff (2)、計 57 件。

## ライセンス

MIT — 本 repo の [LICENSE](./LICENSE) 参照。fork 自由、Strava ToS と Cloudflare 利用規約は本人が確認すること。

## Changelog

- **2026-05-13**: scope 既定値を `activity:read_all` (private 含む全件) に変更。
  旧版で setup 済の visitor は setup-panel で「保存」を一度押せば自動的に再 OAuth、
  public のみで使いたい場合は checkbox を外す。

## commit 規約

Conventional Commits + project 拡張 (`ux:` UI/UX、`sec:` security boundary、
`diag:` 診断 / observability)。1 commit 1 関心事。
