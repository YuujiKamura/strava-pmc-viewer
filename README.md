# strava-pmc-viewer

Strava の Fitness (CTL) / Freshness (TSB) / Fatigue (ATL) を、自由にズームしたり
過去年度と比較したりして眺めるためのビューア。

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

## tests

```bash
node --test tests/
```
