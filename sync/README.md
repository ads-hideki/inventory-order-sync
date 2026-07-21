# 一元管理システム — 日次同期（GitHub Actions）

在庫・発注 一元管理システムの**サーバー側の日次同期**だけを収めた公開リポジトリです。
毎朝、①販売数・事務所在庫スプレッドシート、②倉庫システムの在庫を読み込み、
必要発注数を計算して Firestore に反映します。

> Webアプリ本体・商品データ・発注先名などの業務情報は含みません（Firebaseへ直接デプロイ）。
> 認証情報・シートIDはすべて **GitHub Secrets** から渡します（コードには一切書きません）。

## 仕組み
```
.github/workflows/daily-sync.yml … 毎朝6:00(JST)に実行 + 手動実行(workflow_dispatch)
sync/
  sync.js          … エントリポイント
  lib/
    sheets.js      … Googleスプレッドシート(CSV)取得
    reorder.js     … 必要発注数の計算
    warehouse.js   … 倉庫システム自動ログイン→zip取得→xlsx解析
    firestore.js   … Firestore書き込み
```

## 必要な Secrets（Settings → Secrets and variables → Actions）
| Secret | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebaseサービスアカウント鍵(JSONの中身) |
| `SALES_SHEET_ID` | 売上管理スプレッドシートのID |
| `OFFICE_SHEET_ID` | 事務所在庫スプレッドシートのID |
| `WAREHOUSE_ID` | 倉庫システムのログインID |
| `WAREHOUSE_PASS` | 倉庫システムのパスワード |

## ローカル実行（テスト）
```bash
cd sync && npm install
SALES_SHEET_ID=... OFFICE_SHEET_ID=... \
WAREHOUSE_ID=... WAREHOUSE_PASS=... \
FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccount.json)" node sync.js
# 書き込まず計算だけ: 末尾に --dry-run
```
