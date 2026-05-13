# strava-pmc-viewer

GitHub Pages で公開可能な、**サーバにデータを保存しない** Strava Fitness &
Freshness ビューア。

各 visitor が自分の Strava で OAuth 認可 → 自分の年度を選択 → ブラウザで API
取得 → 計算 → 描画 → ページ離脱で消去。**永続化なし / クロスユーザー共有なし
/ 再配布なし**。Strava API Agreement §5.1 + §2.10 (own data display to that
user only) の範囲内で運用する設計。

## 構成

```
public/           # GitHub Pages がここを serve する
  index.html
  style.css
  js/
    pmc.js        # TSS / CTL / ATL / TSB の純粋な計算ロジック
    auth.js       # OAuth: Worker 経由で code を token に交換
    strava.js     # Strava API client (browser)
    app.js        # UI 制御 + Chart.js 描画

worker/           # Cloudflare Worker (client_secret 保持)
  index.js
  wrangler.toml
  README.md

tests/
  pmc.test.js     # node --test で実行
```

## Setup

### 1. Strava で API Application 作成
https://www.strava.com/settings/api で App を作る。Authorization Callback
Domain には GitHub Pages の host (例: `yuujikamura.github.io`) と
`localhost` を両方登録 (1 つしか登録できないので、開発は別 App を作る方が楽)。
Client ID をメモ。Client Secret は Worker に渡すので保管。

### 2. Cloudflare Worker をデプロイ
```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put STRAVA_CLIENT_ID      # ← Strava App の Client ID
wrangler secret put STRAVA_CLIENT_SECRET  # ← Client Secret
wrangler deploy
```
デプロイ後の Worker URL (例: `https://strava-pmc-relay.<account>.workers.dev`) を
`public/js/auth.js` の `CONFIG.workerUrl` に書き換え。

### 3. GitHub Pages にデプロイ
`public/` を GitHub Pages の publish dir に設定するか、`public/` の中身を
リポ root にコピーした gh-pages branch を作る。Pages 設定の Source が
`public/` から serve できるなら一番楽。

### 4. ローカル開発
```bash
# Worker
cd worker && wrangler dev   # http://localhost:8787

# 静的サイト (別 terminal)
cd public && python -m http.server 8080
```
Strava の Authorization Callback Domain に `localhost` を登録した dev App を
使う。`public/js/auth.js` の clientId を dev 用に差し替え。

## 使い方

1. 「Strava と接続」を押す
2. Strava の認可画面で許可
3. 戻ってくると年度ボタンが現れる
4. 年度を選ぶと取得 → 描画
5. ドラッグで範囲ズーム、ホイールも有効、チャート任意点クリックで下に ±3日詳細
6. 「詳細値を取得」で Suffer Score / Power を追加取得 (1.6秒/件、Strava UI 値に近づく)

## ToS 準拠の根拠

- §5.1 「on behalf of a Strava user ... permitted to access and display data
  or functionality only for that Strava user」── 本人 OAuth + 本人 UI 表示のみ
- §2.10 「Strava Data related to other users ... may not be displayed」── 他人
  データを引き込む経路を持たない (friends/segments 等を呼ばない)
- §2.14 redistribute 禁止 ── サーバに保存せず、cross-user 共有なし
- §2.15 sublicense 禁止 ── 直接表示のみ、再頒布なし

ただし Strava は ToS 改訂が頻繁。**運用前に最新の API Agreement を確認すること**。

## 制約 / 注意

- **rate limit はアプリ単位**: Worker / App 全体で 100/15min、1000/day。バズる
  と詰む。Strava デベロッパー設定で max athletes 引き上げ申請が必要。
- **client_secret は Worker でしか持たない**: 静的サイト側に bundle しない。
- **token は sessionStorage**: tab を閉じれば消える。localStorage より弱いが
  ToS 上の永続化最小化と user privacy 優先。

## tests
```bash
node --test tests/
```
