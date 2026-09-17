// 出荷依頼（UF倉庫 → FBA / RSL 補充）の計算ロジック。
//   ・teps-2 の Firestore から「UF在庫」グループの商品の在庫・BL・売上を集める
//   ・BL は teps-2 画面（ec-dashboard/src/App.tsx の blMap / calcAuto）と同じ式で計算する
//     → teps-2 側で式を変えたら、ここも合わせて直すこと
//   ・出荷数の計算（calcRequest / allocate）は画面（public/replenish.js）にも同じものがある
import { tepsGetDoc, tepsList, upperIndex } from "./teps.js";

// teps-2 useFirestoreData.ts の mergeSales と同じ（前半/後半15日も合算する版）
function mergeSales(obj, idx, keys) {
  const out = { qty: 0, qty_first15: 0, qty_last15: 0, hit: false }; if (!obj) return out;
  const seen = new Set();
  for (const key of keys) {
    const k = String(key || "").trim(); if (!k) continue;
    const real = obj[k] ? k : idx[k.toUpperCase()]; if (!real) continue;
    const d = obj[real] || {}; const primary = d.alias_of || real;
    if (seen.has(primary)) continue; seen.add(primary);
    out.hit = true; out.qty += d.qty || 0; out.qty_first15 += d.qty_first15 || 0; out.qty_last15 += d.qty_last15 || 0;
  }
  return out;
}

const str = (v) => (v == null ? "" : String(v)).trim();
const isCode = (s) => /^ADS\d{3}/i.test(str(s));

// teps-2 App.tsx と同じ既定値
export const DEFAULT_BORDER_CONFIG = {
  sale1_normal_rate: 0.15, sale1_normal_trend: 0.5,
  sale1_pre_rate: 0.45, sale1_pre_trend: 0.2,
  sale2_normal_rate: 0.20, sale2_normal_trend: 0.5,
  sale2_pre_rate: 0.30, sale2_pre_trend: 0.3,
  buffer_unsent: 1, buffer_bulk: 0,
  fbaMode: "sale1_normal", rslMode: "sale2_normal", fbaManualPct: 15, rslManualPct: 20,
};

// teps-2 App.tsx calcAuto と同じ
export function calcAuto(total30, first15, last15, baseRate, trendCoef, cfg) {
  const trendIndex = first15 > 0 ? last15 / first15 : 1.0;
  const effectiveTrend = Math.max(0, trendIndex - 1.10);
  const finalRate = baseRate + baseRate * trendCoef * effectiveTrend;
  return Math.max(2, Math.ceil(total30 * finalRate + (cfg.buffer_unsent || 0) + (cfg.buffer_bulk || 0)));
}

export function calcBL(r, cfg) {
  let fba, rsl;
  if (cfg.fbaMode === "manual") fba = Math.ceil((r.amazon30 || 0) * cfg.fbaManualPct / 100);
  else {
    const n = cfg.fbaMode !== "sale1_pre";
    fba = calcAuto(r.amazon30 || 0, r.amazonFirst15 || 0, r.amazonLast15 || 0,
      n ? cfg.sale1_normal_rate : cfg.sale1_pre_rate, n ? cfg.sale1_normal_trend : cfg.sale1_pre_trend, cfg);
  }
  if (cfg.rslMode === "manual") rsl = Math.ceil((r.rslSales30 || 0) * cfg.rslManualPct / 100);
  else {
    const n = cfg.rslMode !== "sale2_pre";
    rsl = calcAuto(r.rslSales30 || 0, r.rslFirst15 || 0, r.rslLast15 || 0,
      n ? cfg.sale2_normal_rate : cfg.sale2_pre_rate, n ? cfg.sale2_normal_trend : cfg.sale2_pre_trend, cfg);
  }
  return { fba, rsl };
}

// teps-2 から「UF在庫」グループの商品を集める → { rows: {code: {...}}, info }
export async function fetchRpSource() {
  const master = await tepsList("sku_master");
  const channels = ["shopify", "rakuten1", "rakuten2", "yahoo", "qoo10", "amazon"];
  const sales = {}, times = {};
  for (const ch of channels) {
    const d = await tepsGetDoc(`ec_sales/${ch}`);
    sales[ch] = (d && d.skus) || {}; times[ch] = (d && d.updated_at) || null;
  }
  const uf = await tepsGetDoc("inventory/uf");
  const rsl = (await tepsGetDoc("inventory/rsl")) || (await tepsGetDoc("inventory/rakuten2"));
  const bc = (await tepsGetDoc("admin_settings/border_config")) || {};
  const cfg = { ...DEFAULT_BORDER_CONFIG, ...bc };

  // FBA の入庫中数量（SP-API 同期が inventory/fba_<account> に書く。無ければ 0 のまま）
  const inv = await tepsList("inventory");
  const inbound = {}; let fbaInboundAvailable = false;
  for (const [id, d] of Object.entries(inv)) {
    if (!id.startsWith("fba_")) continue;
    fbaInboundAvailable = true;
    for (const [fnsku, it] of Object.entries((d && d.items) || {})) {
      const k = fnsku.toUpperCase();
      inbound[k] = (inbound[k] || 0) + (Number(it && it.inbound) || 0);
    }
  }

  const ufItems = {}; for (const [k, d] of Object.entries((uf && uf.items) || {})) ufItems[k.toUpperCase()] = (d && d.qty) || 0;
  const rslItems = {}; for (const [k, d] of Object.entries((rsl && rsl.items) || {})) rslItems[k.toLowerCase()] = (d && d.qty) || 0;
  const idx = {}; for (const ch of ["rakuten1", "rakuten2", "shopify", "yahoo", "qoo10"]) idx[ch] = upperIndex(sales[ch]);

  const rows = {};
  for (const [sku, data] of Object.entries(master)) {
    if (data.deleted) continue;
    if (str(data.group) !== "UF在庫") continue;
    const code = sku.toUpperCase(); if (!isCode(code)) continue;
    const amazonSku = str(data.amazon_sku);
    const r1key = str(data.rakuten1_sku) || sku, r2key = str(data.rakuten2_sku) || sku;
    const r1 = mergeSales(sales.rakuten1, idx.rakuten1, [r1key, str(data.rakuten1_sku_old)]);
    const r2 = mergeSales(sales.rakuten2, idx.rakuten2, [r2key, str(data.rakuten2_sku_old)]);
    const shop = mergeSales(sales.shopify, idx.shopify, [str(data.shopify_sku) || amazonSku, str(data.shopify_sku_old)]);
    const yahoo = mergeSales(sales.yahoo, idx.yahoo, [str(data.yahoo_sku) || amazonSku, str(data.yahoo_sku_old)]);
    const q10m = mergeSales(sales.qoo10, idx.qoo10, [str(data.qoo10_sku) || amazonSku]);
    let q10 = q10m.qty;
    if (!q10m.hit) { for (const k of Object.keys(sales.qoo10)) if (k.toUpperCase() === code) q10 = (sales.qoo10[k] && sales.qoo10[k].qty) || 0; }
    let amz = null;
    if (amazonSku) amz = sales.amazon[amazonSku] || (Object.entries(sales.amazon).find(([k]) => k.toUpperCase() === amazonSku.toUpperCase()) || [])[1] || null;
    // FBA トレンド: SP-API の前後半が無ければ Shopify で代用（teps-2 と同じ）
    const shopRaw = amazonSku ? (sales.shopify[amazonSku] || (Object.entries(sales.shopify).find(([k]) => k.toUpperCase() === amazonSku.toUpperCase()) || [])[1]) : null;
    const trendSrc = amz && amz.qty_first15 !== undefined ? amz : shopRaw;

    const r = {
      code,
      name: str(data.name), variation: str(data.variant),
      amazonSku,
      amazon30: (amz && amz.qty) || data.amazon30 || 0,
      amazonFirst15: (trendSrc && trendSrc.qty_first15) || 0,
      amazonLast15: (trendSrc && trendSrc.qty_last15) || 0,
      rslSales30: r1.qty + r2.qty + q10 + yahoo.qty + shop.qty,
      rslFirst15: (r1.qty_first15 || 0) + (r2.qty_first15 || 0),
      rslLast15: (r1.qty_last15 || 0) + (r2.qty_last15 || 0),
      fbaStock: Number(data.fba_stock) || 0,
      fbaInbound: amazonSku ? (inbound[amazonSku.toUpperCase()] || 0) : 0,
      rslStock: Number(rslItems[r1key.toLowerCase()] ?? rslItems[r2key.toLowerCase()] ?? data.rsl_stock ?? 0) || 0,
      ufStock: ufItems[code] || 0,
    };
    const bl = calcBL(r, cfg);
    r.fbaBL = bl.fba; r.rslBL = bl.rsl;
    rows[code] = r;
  }
  return {
    rows,
    info: {
      ufUpdated: (uf && uf.updated_at) || null,
      rslUpdated: (rsl && rsl.updated_at) || null,
      salesUpdated: times,
      fbaInboundAvailable,
      borderMode: { fba: cfg.fbaMode, rsl: cfg.rslMode },
    },
  };
}

// ---- 未着の自動推定 ----
// 基準 = まだ着いていない出荷のうち一番古いもの（base）
// 入庫推定数 = 今の在庫 − base 確定時の在庫 ＋ base 確定からの経過日数 × 1日あたり売上
//             − base より前に確定し、base 確定後に着荷済みにした出荷の数量（二重に数えないため）
// 古い出荷から順に当てはめ、残数の threshold（既定 90%）以上なら「着荷候補」
const OPEN = new Set(["in_transit", "partial", "candidate"]);
const ts = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
export function estimateArrivals(inbounds, row, channel, threshold = 0.9, now = new Date()) {
  const stock = channel === "fba" ? row.fbaStock : row.rslStock;
  const daily = (channel === "fba" ? row.amazon30 : row.rslSales30) / 30;
  const open = inbounds.filter((x) => OPEN.has(x.status))
    .sort((a, b) => (ts(a.confirmedAt) || 0) - (ts(b.confirmedAt) || 0));
  if (!open.length) return [];
  const base = open[0];
  const baseAt = ts(base.confirmedAt) || new Date(base.shipDate + "T00:00:00+09:00");
  const days = Math.max(0, (now - baseAt) / 86400000);
  let arrived = stock - (Number(base.stockAtConfirm) || 0) + daily * days;
  for (const x of inbounds) {
    if (OPEN.has(x.status) || x.status === "cancelled") continue;
    const c = ts(x.confirmedAt), r = ts(x.receivedAt);
    if (c && r && c < baseAt && r > baseAt) arrived -= Number(x.receivedQty) || 0;
  }
  const out = [];
  for (const x of open) {
    const rest = (Number(x.qty) || 0) - (Number(x.receivedQty) || 0);
    if (rest <= 0) continue;
    if (arrived >= rest * threshold) { out.push({ id: x._id, estimated: Math.round(Math.min(arrived, rest)) }); arrived -= rest; }
    else break;
  }
  return out;
}
