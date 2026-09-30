// 同期のエントリポイント（8:30〜12:30 の毎時30分・1日5回 JST。VPS の cron → GitHub Actions）。
//   ・最後に画面用のまとめ文書(cache/…)を作る（lib/firestore.js buildCache）
//   1) teps-2 から 販売数(直近30日)・FBA・RSL を取得（スプレッドシートは使わない）
//      事務所在庫・UF倉庫在庫は teps-2 が 8:00 にしか更新しないので、その日の最初の回（8:30）だけ取り込む。
//      9:30〜12:30 の回は 8:30 に取り込んだ値をそのまま使う（8:30 が失敗した日は次の回で取り込む。--full で強制取込）
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
  const fs = CONFIG.dryRun ? null : await import("./lib/firestore.js");
  const db = fs ? fs.initFirestore() : null;
  const jst = (s) => (s ? new Date(s).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "-");

  // 事務所在庫・UF在庫を今回取り込むか（今日すでに取り込み済みで 9 時以降なら、前回の値を使う）
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const today = jstNow.toISOString().slice(0, 10);
  let meta = {}, kept = null, snap = null;
  if (db) {
    meta = (await db.collection("cache").doc("meta").get()).data() || {};
    snap = await fs.readSnapshotProducts(db, meta);   // 前回の商品（在庫の引き継ぎ・teps-2で削除された商品の判定に使う）
    if (!CONFIG.full && meta.stockDate === today && jstNow.getUTCHours() >= 9) kept = fs.stockFromSnapshot(snap);
  }
  const withStock = !kept;

  const t = await fetchTeps({ stock: withStock });
  const { sales } = t;
  const office = withStock ? t.office : kept.office, warehouse = withStock ? t.warehouse : kept.warehouse;
  const whInfo = withStock ? `teps-2(UF ${jst(t.info.ufUpdated)})` : `teps-2(事務所・UF在庫は ${jst(meta.stockAt && meta.stockAt.toDate ? meta.stockAt.toDate() : null)} 取込の値)`;
  console.log(`[sync] 読込  teps-2 商品${t.info.products}件 / ` +
    (withStock ? `事務所 ${jst(t.info.officeUpdated)} / UF倉庫 ${jst(t.info.ufUpdated)}` : `事務所・UF在庫は今回は取り込まない（本日取込済みの値を使用）`) +
    ` / RSL ${jst(t.info.rslUpdated)}`);
  if (t.info.products === 0) throw new Error("teps-2 から商品を取得できませんでした（同期を中止）");

  // Firestoreから orders と policy を取得（dryRun時はスキップ）
  let orders = [], policy = {};
  if (db) {
    const { readOrders, readPolicy, readDeleted, writeProducts, cleanupOld, buildCache } = fs;
    orders = await readOrders(db);
    policy = await readPolicy(db);
    const deleted = new Set(await readDeleted(db));   // 画面で削除された商品は復活させない
    let products = computeProducts({ sales, office, warehouse, orders, policy });
    products = products.filter((p) => !deleted.has(p.code));
    await writeProducts(db, products);
    // teps-2 で削除された（teps-2 に無い）商品を自動で非表示に（画面は products.tepsDeleted を見る）
    const gone = await fs.markTepsDeleted(db, snap, new Set(Object.keys(sales)));
    if (gone.length) console.log(`[sync] teps-2で削除された商品を非表示に: ${gone.length}件（${gone.slice(0, 15).join(", ")}${gone.length > 15 ? " ほか" : ""}）`);
    // 毎月1日: 直近30日販売数のスナップショットを記録（発注目安の推移用）
    const now = new Date();
    //   日付は日本時間で判定する（GitHub のサーバーは UTC なので getDate() だと日本時間の2日朝になる）
    //   1日5回動くので、その月の記録がまだ無い時（＝1日の最初の回 8:30）だけ書く
    const jst = new Date(now.getTime() + 9 * 3600 * 1000);
    const month = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
    if ((jst.getUTCDate() === 1 && !(await db.collection("salesHistory").doc(month).get()).exists) || CONFIG.snapshot) {
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
    const cb = await buildCache(db, { lastSyncSummary: summary, ...(withStock ? { stockDate: today, stockAt: now } : {}) });
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
