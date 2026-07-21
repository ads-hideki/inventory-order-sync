// 設定（環境変数で上書き可）。スプレッドシートIDやCSVパスはここに集約。
export const CONFIG = {
  // Googleスプレッドシート（公開URLからCSVエクスポートで取得）
  // シートIDは公開しない（Secrets/環境変数から）。ローカルテストは env で指定。
  salesSheet: {
    id: process.env.SALES_SHEET_ID || "",
    gid: process.env.SALES_SHEET_GID || "1971988655",
    // 列(0始まり): A=コード, B=品名, C=カラー, D=直近30日販売, F=FBA在庫, J=RSL在庫
    col: { code: 0, name: 1, vari: 2, monthly: 3, fba: 5, rsl: 9 },
  },
  officeSheet: {
    id: process.env.OFFICE_SHEET_ID || "",
    gid: process.env.OFFICE_SHEET_GID || "861529808",
    // A=品番, E=在庫数
    col: { code: 0, stock: 4 },
  },
  // 倉庫在庫: utopia.ufsystem.jp から自動ログイン→最新zip取得→xlsx解析（lib/warehouse.js）
  //   認証情報は環境変数 WAREHOUSE_ID / WAREHOUSE_PASS（GitHub Secrets）から。コードに書かない。
  warehouseId: process.env.WAREHOUSE_ID || "",
  warehousePass: process.env.WAREHOUSE_PASS || "",
  // ローカルCSVからの取込も可（テスト用）。指定時はそちらを優先。
  warehouseCsv: process.env.WAREHOUSE_CSV || "",
  warehouseCol: { code: 2, stock: 5 }, // C=商品コード, F=有効在庫数

  // 発注ポリシー既定値
  defaults: { border: 2.0, lot: 100 },

  dryRun: process.argv.includes("--dry-run") || process.env.DRY_RUN === "1",
  snapshot: process.argv.includes("--snapshot"), // 1日以外でも月次スナップショットを強制記録
};
