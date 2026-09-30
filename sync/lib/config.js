// 設定（環境変数で上書き可）。
//   販売数・在庫はすべて teps-2（lib/teps.js）から取得する。スプレッドシート・倉庫システムへのログインは使わない。
export const CONFIG = {
  // 発注ポリシー既定値
  defaults: { border: 2.0, lot: 100 },

  dryRun: process.argv.includes("--dry-run") || process.env.DRY_RUN === "1",
  snapshot: process.argv.includes("--snapshot"), // 1日以外でも月次スナップショットを強制記録
  full: process.argv.includes("--full"),         // 9:30 以降でも事務所在庫・UF在庫を teps-2 から取り直す
};
