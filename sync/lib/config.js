// 設定（環境変数で上書き可）。
//   販売数・在庫はすべて teps-2（lib/teps.js）から取得する。スプレッドシート・倉庫システムへのログインは使わない。
export const CONFIG = {
  // 発注ポリシー既定値
  defaults: { border: 2.0, lot: 100 },
  // 発注ロジックの係数（画面 public/app.js の ORDER_RULE と同じ値にすること）
  rule: {
    earlyMargin: 1.0,     // 生産中が無い品番は「ボーダー＋この月数」を切ったら発注（次の入荷予定が無いので早めに）
    momentumRatio: 1.5,   // 後半15日が前半15日のこの倍率以上なら、需要を「後半15日×2」で計算（バズ・発売直後の急伸）
    momentumMin: 15,      // 勢い補正をかける最低販売数（後半15日）。少量販売のぶれを拾わないため
    seasonPreMonths: 3,   // 季節商品: 販売開始の何ヶ月前から発注対象にするか
  },

  dryRun: process.argv.includes("--dry-run") || process.env.DRY_RUN === "1",
  snapshot: process.argv.includes("--snapshot"), // 1日以外でも月次スナップショットを強制記録
  keepa: process.argv.includes("--keepa"),       // 今日すでに取り込み済みでも、季節性の参考データ（Keepa）を取り込み直す
  full: process.argv.includes("--full"),         // 9:30 以降でも事務所在庫・UF在庫を teps-2 から取り直す
};
