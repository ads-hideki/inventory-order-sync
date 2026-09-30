# 一元管理システム — サーバー側の同期（GitHub Actions）

在庫・発注 一元管理システムの**サーバー側の同期**だけを収めた公開リポジトリです。
2 つの同期が入っています。

| 同期 | 役割 | 実行（JST） |
|---|---|---|
| `sync.js`（daily-sync） | 販売数・在庫の取り込みと必要発注数の計算（発注ダッシュボード用） | 8:30〜12:30 の毎時30分（1日5回） |
| `rp_sync.js`（rp-sync） | UF出荷依頼（UF倉庫 → FBA / RSL 補充）のデータ作成と未着の照合 | 8:45・9〜12 時台の毎時 15 分・0:15 |

> Webアプリ本体・商品データ・発注先名などの業務情報は含みません（Firebaseへ直接デプロイ）。
> 認証情報は **GitHub Secrets** から渡します（コードには一切書きません）。

## 起動のしかた
- どちらも `workflow_dispatch` で実行します。定刻の起動は **ec-dashboard の VPS（さくらのVPS）の cron** が行います
  （設定は ec-dashboard の `docs/vps/crontab.txt`）。GitHub の `schedule` は混雑時に数時間ずれるため使いません。
- 手動実行: GitHub → Actions → daily-sync（または rp-sync）→ Run workflow。追加の引数を入れられます（下記）。

## 必要な Secrets（Settings → Secrets and variables → Actions）
| Secret | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 在庫システム（annedansemua-inventory-order）のサービスアカウント鍵（JSONの中身） |

※ 以前使っていた `SALES_SHEET_ID` / `OFFICE_SHEET_ID` / `WAREHOUSE_ID` / `WAREHOUSE_PASS` は使っていません（削除してOK）。

---

## daily-sync（販売数・在庫・必要発注数）

teps-2（EC 売上・在庫管理 https://teps-2.web.app）の Firestore から読み込み、必要発注数を計算して Firestore に書きます。
**スプレッドシートや倉庫システムへのログインは使いません。**

```
.github/workflows/daily-sync.yml
sync/
  sync.js          … エントリポイント
  lib/
    teps.js        … teps-2 の Firestore（REST・読み取りに認証不要）から販売数・在庫を取得
    reorder.js     … 必要発注数の計算（画面の app.js calc() と同じ式）
    firestore.js   … Firestore の読み書き・画面用のまとめ文書の作成
    config.js      … 既定値・引数
```

### 取り込むデータ
| データ | teps-2 側 | teps-2 の更新 | この同期での扱い |
|---|---|---|---|
| 直近30日販売数 | `ec_sales/*` ＋ `sku_master` | 9〜21時の毎時＋0時・6時 | 毎回。teps-2 の画面の「30日合計」と同じ突合で計算（`sku_master.total30` は古い値が残るので使わない） |
| FBA在庫・RSL在庫 | `sku_master.fba_stock`・`inventory/rsl` | 同上 | 毎回 |
| 事務所在庫・UF倉庫在庫 | `inventory/jimusho`・`inventory/uf` | 毎日 8:00 | **その日の最初の回（8:30）だけ**。9:30〜12:30 の回は 8:30 に取り込んだ値をそのまま使う |

- 8:30 の回が失敗した日は、次の回で事務所・UF在庫を取り込みます（`cache/meta.stockDate` で判定）。
- 商品の一覧は teps-2 の `sku_master`（削除済みを除く）です。

### 1回の実行でやること
1. teps-2 から取得（上の表）
2. `orders`（生産中・輸送中）・`settings/borders`（ボーダー・ロット・リードタイム・非表示）・`settings/deleted` を読む
3. 必要発注数を計算して `products/{商品コード}` に書く（`syncedAt` を付ける。`updatedAt` は付けない ※下記）
4. **teps-2 で削除された（teps-2 に無い）商品**に `products.tepsDeleted = true` を付ける → 画面では自動で非表示。
   teps-2 で有効な商品は毎回 `tepsDeleted = false`（復活すれば自動で表示に戻る）。手動追加の商品は対象外
5. 毎月1日（日本時間）の最初の回だけ、直近30日販売数を `salesHistory/YYYY-MM` に記録（販売推移の画面用）
6. 約1年（400日）より前の操作ログ・完了した発注を削除
7. `settings/system`（最終同期）と、画面用の**まとめ文書** `cache/*` を作り直す

### 必要発注数
```
在庫       = 事務所 + UF倉庫 + FBA + RSL
引当合計   = 在庫 + 輸送中 + 生産中
発注するか = 引当合計 < 直近30日販売 × ボーダー（ヶ月）   ※非表示の商品は発注しない
発注数     = 切上( 直近30日販売 × (ボーダー + リードタイム日数/30) − 引当合計 , 発注ロット )
```
「入庫までの間も売れる」ので、リードタイム分を上乗せして積みます（2026-09 の現行運用の分析結果に合わせた式）。
**画面の `public/app.js` の `calc()` と同じ式にすること。**

### 画面用のまとめ文書（読み取り回数の削減）
画面は商品・発注・テンプレートを 1 件ずつ全部読むと Firestore の無料枠を超えるため、
同期の最後に `cache/{products|orders|templates}_{buildId}_{n}`（約700KBずつ）と `cache/meta` を作ります。
画面はこれを localStorage にキャッシュし、以後は `updatedAt` が新しい文書だけを差分で読みます。

- **画面から書く `orders` / `products` / `templates` には必ず `updatedAt` を付ける**（差分として他の端末に届く）
- **同期が書く `products` には `updatedAt` を付けない**（付けると毎回全商品が差分扱いになり、読み取りが増える）
- ec-dashboard の OEM 追跡が「お届け済み」にする時も `updatedAt` を付けている

### 引数（ローカル実行・GitHub の手動実行の両方で使える）
```bash
cd sync && npm install
node sync.js --dry-run     # 書き込まず計算だけ（Firebase鍵不要）
node sync.js               # 本番書き込み（sync/serviceAccount.json を使用）
node sync.js --full        # 9:30 以降でも事務所在庫・UF在庫を teps-2 から取り直す
node sync.js --cache-only  # まとめ文書だけ作り直す（画面の表示がおかしい時）
node sync.js --snapshot    # 1日でなくても販売推移を記録する
```

### Firestore の使用量（目安・2026-09-30 実測）
| | 1回あたり | 1日（5回＋画面・出荷依頼） | 1日の無料枠 |
|---|---|---|---|
| 読み取り | 約1,800件 | 約1万件 | 5万件 |
| 書き込み | 約600件 | 約3,000件 | 2万件 |

GitHub Actions は公開リポジトリのため無料。teps-2 側の読み取りは1回あたり約600件。

---

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
3. 輸送中（`orders` の status=transit）の入荷予定を集計 → `rp_data/latest.incoming`（コンテナは追跡不可なので `eta`＝お届け予定日で判断）。0 時台の回だけ、前日分の在庫を `rp_channel_daily/YYYYMMDD` に保存
4. 未着の照合
   - **FBA**: Amazon の入庫中数量（teps-2 の `inventory/fba_*` の `inbound`）で判定。
     入庫中に現れた出荷に `amazonSeen` を立て、入庫中が減った分を古い出荷から着荷済みにする（全自動）
   - **RSL**: 在庫の増え方から「着荷候補」を推定するだけ。着荷済みにするのは人。画面から出荷日ごとにまとめて手動で未着を追加することもできる

- 発注管理の画面で入れたコンテナのお届け予定日は、**次の rp-sync の実行で**出荷依頼の入荷予定に反映されます（午後に入れた分は翌 0:15）。

BL（ボーダーライン）は teps-2 の画面（`ec-dashboard/src/App.tsx` の `calcAuto`）と同じ式で計算し、
`admin_settings/border_config` のモード（通常／セール前／手動%）に従います。
**teps-2 側で式を変えたら `lib/rp.js` も合わせて直すこと。**

Firestore の読み書きは 1 回の実行で読み取り3件・書き込み1〜3件に収まるよう、
商品ごとのデータを 1 ドキュメントにまとめています（商品ごとに1ドキュメントにすると無料枠を使い切ります）。

```bash
node rp_sync.js --dry-run  # 出荷依頼: teps-2 から読むだけ
node rp_sync.js            # 出荷依頼: 本番書き込み
node rp_sync.js --daily    # 0時台でなくても在庫履歴を保存
node rp_seed.js            # 入数の初期投入（data/rp_seed.json が必要）
```

---

## 注意: teps-2 が読んでいるスプレッドシート
この同期自体はスプレッドシートを使いませんが、**teps-2 の同期がスプレッドシートを読んでいます**。
- `scripts/master/master_sync.py` … 商品マスタ（品名・各モールSKU・FNSKU・新商品）を TēPs のシートから
- `scripts/inventory/jimusho_stock_sync.py` … 事務所在庫を「事務所在庫一覧」のシートから

これらのシートを廃止する時は、先に teps-2 側の取り込み元を移すこと（しないと新商品・SKU変更がこのシステムに来なくなる）。
