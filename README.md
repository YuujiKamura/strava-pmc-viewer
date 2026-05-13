# Strava PMC Viewer

**あなたの走りを、誰にも渡さない。**

このツールは、Strava の記録を 1 年ごとにグラフ化して、自分の成長を確認できる
場所です。**他人 (作者を含む) の走行データをサンプルとして配信することはしません**
── プライバシーを謳うツールが他人のデータを見せている、という自己矛盾を避ける
ためです。設定が完了して初めて、あなた自身のグラフが表示されます。

## プライバシー設計

普通の SaaS は、あなたのデータを運営者のサーバーに送って処理します。本ツールは
**運営者を持ちません**。各 visitor が自分の Cloudflare Worker を 1 つ立てて、
それが Strava との OAuth 中継を行う構成です。開発者 (yuuji) のインフラを一切
経由しないので、走行データを開発者が見ることはできません。

データの流れ: `Strava API ↔ あなたの Cloudflare Worker ↔ あなたのブラウザ`

- **走行データの保存先**: ブラウザの localStorage のみ。サーバーには送られません。
- **Cloudflare Worker の役割**: Strava API への OAuth code 交換と token refresh
  だけを行う中継。コードは [worker/index.js](./worker/index.js) (約 100 行)、
  visitor 自身がデプロイするので開発者の手元を通りません。
- **サンプル/デモ**: 作者の実データを demo として配信していません。プライバシーを
  謳うツールが他人のデータを見せる自己矛盾を避けるためです。

設定は初回のみ。Client Secret は visitor 自身の Worker 内に閉じ、SPA にも
リポにも乗りません。

## セットアップ 3 ステップ

1. **Strava API App を作成** ── developers.strava.com で Client ID / Client Secret を取得
2. **Cloudflare Worker をデプロイ** ── `worker/` を `wrangler deploy`、Secret を `wrangler secret put` で投入
3. **SPA に貼り付け** ── Client ID と Worker URL を「⚙ Setup」パネルから保存

詳細は [SETUP.md](./SETUP.md) (所要時間 約 20 分)。

## これは何

- ブラウザだけで動く SPA。グラフは Chart.js
- 認証は本人の Strava OAuth。**他人のデータは一切扱わない**
- データは取得した本人のブラウザ内だけで計算・描画される。永続化しない、
  サーバ送信もしない (Strava API Agreement §5.1 + §2.10 準拠)

## どう動くか

- 各 visitor が **自分の Strava API App + 自分の Cloudflare Worker + 自分の
  GitHub Pages** を立てる構成。設定は SPA の「⚙ Setup」パネルで貼り付ける
- 共有サーバを誰も運営しない。yuuji (このリポの作者) のインフラには
  依存しない
- Client Secret は visitor 自身の Cloudflare Worker 内に閉じる。ブラウザにも
  リポにも漏れない

セットアップ手順は **[SETUP.md](./SETUP.md)** を参照。所要時間 約 20 分。

## 誰向け

- Strava の標準 UI の Fitness/Freshness グラフをもっと自由に見たい人
  (年度比較、任意区間ズーム、ピンポイント日付の前後 ±3 日詳細)
- 自分の運動データを **自分のインフラの中だけで** 扱いたい人
- Node.js + npm + Cloudflare アカウントを用意できる人

## 利点と欠点

**利点**

- 完全に個人インフラで動く。運営者ゼロ
- rate limit (Strava の 100 reads/15min) を他 user と共有しない、自分専用
- データが第三者のサーバに渡らない
- ToS 準拠を構造で担保しやすい (cross-user データ経路が存在しない)

**欠点**

- セットアップに 20 分前後かかる (Strava App 作成 + Cloudflare Worker デプロイ
  + GitHub Pages 設定)
- Cloudflare の無料アカウントが必要
- ローカルで wrangler を動かすために Node.js 18+ + npm が必要

## 構成

```
public/           # GitHub Pages がここを serve する (SPA 本体)
  index.html
  style.css
  js/
    pmc.js        # TSS / CTL / ATL / TSB の純粋な計算ロジック
    auth.js       # OAuth: Worker 経由で code を token に交換
    config.js     # visitor が貼る Client ID / Worker URL の保存
    strava.js     # Strava API client (browser)
    app.js        # UI 制御 + Chart.js 描画

worker/           # Cloudflare Worker (client_secret 保持)
  index.js
  wrangler.toml
  README.md

tests/
  pmc.test.js     # node --test で実行

SETUP.md          # visitor 向けセットアップ手順
```

## 使い方 (Setup 後)

1. SPA を開いて「⚙ Setup」で Client ID と Worker URL を貼り付け、保存
2. 「Strava と接続」を押す
3. Strava の認可画面で許可
4. 戻ってくると年度ボタンが現れる
5. 年度を選ぶと取得 → 描画
6. ドラッグで範囲ズーム、ホイールも有効、チャート任意点クリックで下に
   ±3 日詳細
7. 「詳細値を取得」で Suffer Score / Power を追加取得 (1.6 秒/件、Strava UI
   値に近づく)

## ToS 準拠の根拠

- **§5.1**: 「on behalf of a Strava user ... permitted to access and display data
  or functionality only for that Strava user」── 本人 OAuth + 本人 UI 表示のみ
- **§2.10**: 「Strava Data related to other users ... may not be displayed」── 他人
  データを引き込む経路を持たない (friends / segments 等を呼ばない)
- **§2.14** redistribute 禁止 ── サーバに保存せず、cross-user 共有なし
- **§2.15** sublicense 禁止 ── 直接表示のみ、再頒布なし

ただし Strava は ToS 改訂が頻繁。**運用前に最新の API Agreement を確認すること**。

## 制約 / 注意

- **rate limit はアプリ単位**: 自分の Strava App だけで 100 reads/15min,
  1000 reads/day。個人利用なら十分。引き上げ申請も可能
- **client_secret は Worker でしか持たない**: SPA 側に bundle しない
- **token は localStorage**: 同ブラウザの本人デバイス内のみ。サーバ送信なし

## セキュリティ設計の言語化

「AI 生成ツールは認証情報を雑に扱う」という批評を受けやすいので、本リポが
実装している防御を列挙する。

| 項目 | 実装 | 場所 |
|---|---|---|
| **Client Secret の隔離** | ブラウザ JS に絶対 bundle しない、Worker 側 `wrangler secret put` で保持 | `worker/index.js` |
| **CORS allowlist** | `ALLOWED_ORIGIN` (カンマ区切り) で `Access-Control-Allow-Origin` を制限。wildcard `*` を返さない | `worker/index.js` `corsHeaders()` |
| **最小権限の OAuth scope** | 既定 `activity:read` (公開のみ)。`activity:read_all` は visitor が UI で明示的に opt-in した時のみ | `public/js/auth.js` `scopeFor()` |
| **CDN 改ざん検知** | jsdelivr 上の Chart.js / Hammer / zoom plugin に `integrity="sha384-..."` + `crossorigin="anonymous"` で SRI hash 検証 | `public/index.html` |
| **429 backoff** | Strava の `Retry-After` ヘッダを尊重して 1 回だけ再試行、上限 15 分、無限ループ防止 | `public/js/strava.js` `get()` |
| **token 永続化の限界** | `localStorage` (本人デバイス内、サーバ送信なし)。第三者スクリプト侵入時のリスクは SRI で 1 層、Worker CORS で 1 層、`worker/index.js` の secret 隔離で 1 層、と多段化 | 〃 |
| **データ最小化** | Strava の他人データ (segments / following / club 等) は一切 fetch しない、本人 activity 一覧のみ | `public/js/strava.js` |

### localStorage を選んだ理由

HttpOnly Cookie は backend が必要。本リポは静的 SPA + Cloudflare Worker
(OAuth 中継) の構成で、Cookie を発行する backend を持たない (持つと「Worker
が user データを観測できる」状態になり ToS 上の最小化原則に反する)。
よって brower-side で完結する localStorage を選び、その既知の弱点 (XSS で
盗まれる) を SRI + CORS + secret 隔離で多段に潰す方針。

### 信頼チェーン

```
你 (visitor)
  └→ Strava (本人 OAuth、authorize 画面で scope と app を本人が確認)
  └→ Cloudflare Worker (本人デプロイ、本人 secret、本人 ALLOWED_ORIGIN)
  └→ GitHub Pages (本リポを fork してた場合は本人のコード、改造可視)
  └→ jsdelivr (Chart.js / Hammer / zoom plugin、SRI hash で改ざん検知)
  └→ Strava API (Bearer token のみ、Worker は token を保持しない)
```

どの段が compromise されても、隣接段への影響を限定する設計にしてある。
ただし「本人デバイス自体がマルウェア感染」は本ツールの防御範囲外
(localStorage を抜かれる)、これは OS / browser 側の問題。

## tests

```bash
node --test tests/pmc.test.js tests/security.test.js tests/network.test.js
```

`pmc.test.js` (PMC math) + `security.test.js` (CORS / OAuth scope / XSS / cache 分離) +
`network.test.js` (Strava 429 backoff) の 3 ファイル構成。

## commit 規約

Conventional Commits ベースに以下の project-local 拡張を許容:

- `feat:` / `fix:` / `docs:` / `style:` / `refactor:` / `test:` / `chore:` — 標準
- `ux:` — UI / UX 体験 (ユーザー視点) の変更。技術構造の `feat` / `fix` と区別する
- `sec:` — security boundary (CORS / OAuth / XSS / token 取扱) の変更。
  audit / fix の両方を含む

scope (`fix(css):` 等) はオプション。1 commit 1 関心事を原則とする。

## まとめ

このツールは「**自分のインフラの中だけで動く Fitness/Freshness グラフ**」を提供し
ます。共有サーバを持たないため、運営者がデータを観測できる経路が物理的に存在し
ません。

- **今すぐ動かしたい人** → [SETUP.md](./SETUP.md) (約 20 分、Strava App + Cloudflare Worker のデプロイ)
- **仕組みを先に見たい人** → [worker/index.js](./worker/index.js) (約 100 行の OAuth 中継) と
  [public/js/pmc.js](./public/js/pmc.js) (PMC 計算ロジック) を読めば全体像が掴めます
- **構成を fork したい人** → MIT (今後追加) に従って自由に改変可。Strava ToS と
  Cloudflare 利用規約は本人が確認すること

Strava の標準 UI に飽きた、年度比較したい、自分のデータを誰の手にも渡したくない、
そんな人向けのツールです。
