// 出荷依頼（UF倉庫 → FBA / RSL）の同期。
//   起動: VPS の cron → gh-dispatch.sh rp-sync.yml（teps-2 の同期の 15 分後）
//   1) teps-2 から「UF在庫」商品の在庫・BL・売上・UF在庫を取得 → rp_channel_latest
//   2) 新しい UF在庫商品を rp_items に追加（入数は未設定のまま → 画面で「新規」表示）
//   3) 0 時台の回だけ、前日分の在庫を rp_channel_daily に保存
//   4) 未着の自動推定（着荷候補にするだけ。着荷済みにするのは人）
//   5) 確定済みの出荷依頼をスプレッドシートに出力 ＋ 未着一覧タブを更新
// 使い方: node rp_sync.js [--dry-run] [--daily]
import { fetchRpSource, estimateArrivals } from "./lib/rp.js";

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
  const { FieldValue } = await import("firebase-admin/firestore");
  const db = initFirestore();
  const now = new Date();

  // 1) 最新値
  const latestSnap = await db.collection("rp_channel_latest").get();
  let batch = db.batch(), n = 0;
  const flush = async () => { if (n) { await batch.commit(); batch = db.batch(); n = 0; } };
  for (const c of codes) {
    batch.set(db.collection("rp_channel_latest").doc(c), { ...rows[c], inSource: true, syncedAt: now });
    if (++n >= 450) await flush();
  }
  for (const d of latestSnap.docs) {
    if (!rows[d.id] && d.data().inSource !== false) { batch.update(d.ref, { inSource: false, syncedAt: now }); if (++n >= 450) await flush(); }
  }
  await flush();

  // 2) 新しい商品を rp_items に追加
  const itemsSnap = await db.collection("rp_items").get();
  const have = new Set(itemsSnap.docs.map((d) => d.id));
  const added = [];
  for (const c of codes) {
    if (have.has(c)) continue;
    batch.set(db.collection("rp_items").doc(c), {
      code: c, name: rows[c].name, variation: rows[c].variation,
      fbaCaseQty: null, rslCaseQty: null, active: true, isNew: true, createdAt: now,
    });
    added.push(c); if (++n >= 450) await flush();
  }
  await flush();
  if (added.length) console.log(`[rp] 新規商品 ${added.length}件: ${added.join(", ")}`);

  // 3) 日次の在庫履歴（0 時台の回 = 前日の締め）
  const j = jstNow();
  if (j.getUTCHours() === 0 || FORCE_DAILY) {
    const day = ymd(new Date(j.getTime() - 86400000)).replace(/-/g, "");
    const data = {}; for (const c of codes) data[c] = { fba: rows[c].fbaStock, rsl: rows[c].rslStock, uf: rows[c].ufStock };
    await db.collection("rp_channel_daily").doc(day).set({ date: day, recordedAt: now, data });
    console.log(`[rp] 日次履歴 ${day} を保存`);
  }

  const cfgDoc = await db.collection("rp_settings").doc("config").get();
  const cfg = cfgDoc.exists ? cfgDoc.data() : {};

  // 4) 未着の自動推定
  const since = new Date(Date.now() - 60 * 86400000);
  const ibSnap = await db.collection("rp_inbound").where("confirmedAt", ">=", since).get();
  const groups = {};
  for (const d of ibSnap.docs) { const x = { _id: d.id, ...d.data() }; (groups[`${x.code}|${x.channel}`] ||= []).push(x); }
  let candidates = 0;
  for (const [key, list] of Object.entries(groups)) {
    const [code, channel] = key.split("|"); if (!rows[code]) continue;
    for (const e of estimateArrivals(list, rows[code], channel, cfg.arrivalThreshold ?? 0.9, now)) {
      const x = list.find((y) => y._id === e.id);
      if (x.status === "in_transit") { batch.update(db.collection("rp_inbound").doc(e.id), { status: "candidate", candidateAt: now, estimatedQty: e.estimated }); candidates++; if (++n >= 450) await flush(); }
    }
  }
  await flush();
  if (candidates) console.log(`[rp] 着荷候補 ${candidates}件`);

  // 5) スプレッドシート出力
  let exported = 0, sheetMsg = "出力先未設定";
  if (cfg.spreadsheetId && process.env.FIREBASE_SERVICE_ACCOUNT) {
    const { sheetsClient, writeInstruction, appendHistory, writeInTransit } = await import("./lib/rp_sheets.js");
    const sc = sheetsClient(process.env.FIREBASE_SERVICE_ACCOUNT);
    try {
      const reqSnap = await db.collection("rp_requests").where("status", "==", "confirmed").get();
      for (const d of reqSnap.docs) {
        const req = { _id: d.id, ...d.data() };
        const r = await writeInstruction(sc, cfg.spreadsheetId, req);
        const h = await appendHistory(sc, cfg.spreadsheetId, req, r.title);
        await d.ref.update({ status: "exported", exportedAt: now, sheetTab: r.title, exportError: FieldValue.delete() });
        console.log(`[rp] 出力 ${r.title}: ${r.count}品目 / 履歴${h}行`);
        exported++;
      }
      const open = ibSnap.docs.map((d) => ({ _id: d.id, ...d.data() }))
        .filter((x) => ["in_transit", "partial", "candidate"].includes(x.status))
        .sort((a, b) => a.shipDate.localeCompare(b.shipDate) || a.code.localeCompare(b.code));
      await writeInTransit(sc, cfg.spreadsheetId, open);
      sheetMsg = `出力${exported}件`;
    } catch (e) {
      sheetMsg = `出力エラー: ${e.message}`;
      console.error("[rp] スプレッドシート出力エラー:", e.message, `（${sc.email} に編集権限があるか確認）`);
    }
  } else if (!process.env.FIREBASE_SERVICE_ACCOUNT) sheetMsg = "鍵が環境変数に無いため出力スキップ";

  await db.collection("rp_settings").doc("system").set({
    lastSyncAt: now, info, itemCount: codes.length, lastSheetResult: sheetMsg,
  }, { merge: true });
  console.log(`[rp] 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s / ${sheetMsg}`);
}

main().catch((e) => { console.error("[rp] エラー:", e); process.exit(1); });
