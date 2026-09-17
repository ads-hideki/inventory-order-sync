# 一元管理システム — 日次同期（GitHub Actions）

在庫・発注 一元管理システムの**サーバー側の日次同期**だけを収めた公開リポジトリです。
毎朝8:30に、teps-2（EC 売上・在庫管理 https://teps-2.web.app）から
直近30日販売数・事務所在庫・UF倉庫在庫・FBA在庫・RSL在庫を読み込み、
必要発注数を計算して Firestore に反映します。スプレッドシートや倉庫システムへのログインは使いません。

> Webアプリ本体・商品データ・発注先名などの業務情報は含みません（Firebaseへ直接デプロイ）。
> 認証情報は **GitHub Secrets** から渡します（コードには一切書きません）。

## 仕組み
```
.github/workflows/daily-sync.yml … workflow_dispatch で実行（ec-dashboard の VPS の cron が毎朝 8:30 JST に起動）
sync/
  sync.js          … エントリポイント
  lib/
    teps.js        … teps-2 の Firestore（REST）から販売数・在庫を取得（teps-2 画面と同じ突合）
    reorder.js     … 必要発注数の計算
    firestore.js   … Firestore書き込み
```
- 定刻起動に GitHub の schedule を使わないのは、混雑時に数時間ずれるため。VPS 側の設定は ec-dashboard の `docs/vps/crontab.txt`。
- teps-2 の取込: 事務所/UF在庫・商品マスタ=毎日8:00、売上・FBA・RSL=9〜21時毎時＋0時・6時。

## 必要な Secrets（Settings → Secrets and variables → Actions）
| Secret | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebaseサービスアカウント鍵(JSONの中身) |

## ローカル実行（テスト）
```bash
cd sync && npm install
node sync.js --dry-run     # 書き込まず計算だけ（Firebase鍵不要）
node sync.js               # 本番書き込み（sync/serviceAccount.json を使用）
```
