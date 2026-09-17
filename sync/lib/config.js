// 設定（環境変数で上書き可）。
//   販売数・在庫はすべて teps-2（lib/teps.js）から取得する。スプレッドシート・倉庫システムへのログインは使わない。
export const CONFIG = {
  // 発注ポリシー既定値
  defaults: { border: 2.0, lot: 100 },

  dryRun: process.argv.includes("--dry-run") || process.env.DRY_RUN === "1",
  snapshot: process.argv.includes("--snapshot"), // 1日以外でも月次スナップショットを強制記録
};
