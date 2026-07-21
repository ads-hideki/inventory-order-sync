// 日次同期のエントリポイント。
//   GitHub Actions / Cloud Functions / ローカル手動  いずれからも呼べる。
//   1) 販売数・事務所在庫スプレッドシート、倉庫CSVを読み込み
//   2) 生産中/輸送中をFirestoreから取得し、必要発注数を計算
//   3) products を Firestore に書き込み（--dry-run なら書き込まず表示のみ）
import { CONFIG } from "./lib/config.js";
import { fetchSheet, readLocalCSV } from "./lib/sheets.js";
import { buildFromSales, officeMap, warehouseMap, computeProducts } from "./lib/reorder.js";

async function main() {
  const t0 = Date.now();
  console.log(`[sync] 開始  dryRun=${CONFIG.dryRun}`);

  const salesRows = await fetchSheet(CONFIG.salesSheet.id, CONFIG.salesSheet.gid);
  const officeRows = await fetchSheet(CONFIG.officeSheet.id, CONFIG.officeSheet.gid);
  const sales = buildFromSales(salesRows);
  const office = officeMap(officeRows);

  // 倉庫在庫: ①ローカルCSV指定があればそれ、②倉庫システムから自動取得、③無ければ据え置き
  let warehouse = {}, whInfo = "なし(据置)";
  if (CONFIG.warehouseCsv) {
    warehouse = warehouseMap(readLocalCSV(CONFIG.warehouseCsv)); whInfo = `ローカルCSV(${Object.keys(warehouse).length}件)`;
  } else if (CONFIG.warehouseId && CONFIG.warehousePass) {
    try {
      const { fetchWarehouseStock } = await import("./lib/warehouse.js");
      const r = await fetchWarehouseStock(CONFIG.warehouseId, CONFIG.warehousePass);
      warehouse = r.map; whInfo = `倉庫システム(${r.filename}・${r.count}件)`;
    } catch (e) { whInfo = `倉庫取得エラー(${e.message}) → 据え置き`; console.error("[sync] 倉庫取得失敗:", e.message); }
  }
  console.log(`[sync] 読込  販売=${salesRows.length}行 事務所=${officeRows.length}行 倉庫=${whInfo}`);

  // Firestoreから orders と policy を取得（dryRun時はスキップ）
  let orders = [], policy = {}, db = null;
  if (!CONFIG.dryRun) {
    const { initFirestore, readOrders, readPolicy, readDeleted, writeProducts, cleanupOld } = await import("./lib/firestore.js");
    db = initFirestore();
    orders = await readOrders(db);
    policy = await readPolicy(db);
    const deleted = new Set(await readDeleted(db));   // 画面で削除された商品は復活させない
    let products = computeProducts({ sales, office, warehouse, orders, policy });
    products = products.filter((p) => !deleted.has(p.code));
    await writeProducts(db, products);
    // 毎月1日: 直近30日販売数のスナップショットを記録（発注目安の推移用）
    const now = new Date();
    if (now.getDate() === 1 || CONFIG.snapshot) {
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const data = {}; products.forEach((p) => { data[p.code] = p.monthly; });
      await db.collection("salesHistory").doc(month).set({ month, recordedAt: now, data });
      console.log(`[sync] 月次スナップショット記録: ${month}（${Object.keys(data).length}商品）`);
    }
    // 古い履歴・完了発注を整理（約1年より前）
    const cu = await cleanupOld(db);
    if (cu.delHist || cu.delOrd) console.log(`[sync] 整理  ${cu.cutoff}以前を削除: 履歴${cu.delHist}件 / 完了発注${cu.delOrd}件`);
    const need = products.filter((p) => p.need > 0).length;
    console.log(`[sync] 完了  商品${products.length}件 書込 / 要発注${need}品目 / 削除除外${deleted.size}件 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    const products = computeProducts({ sales, office, warehouse, orders, policy });
    const need = products.filter((p) => p.need > 0);
    console.log(`[sync] DRY-RUN  商品${products.length}件 / 要発注${need.length}品目`);
    console.log("  例:", need.slice(0, 8).map((p) => `${p.code} 販売${p.monthly} 在庫${p.stock} → 発注${p.need}`).join("\n      "));
  }
}

main().catch((e) => { console.error("[sync] エラー:", e); process.exit(1); });
