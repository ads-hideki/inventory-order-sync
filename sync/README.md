# 一元管理システム — サーバー側の同期（GitHub Actions）

在庫・発注 一元管理システムの**サーバー側の同期**だけを収めた公開リポジトリです。
2 つの同期が入っています。

| 同期 | 役割 | 実行 |
|---|---|---|
| `sync.js`（daily-sync） | 必要発注数の計算（発注ダッシュボード用） | 毎朝 8:30 |
| `rp_sync.js`（rp-sync） | UF出荷依頼（UF倉庫 → FBA / RSL 補充）のデータ作成と未着の照合 | 8:45・9〜12 時台の毎時 15 分・0:15 |

## daily-sync（必要発注数）

毎朝 8:30 に、teps-2（EC 売上・在庫管理 https://teps-2.web.app）から
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

## rp-sync（UF出荷依頼）
UF倉庫からFBA・RSLへ補充する出荷依頼の画面（`public/replenish.js`）が使うデータを作ります。
teps-2 から「UF在庫」グループの商品だけを集め、在庫・BL・30日売上・UF前日在庫を 1 ドキュメントにまとめます。

```
.github/workflows/rp-sync.yml … workflow_dispatch（VPS の cron が起動）
sync/
  rp_sync.js       … エントリポイント
  rp_seed.js       … 入数・商品名・並び順の初期投入（1回だけ。data/rp_seed.json）
  lib/rp.js        … teps-2 からの取得、BL計算、未着の照合・推定
```

やっていること
1. teps-2 から取得 → `rp_data/latest`（1ドキュメント）に保存
2. 新しいUF在庫商品を `rp_data/items` に追加（入数は未設定＝画面で「新規」表示）
3. 0 時台の回だけ、前日分の在庫を `rp_channel_daily/YYYYMMDD` に保存
4. 未着の照合
   - **FBA**: Amazon の入庫中数量（teps-2 の `inventory/fba_*` の `inbound`）で判定。
     入庫中に現れた出荷に `amazonSeen` を立て、入庫中が減った分を古い出荷から着荷済みにする（全自動）
   - **RSL**: 在庫の増え方から「着荷候補」を推定するだけ。着荷済みにするのは人

BL（ボーダーライン）は teps-2 の画面（`ec-dashboard/src/App.tsx` の `calcAuto`）と同じ式で計算し、
`admin_settings/border_config` のモード（通常／セール前／手動%）に従います。
**teps-2 側で式を変えたら `lib/rp.js` も合わせて直すこと。**

Firestore の読み書きは 1 回の実行で読み取り3件・書き込み1〜3件に収まるよう、
商品ごとのデータを 1 ドキュメントにまとめています（商品ごとに1ドキュメントにすると無料枠を使い切ります）。

## ローカル実行（テスト）
```bash
cd sync && npm install
node sync.js --dry-run     # 発注: 書き込まず計算だけ（Firebase鍵不要）
node sync.js               # 発注: 本番書き込み（sync/serviceAccount.json を使用）
node rp_sync.js --dry-run  # 出荷依頼: teps-2 から読むだけ
node rp_sync.js            # 出荷依頼: 本番書き込み
node rp_sync.js --daily    # 0時台でなくても在庫履歴を保存
node rp_seed.js            # 入数の初期投入（data/rp_seed.json が必要）
```
