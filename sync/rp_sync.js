// 出荷依頼（UF倉庫 → FBA / RSL）の同期。
//   起動: VPS の cron → gh-dispatch.sh rp-sync.yml（teps-2 の同期の 15 分後）
//   1) teps-2 から「UF在庫」商品の在庫・BL・売上・UF在庫を取得 → rp_data/latest（1ドキュメントにまとめる）
//   2) 新しい UF在庫商品を rp_data/items に追加（入数は未設定のまま → 画面で「新規」表示）
//   3) 0 時台の回だけ、前日分の在庫を rp_channel_daily に保存
//   4) 未着の照合: FBA は Amazon の入庫中数量で自動判定（着荷済みまで自動）
//      RSL は在庫の増え方から推定し、着荷候補にするだけ（着荷済みにするのは人）
//   ※ Firestore の無料枠（1日 5万読み取り / 2万書き込み）に収めるため、
//     商品ごとのデータは 1 ドキュメントにまとめている。1 回の同期で読み取り3・書き込み1〜3件。
// 使い方: node rp_sync.js [--dry-run] [--daily]
import { fetchRpSource, estimateArrivals, reconcileFba } from "./lib/rp.js";

const DRY = process.argv.includes("--dry-run");
const FORCE_DAILY = process.argv.includes("--daily");
const jstNow = () => new Date(Date.now() + 9 * 3600000);   // getUTC* で JST の値が取れる
const ymd = (d) => d.toISOString().slice(0, 10);

async function main() {
  const t0 = Date.now();
  const { rows, info } = await fetchRpSource();
  const codes = Object.keys(rows).sort();
  console.log(`[rp] teps-2 読込: UF在庫商品 ${codes.length}件 / UF在庫 ${info.ufUpdated} / FBA入庫中データ ${info.fbaInboundAvailable ? "あり" : "なし"} / BLモード ${info.borderMode.fba}・${info.borderMode.rsl}`);
  if (!codes.length) throw new Error("teps-2 から UF在庫の商品を取得できませんでした（中止）");

  if (DRY) {
    for (const c of codes.slice(0, 15)) {
      const r = rows[c];
      console.log(`  ${c} UF${r.ufStock} | FBA 在庫${r.fbaStock} BL${r.fbaBL} 入庫中${r.fbaInbound} 30日${r.amazon30} | RSL 在庫${r.rslStock} BL${r.rslBL} 30日${r.rslSales30}`);
    }
    console.log("[rp] DRY-RUN のため書き込みなし");
    return;
  }

  const { initFirestore } = await import("./lib/firestore.js");
  const db = initFirestore();
  const now = new Date();
  const latestRef = db.collection("rp_data").doc("latest");
  const itemsRef = db.collection("rp_data").doc("items");

  // 1) 最新値（1ドキュメント）
  const sorted = {}; for (const c of codes) sorted[c] = rows[c];
  await latestRef.set({ rows: sorted, info, itemCount: codes.length, syncedAt: now });

  // 2) 新しい商品を rp_data/items に追加（既存の入数や名前は触らない）
  const itemsDoc = await itemsRef.get();
  const items = (itemsDoc.exists && itemsDoc.data().items) || {};
  const added = [];
  for (const c of codes) {
    if (items[c]) continue;
    items[c] = { code: c, name: rows[c].name, variation: rows[c].variation,
      fbaCaseQty: null, rslCaseQty: null, active: true, isNew: true, createdAt: now.toISOString() };
    added.push(c);
  }
  if (added.length) {
    await itemsRef.set({ items, updatedAt: now }, { merge: true });
    console.log(`[rp] 新規商品 ${added.length}件: ${added.join(", ")}`);
  }

  // 3) 日次の在庫履歴（0 時台の回 = 前日の締め）
  const j = jstNow();
  if (j.getUTCHours() === 0 || FORCE_DAILY) {
    const day = ymd(new Date(j.getTime() - 86400000)).replace(/-/g, "");
    const data = {}; for (const c of codes) data[c] = { fba: rows[c].fbaStock, rsl: rows[c].rslStock, uf: rows[c].ufStock };
    await db.collection("rp_channel_daily").doc(day).set({ date: day, recordedAt: now, data });
    console.log(`[rp] 日次履歴 ${day} を保存`);
  }

  // 4) 未着の照合（未着が無ければ読み取り2件で終わる）
  const cfgDoc = await db.collection("rp_settings").doc("config").get();
  const cfg = cfgDoc.exists ? cfgDoc.data() : {};
  const ibSnap = await db.collection("rp_inbound").where("status", "in", ["in_transit", "partial", "candidate"]).get();
  const groups = {};
  for (const d of ibSnap.docs) { const x = { _id: d.id, ...d.data() }; (groups[`${x.code}|${x.channel}`] ||= []).push(x); }
  let candidates = 0, seenCount = 0, receivedCount = 0;
  const batch = db.batch();
  const ref = (id) => db.collection("rp_inbound").doc(id);
  for (const [key, list] of Object.entries(groups)) {
    const [code, channel] = key.split("|"); if (!rows[code]) continue;

    if (channel === "fba" && info.fbaInboundAvailable) {
      // FBA: Amazon の入庫中数量（inventory/fba_* の inbound）で照合する
      const { seen, received } = reconcileFba(list, rows[code].fbaInbound);
      for (const id of seen) { batch.update(ref(id), { amazonSeen: true, amazonSeenAt: now }); seenCount++; }
      for (const r of received) {
        batch.update(ref(r.id), r.full
          ? { status: "received", receivedQty: r.receivedQty, receivedAt: now, receivedBy: "amazon" }
          : { status: "partial", receivedQty: r.receivedQty, updatedAt: now, updatedBy: "amazon" });
        receivedCount++;
      }
      continue;
    }

    // RSL（および Amazon 連携が使えないとき）: 在庫の増え方から着荷候補を推定する
    for (const e of estimateArrivals(list, rows[code], channel, cfg.arrivalThreshold ?? 0.9, now)) {
      const x = list.find((y) => y._id === e.id);
      if (x.status === "in_transit") { batch.update(ref(e.id), { status: "candidate", candidateAt: now, estimatedQty: e.estimated }); candidates++; }
    }
  }
  const writes = candidates + seenCount + receivedCount;
  if (writes) await batch.commit();
  if (seenCount) console.log(`[rp] Amazonが納品を把握: ${seenCount}件`);
  if (receivedCount) console.log(`[rp] FBA着荷（Amazon判定）: ${receivedCount}件`);
  if (candidates) console.log(`[rp] RSL着荷候補: ${candidates}件`);

  console.log(`[rp] 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s（読み取り ${3 + ibSnap.size}件 / 書き込み ${1 + (added.length ? 1 : 0) + writes}件）`);
}

main().catch((e) => { console.error("[rp] エラー:", e); process.exit(1); });
