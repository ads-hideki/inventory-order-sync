// 日次同期のエントリポイント（毎朝 8:30 JST。VPS の cron → GitHub Actions）。
//   ・最後に画面用のまとめ文書(cache/…)を作る（lib/firestore.js buildCache）
//   1) teps-2 から 販売数(直近30日)・事務所在庫・UF倉庫在庫・FBA・RSL を取得（スプレッドシートは使わない）
//   2) 生産中/輸送中をFirestoreから取得し、必要発注数を計算
//   3) products を Firestore に書き込み（--dry-run なら書き込まず表示のみ）
import { CONFIG } from "./lib/config.js";
import { computeProducts } from "./lib/reorder.js";
import { fetchTeps } from "./lib/teps.js";

async function main() {
  const t0 = Date.now();
  // まとめ文書だけ作り直す（初回導入時や、画面の表示がおかしい時の手動用）: node sync.js --cache-only
  if (process.argv.includes("--cache-only")) {
    const { initFirestore, buildCache } = await import("./lib/firestore.js");
    const r = await buildCache(initFirestore());
    console.log(`[sync] まとめ文書を作成  ${JSON.stringify(r)}`);
    return;
  }
  console.log(`[sync] 開始  dryRun=${CONFIG.dryRun}`);

  const t = await fetchTeps();
  const { sales, office, warehouse } = t;
  const jst = (s) => (s ? new Date(s).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "-");
  const whInfo = `teps-2(UF ${jst(t.info.ufUpdated)})`;
  console.log(`[sync] 読込  teps-2 商品${t.info.products}件 / 事務所 ${jst(t.info.officeUpdated)} / UF倉庫 ${jst(t.info.ufUpdated)} / RSL ${jst(t.info.rslUpdated)}`);
  if (t.info.products === 0) throw new Error("teps-2 から商品を取得できませんでした（同期を中止）");

  // Firestoreから orders と policy を取得（dryRun時はスキップ）
  let orders = [], policy = {}, db = null;
  if (!CONFIG.dryRun) {
    const { initFirestore, readOrders, readPolicy, readDeleted, writeProducts, cleanupOld, buildCache } = await import("./lib/firestore.js");
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
    // 最終同期時刻を記録（画面の「最終同期」表示用）
    const summary = `商品${products.length}件・要発注${need}品目・倉庫: ${whInfo}`;
    await db.collection("settings").doc("system").set({ updatedAt: now, lastSyncSummary: summary }, { merge: true });
    // 画面用のまとめ文書（読み取り回数削減）。最後に作るので、ここまでの書き込みがすべて入る
    const cb = await buildCache(db, { lastSyncSummary: summary });
    console.log(`[sync] まとめ文書  ${JSON.stringify(cb)}`);
    console.log(`[sync] 完了  商品${products.length}件 書込 / 要発注${need}品目 / 削除除外${deleted.size}件 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    const products = computeProducts({ sales, office, warehouse, orders, policy });
    const need = products.filter((p) => p.need > 0);
    console.log(`[sync] DRY-RUN  商品${products.length}件 / 要発注${need.length}品目`);
    console.log("  例:", need.slice(0, 8).map((p) => `${p.code} 販売${p.monthly} 在庫${p.stock} → 発注${p.need}`).join("\n      "));
  }
}

main().catch((e) => { console.error("[sync] エラー:", e); process.exit(1); });
