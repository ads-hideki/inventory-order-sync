// 全体欠品（事務所＋UF＋FBA＋RSL ＝ 0）の日数を数える（2026-10-27〜）
//   ・毎日（その日の最初の同期＝事務所・UF在庫を取り込んだ回）に stockDaily/{YYYY-MM-DD} へ型番ごとの在庫を1件記録する
//   ・直近 DAYS 日の記録から「合計が0だった日数」を型番ごとに数え、cache/stockout にまとめる（画面はこれを1件読むだけ）
//   ・自前の記録より前の日は rp_channel_daily（UF出荷依頼の同期が書く FBA/RSL/UF）で補う。事務所在庫を含まない概算なので件数を分けて持つ
//   ・発注の計算には使わない。ダッシュボードの印（基準: 画面の ORDER_RULE.stockoutDays、既定5日）だけ
import { FieldPath } from "firebase-admin/firestore";

export const STOCKOUT_DAYS = 180;      // 数える期間（日）
const KEEP_DAYS = 400;                 // stockDaily を残す日数

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => iso(new Date(Date.parse(dateStr + "T00:00:00Z") + n * 86400000));

// その日の在庫を記録（products = 同期で計算した商品の配列）
export async function recordStockDaily(db, products, date) {
  const data = {};
  for (const p of products) data[p.code] = [+p.office || 0, +p.warehouse || 0, +p.fba || 0, +p.rsl || 0];   // [事務所, UF, FBA, RSL]
  await db.collection("stockDaily").doc(date).set({ date, recordedAt: new Date(), data });
  return Object.keys(data).length;
}

// 直近 DAYS 日の欠品日数をまとめて cache/stockout に書く
export async function buildStockout(db, today, days = STOCKOUT_DAYS) {
  const from = addDays(today, -(days - 1));
  const own = await db.collection("stockDaily").where(FieldPath.documentId(), ">=", from).get();
  const ownDates = own.docs.map((d) => d.id).sort(); const firstOwn = ownDates[0] || null;
  const zero = {}, last = {}; let counted = 0;
  const count = (date, totals) => { counted++; for (const [code, t] of Object.entries(totals)) { if (t === 0) { zero[code] = (zero[code] || 0) + 1; if (!last[code] || date > last[code]) last[code] = date; } } };
  own.forEach((d) => { const data = d.data().data || {}; const m = {}; for (const c of Object.keys(data)) m[c] = (data[c] || []).reduce((a, b) => a + (+b || 0), 0); count(d.id, m); });
  // 自前の記録より前は rp_channel_daily（FBA/RSL/UF のみ）
  let approxDays = 0;
  const rp = await db.collection("rp_channel_daily").where(FieldPath.documentId(), ">=", from.replace(/-/g, "")).get();
  rp.forEach((d) => {
    const date = `${d.id.slice(0, 4)}-${d.id.slice(4, 6)}-${d.id.slice(6, 8)}`;
    if (firstOwn && date >= firstOwn) return;
    const data = d.data().data || {}; const m = {};
    for (const c of Object.keys(data)) { const x = data[c] || {}; m[c] = (+x.uf || 0) + (+x.fba || 0) + (+x.rsl || 0); }
    count(date, m); approxDays++;
  });
  const items = {}; for (const c of Object.keys(zero)) items[c] = { z: zero[c], last: last[c] };
  await db.collection("cache").doc("stockout").set({ updatedAt: new Date(), days, from, counted, approxDays, firstOwn, items });
  // 古い stockDaily は消す（約1年より前）
  const old = await db.collection("stockDaily").where(FieldPath.documentId(), "<", addDays(today, -KEEP_DAYS)).get();
  for (const d of old.docs) await d.ref.delete();
  return { counted, approxDays, codes: Object.keys(items).length, pruned: old.size };
}
