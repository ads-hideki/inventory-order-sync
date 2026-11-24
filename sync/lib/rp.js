// 出荷依頼（UF倉庫 → FBA / RSL 補充）の計算ロジック。
//   ・teps-2 の Firestore から「UF在庫」グループの商品の在庫・BL・売上を集める
//   ・BL は teps-2 画面（ec-dashboard/src/App.tsx の blMap / calcAuto、src/sale.ts）と同じ式で計算する
//     → teps-2 側で式を変えたら、ここも合わせて直すこと
//     2026-11-24: teps-2 に後から入った設定に追随した（それまでは 30日販売×通常率＋1 のままで、セール期間の FBA BL が teps-2 の画面の約 1/3 だった）
//       ・セールプリセット（fba_preset・presets[種別].fba_mult / rsl_mult・除外/対象品番・品番別の実績倍率 sale_stats/_summary・上限 fba_mult_max）
//       ・セール日を除いた通常日平均 × 30日への換算（fba_exclude_sale_days。ec_sales/amazon の sale_days_* と qty_sale*）
//       ・トレンドの加味は 30日売上金額が trend_min_revenue 以上の SKU だけ・指数 1.0 超の分・上限 trend_max_mult
//   ・出荷数の計算（calcRequest / allocate）は画面（public/replenish.js）にも同じものがある
import { tepsGetDoc, tepsList, upperIndex } from "./teps.js";

// teps-2 useFirestoreData.ts の mergeSales と同じ（前半/後半15日も合算する版）
function mergeSales(obj, idx, keys) {
  const out = { qty: 0, qty_first15: 0, qty_last15: 0, revenue: 0, hit: false }; if (!obj) return out;
  const seen = new Set();
  for (const key of keys) {
    const k = String(key || "").trim(); if (!k) continue;
    const real = obj[k] ? k : idx[k.toUpperCase()]; if (!real) continue;
    const d = obj[real] || {}; const primary = d.alias_of || real;
    if (seen.has(primary)) continue; seen.add(primary);
    out.hit = true; out.qty += d.qty || 0; out.qty_first15 += d.qty_first15 || 0; out.qty_last15 += d.qty_last15 || 0; out.revenue += Number(d.revenue) || 0;
  }
  return out;
}

const str = (v) => (v == null ? "" : String(v)).trim();
const isCode = (s) => /^ADS\d{3}/i.test(str(s));

// teps-2 SkuTable.tsx の DEFAULT_BORDER_CONFIG と同じ既定値
export const DEFAULT_BORDER_CONFIG = {
  sale1_normal_rate: 0.15, sale1_normal_trend: 0.5,
  sale1_pre_rate: 0.45, sale1_pre_trend: 0.2,
  sale2_normal_rate: 0.20, sale2_normal_trend: 0.5,
  sale2_pre_rate: 0.30, sale2_pre_trend: 0.3,
  buffer_unsent: 1, buffer_bulk: 0,
  trend_min_revenue: 100000, trend_max_mult: 2.5,
  fba_preset: "normal", presets: {}, fba_per_model: true, fba_mult_max: 6,
  rslMode: "sale2_normal", fba_exclude_sale_days: true, fba_model_mult_mode: "recent",
};
const DEFAULT_MULT_MAX = 6, MIN_NORMAL_DAYS = 10;

// ---- teps-2 src/sale.ts と同じ ----
const baseOf = (sku) => { const m = String(sku || "").toUpperCase().match(/^([A-Z]+\d+)/); return m ? m[1] : String(sku || "").toUpperCase(); };
const activePreset = (cfg) => { const p = cfg.fba_preset || "normal"; return p === "manual" ? "normal" : p; };
function presetApplies(p, model) {
  if (!p) return true;
  const list = (p.models || []).map((m) => String(m).toUpperCase());
  if (!list.length) return p.list_mode !== "include";
  const hit = list.includes(model.toUpperCase());
  return p.list_mode === "include" ? hit : !hit;
}
function modelMult(summary, type, model, mode) {
  const v = summary && summary.by_type && summary.by_type[type] && summary.by_type[type].models && summary.by_type[type].models[model];
  if (!v) return null;
  const r = mode === "median" ? v.median : (typeof v.recent === "number" ? v.recent : v.median);
  return typeof r === "number" ? r : null;
}
export function fbaMultiplier(cfg, model, summary) {
  const preset = activePreset(cfg);
  if (preset === "normal") return 1;
  const p = cfg.presets && cfg.presets[preset];
  if (!presetApplies(p, model)) return 1;
  const max = cfg.fba_mult_max || DEFAULT_MULT_MAX, clamp = (v) => Math.min(max, Math.max(1, v));
  if (cfg.fba_per_model !== false) { const m = modelMult(summary, preset, model, cfg.fba_model_mult_mode); if (typeof m === "number" && m > 0) return clamp(m); }
  const g = p && p.fba_mult;
  return clamp(typeof g === "number" && g > 0 ? g : 1);
}
export function rslMultiplier(cfg, model) {
  const preset = activePreset(cfg);
  if (preset === "normal") return 1;
  const p = cfg.presets && cfg.presets[preset];
  if (!presetApplies(p, model)) return 1;
  const g = p && p.rsl_mult;
  return typeof g === "number" && g > 0 ? g : 1;
}
// Amazon の 30 日売上を「セール日を除いた通常日の平均 × 30 日」に換算する（w = ec_sales/amazon の窓の情報）
export function normalizeAmazon(r, w, cfg) {
  const raw = { total30: r.amazon30 || 0, first15: r.amazonFirst15 || 0, last15: r.amazonLast15 || 0 };
  if (cfg.fba_exclude_sale_days === false || !w || !(w.saleDays > 0)) return raw;
  const days = w.windowDays || 30, half = days / 2;
  if (days - w.saleDays < MIN_NORMAL_DAYS) return raw;
  const scale = (qty, saleQty, saleD, span) => { const nd = span - saleD; return nd > 0 ? Math.max(0, qty - saleQty) / nd * span : qty; };
  const total30 = scale(raw.total30, r.amazonSaleQty || 0, w.saleDays, days);
  const first15 = half - w.saleDaysFirst15 >= 3 ? scale(raw.first15, r.amazonSaleFirst15 || 0, w.saleDaysFirst15, half) : total30 / 2;
  const last15 = half - w.saleDaysLast15 >= 3 ? scale(raw.last15, r.amazonSaleLast15 || 0, w.saleDaysLast15, half) : total30 / 2;
  return { total30, first15, last15 };
}

// teps-2 App.tsx calcAuto と同じ（トレンドは売上金額が一定以上の SKU だけ・上限つき）
export function calcAuto(total30, first15, last15, rev30, baseRate, trendCoef, cfg) {
  const minRev = cfg.trend_min_revenue ?? 100000, maxMult = Math.max(1, cfg.trend_max_mult ?? 2.5);
  let factor = 1.0;
  if (rev30 >= minRev && trendCoef > 0) {
    if (first15 > 0) factor = Math.min(maxMult, 1 + trendCoef * Math.max(0, last15 / first15 - 1.0));
    else if (last15 > 0) factor = maxMult;
  }
  return Math.max(2, Math.ceil(total30 * baseRate * factor + (cfg.buffer_unsent || 0) + (cfg.buffer_bulk || 0)));
}

// ctx = { window: ec_sales/amazon の窓の情報, summary: sale_stats/_summary }
export function calcBL(r, cfg, ctx = {}) {
  const model = baseOf(r.code);
  const mult = fbaMultiplier(cfg, model, ctx.summary || null);
  const az = normalizeAmazon(r, ctx.window, cfg);
  const fba = calcAuto(az.total30, az.first15, az.last15, r.amazonRev30 || 0, (cfg.sale1_normal_rate || 0) * mult, cfg.sale1_normal_trend || 0, cfg);
  const pre = cfg.rslMode === "sale2_pre";
  const rate = (pre ? cfg.sale2_pre_rate : cfg.sale2_normal_rate) * rslMultiplier(cfg, model);
  const rsl = calcAuto(r.rslSales30 || 0, r.rslFirst15 || 0, r.rslLast15 || 0, r.rslRev30 || 0, rate, (pre ? cfg.sale2_pre_trend : cfg.sale2_normal_trend) || 0, cfg);
  return { fba, rsl, fbaMult: mult };
}

// teps-2 から「UF在庫」グループの商品を集める → { rows: {code: {...}}, info }
export async function fetchRpSource() {
  const master = await tepsList("sku_master");
  const channels = ["shopify", "rakuten1", "rakuten2", "yahoo", "qoo10", "amazon"];
  const sales = {}, times = {}; let win = null;
  for (const ch of channels) {
    const d = await tepsGetDoc(`ec_sales/${ch}`);
    sales[ch] = (d && d.skus) || {}; times[ch] = (d && d.updated_at) || null;
    if (ch === "amazon" && d) win = { saleDays: Number(d.sale_days_in_window) || 0, saleDaysFirst15: Number(d.sale_days_first15) || 0, saleDaysLast15: Number(d.sale_days_last15) || 0, windowDays: Number(d.window_days) || 30 };
  }
  // 品番ごとのセール実績倍率（セールプリセットで使う。読めなければ種別全体の倍率）
  let summary = null; try { summary = await tepsGetDoc("sale_stats/_summary"); } catch (e) { console.warn("[rp] sale_stats/_summary を読めませんでした（種別全体の倍率を使います）:", e.message); }
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
  // UF 倉庫の在庫ファイルの「入数：カートン」（teps-2 の朝8時同期が inventory/uf の items[品番].carton に入れる。無い品番は null）
  const ufCartons = {}; for (const [k, d] of Object.entries((uf && uf.items) || {})) { const n = Number(d && d.carton); if (Number.isInteger(n) && n > 0) ufCartons[k.toUpperCase()] = n; }
  const rslItems = {}; for (const [k, d] of Object.entries((rsl && rsl.items) || {})) rslItems[k.toLowerCase()] = (d && d.qty) || 0;
  const idx = {}; for (const ch of ["rakuten1", "rakuten2", "shopify", "yahoo", "qoo10"]) idx[ch] = upperIndex(sales[ch]);

  // 「旧 SKU」が別の現役 SKU の現行キーと同じなら数えない（二重計上の防止。teps-2 の画面と同じ規則。例: ADS083I〜P の旧 SKU = ADS083A〜H）
  const curKeys = { rakuten1: new Set(), rakuten2: new Set(), yahoo: new Set(), shopify: new Set() };
  for (const [sku, d] of Object.entries(master)) {
    if (d.deleted) continue;
    const amz = str(d.amazon_sku);
    curKeys.rakuten1.add((str(d.rakuten1_sku) || sku).toUpperCase()); curKeys.rakuten2.add((str(d.rakuten2_sku) || sku).toUpperCase());
    if (str(d.yahoo_sku) || amz) curKeys.yahoo.add((str(d.yahoo_sku) || amz).toUpperCase());
    if (str(d.shopify_sku) || amz) curKeys.shopify.add((str(d.shopify_sku) || amz).toUpperCase());
  }
  const oldKey = (ch, v) => { const k = str(v); return k && !curKeys[ch].has(k.toUpperCase()) ? k : ""; };

  const rows = {};
  for (const [sku, data] of Object.entries(master)) {
    if (data.deleted) continue;
    if (str(data.group) !== "UF在庫") continue;
    const code = sku.toUpperCase(); if (!isCode(code)) continue;
    const amazonSku = str(data.amazon_sku);
    const r1key = str(data.rakuten1_sku) || sku, r2key = str(data.rakuten2_sku) || sku;
    let r1 = mergeSales(sales.rakuten1, idx.rakuten1, [r1key, oldKey("rakuten1", data.rakuten1_sku_old)]);
    if (!r1.hit) r1 = mergeSales(sales.rakuten1, idx.rakuten1, [str(data.rakuten1_sku_sys), str(data.rakuten1_sku_x)]);   // 楽天1 SKU で当たらなければ SKU管理番号 / システム連携用 SKU でも探す
    const r2 = mergeSales(sales.rakuten2, idx.rakuten2, [r2key, oldKey("rakuten2", data.rakuten2_sku_old)]);
    const shop = mergeSales(sales.shopify, idx.shopify, [str(data.shopify_sku) || amazonSku, oldKey("shopify", data.shopify_sku_old)]);
    const yahoo = mergeSales(sales.yahoo, idx.yahoo, [str(data.yahoo_sku) || amazonSku, oldKey("yahoo", data.yahoo_sku_old)]);
    const q10m = mergeSales(sales.qoo10, idx.qoo10, [str(data.qoo10_sku) || amazonSku]);
    let q10 = q10m.qty;
    if (!q10m.hit) { for (const k of Object.keys(sales.qoo10)) if (k.toUpperCase() === code) q10 = (sales.qoo10[k] && sales.qoo10[k].qty) || 0; }
    // Amazon: amazon_sku で見つからなければ fnsku でも探す（teps-2 と同じ）
    const findAmazon = (key) => (key ? sales.amazon[key] || (Object.entries(sales.amazon).find(([k]) => k.toUpperCase() === key.toUpperCase()) || [])[1] || null : null);
    const amz = findAmazon(amazonSku) || findAmazon(str(data.fnsku));
    const parts = [r1, r2, yahoo, q10m, shop];   // RSL 側のトレンド・売上金額は 楽天1+楽天2+Yahoo+Qoo10+Shopify（teps-2 と同じ範囲）
    const sum = (k) => parts.reduce((a, d) => a + (d[k] || 0), 0);

    const r = {
      code,
      name: str(data.name), variation: str(data.variant),
      amazonSku,
      amazon30: (amz && amz.qty) || data.amazon30 || 0,
      amazonFirst15: (amz && amz.qty_first15) || 0,
      amazonLast15: (amz && amz.qty_last15) || 0,
      amazonRev30: Number(amz && amz.revenue) || 0,
      amazonSaleQty: (amz && amz.qty_sale) || 0, amazonSaleFirst15: (amz && amz.qty_sale_first15) || 0, amazonSaleLast15: (amz && amz.qty_sale_last15) || 0,
      rslSales30: r1.qty + r2.qty + q10 + yahoo.qty + shop.qty,
      rslFirst15: sum("qty_first15"), rslLast15: sum("qty_last15"), rslRev30: sum("revenue"),
      fbaStock: Number(data.fba_stock) || 0,
      fbaInbound: amazonSku ? (inbound[amazonSku.toUpperCase()] || 0) : 0,
      rslStock: Number(rslItems[r1key.toLowerCase()] ?? rslItems[r2key.toLowerCase()] ?? data.rsl_stock ?? 0) || 0,
      ufStock: ufItems[code] || 0,
      ufCarton: ufCartons[code] || null,
    };
    const bl = calcBL(r, cfg, { window: win, summary });
    r.fbaBL = bl.fba; r.rslBL = bl.rsl; r.fbaMult = bl.fbaMult;   // fbaMult = この品番に掛けたセール倍率（1 = 通常）
    rows[code] = r;
  }
  return {
    rows,
    info: {
      ufUpdated: (uf && uf.updated_at) || null,
      rslUpdated: (rsl && rsl.updated_at) || null,
      salesUpdated: times,
      fbaInboundAvailable,
      // 画面の「BLモード」表示用。FBA はセールプリセット（通常なら「通常（○%）」）、RSL は月2回セールのモード
      borderMode: { fba: activePreset(cfg) === "normal" ? `通常（${Math.round((cfg.sale1_normal_rate || 0) * 100)}%）` : `${activePreset(cfg)} ×${(cfg.presets && cfg.presets[activePreset(cfg)] && cfg.presets[activePreset(cfg)].fba_mult) || 1}${cfg.fba_per_model !== false ? "（品番別）" : ""}`, rsl: cfg.rslMode },
      saleWindow: win,
    },
  };
}

// ---- 未着の自動照合（FBA）: Amazon の「入庫中」の数字で判定する ----
// A = Amazon の入庫中数量（SP-API。inventory/fba_* の inbound の合計）
//   ・A が未着の合計以上 → Amazon が納品を把握した ＝ amazonSeen を立てる
//   ・その後 A が減った分 = FBA が受領した分 → 古い出荷から着荷済みにする
//   ・Amazon がまだ把握していない出荷（納品プラン作成前）は、こちらの記録のまま残す
export function reconcileFba(list, amazonInbound) {
  const open = list.filter((x) => ["in_transit", "partial", "candidate"].includes(x.status))
    .sort((a, b) => (tsOf(a.confirmedAt) || 0) - (tsOf(b.confirmedAt) || 0));
  if (!open.length) return { seen: [], received: [] };
  const rest = (x) => (Number(x.qty) || 0) - (Number(x.receivedQty) || 0);
  const openTotal = open.reduce((s, x) => s + rest(x), 0);
  const A = Number(amazonInbound) || 0;

  // まだ amazonSeen が付いていない分を Amazon が把握したか
  const seen = [];
  if (A >= openTotal) { for (const x of open) if (!x.amazonSeen) seen.push(x._id); return { seen, received: [] }; }

  // Amazon が把握済みの出荷だけを対象に、減った分を古い順で着荷にする
  if (!open.every((x) => x.amazonSeen)) return { seen: [], received: [] };
  let need = openTotal - A;
  const received = [];
  for (const x of open) {
    if (need <= 0) break;
    const r = rest(x);
    if (need >= r) { received.push({ id: x._id, receivedQty: Number(x.qty) || 0, full: true }); need -= r; }
    else { received.push({ id: x._id, receivedQty: (Number(x.receivedQty) || 0) + need, full: false }); need = 0; }
  }
  return { seen: [], received };
}

// ---- 未着の自動推定（RSL）----
// 基準 = まだ着いていない出荷のうち一番古いもの（base）
// 入庫推定数 = 今の在庫 − base 確定時の在庫 ＋ base 確定からの経過日数 × 1日あたり売上
//             − base より前に確定し、base 確定後に着荷済みにした出荷の数量（二重に数えないため）
// 古い出荷から順に当てはめ、残数の threshold（既定 90%）以上なら「着荷候補」
const OPEN = new Set(["in_transit", "partial", "candidate"]);
const tsOf = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
export function estimateArrivals(inbounds, row, channel, threshold = 0.9, now = new Date()) {
  const stock = channel === "fba" ? row.fbaStock : row.rslStock;
  const daily = (channel === "fba" ? row.amazon30 : row.rslSales30) / 30;
  const open = inbounds.filter((x) => OPEN.has(x.status))
    .sort((a, b) => (tsOf(a.confirmedAt) || 0) - (tsOf(b.confirmedAt) || 0));
  if (!open.length) return [];
  const base = open[0];
  const baseAt = tsOf(base.confirmedAt) || new Date(base.shipDate + "T00:00:00+09:00");
  const days = Math.max(0, (now - baseAt) / 86400000);
  let arrived = stock - (Number(base.stockAtConfirm) || 0) + daily * days;
  for (const x of inbounds) {
    if (OPEN.has(x.status) || x.status === "cancelled") continue;
    const c = tsOf(x.confirmedAt), r = tsOf(x.receivedAt);
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
