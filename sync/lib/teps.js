// teps-2（EC 売上・在庫管理ダッシュボード）の Firestore から在庫・販売数を取得する。
//   ・読み取りは Firestore REST API（teps-2 は読み取りにログイン不要）
//   ・30日販売数は teps-2 画面（ec-dashboard/src/hooks/useFirestoreData.ts）と同じ計算で出す
//     sku_master の total30 等は古い値が残っているため使わない
//   ・更新タイミング: 事務所在庫/UF倉庫在庫/商品マスタ=毎日8:00、売上・FBA・RSL=9〜21時毎時＋0時・6時
const PROJECT = process.env.TEPS_PROJECT_ID || "teps-2";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`;
const isCode = (s) => /^ADS\d{3}/i.test(String(s || "").trim());

// Firestore REST の型付き値 → JS 値
function val(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = val(x); return o; }
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(val);
  return null;
}
const fields = (doc) => { const o = {}; for (const [k, x] of Object.entries((doc && doc.fields) || {})) o[k] = val(x); return o; };

async function getJSON(url, retries = 4) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      last = new Error(`teps-2 取得失敗 ${res.status}: ${url.replace(BASE, "")}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw last;
}
const getDoc = async (path) => { const d = await getJSON(BASE + path); return d ? fields(d) : null; };
async function listCollection(name) {
  const out = {}; let token = "";
  do {
    const d = await getJSON(`${BASE}${name}?pageSize=300${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    for (const doc of (d && d.documents) || []) out[doc.name.split("/").pop()] = fields(doc);
    token = d && d.nextPageToken;
  } while (token);
  return out;
}

// ---- teps-2 画面と同じ売上突合 ----
function upperIndex(obj) { const idx = {}; for (const k of Object.keys(obj || {})) idx[k.toUpperCase()] = k; return idx; }
function findSales(obj, key) {
  if (!obj || !key) return 0; const u = key.toUpperCase();
  for (const k of Object.keys(obj)) if (k.toUpperCase() === u) return (obj[k] && obj[k].qty) || 0;
  return 0;
}
// 現行SKU＋旧SKUを合算（alias_of で同じ集計に2度当たったら1回だけ）
function mergeSales(obj, idx, keys) {
  const out = { qty: 0, hit: false }; if (!obj) return out;
  const seen = new Set();
  for (const key of keys) {
    const k = String(key || "").trim(); if (!k) continue;
    const real = obj[k] ? k : idx[k.toUpperCase()]; if (!real) continue;
    const d = obj[real] || {}; const primary = d.alias_of || real;
    if (seen.has(primary)) continue; seen.add(primary);
    out.hit = true; out.qty += d.qty || 0;
  }
  return out;
}
const itemsQty = (doc, lower) => {
  const m = {}; for (const [k, d] of Object.entries((doc && doc.items) || {})) m[lower ? k.toLowerCase() : k.toUpperCase()] = (d && d.qty) || 0;
  return m;
};

// teps-2 から全データを取得し { sales, office, warehouse, info } を返す（sync.js の既存計算にそのまま渡せる形）
export async function fetchTeps() {
  const master = await listCollection("sku_master");
  const channels = ["shopify", "rakuten1", "rakuten2", "yahoo", "qoo10", "amazon"];
  const sales = {}; const times = {};
  for (const ch of channels) { const d = await getDoc(`ec_sales/${ch}`); sales[ch] = (d && d.skus) || {}; times[ch] = d && d.updated_at; }
  const jimusho = await getDoc("inventory/jimusho");
  const uf = await getDoc("inventory/uf");
  const rsl = (await getDoc("inventory/rsl")) || (await getDoc("inventory/rakuten2"));
  const officeStock = itemsQty(jimusho), ufStock = itemsQty(uf), rslStock = itemsQty(rsl, true);
  const idx = {}; for (const ch of ["rakuten1", "rakuten2", "shopify", "yahoo", "qoo10"]) idx[ch] = upperIndex(sales[ch]);
  const str = (v) => (v == null ? "" : String(v)).trim();

  const out = {}, office = {}, warehouse = {};
  for (const [sku, data] of Object.entries(master)) {
    if (data.deleted) continue;
    const code = sku.toUpperCase(); if (!isCode(code)) continue;
    const amazonSku = str(data.amazon_sku);
    const r1key = str(data.rakuten1_sku) || sku, r2key = str(data.rakuten2_sku) || sku;
    const r1 = mergeSales(sales.rakuten1, idx.rakuten1, [r1key, str(data.rakuten1_sku_old)]).qty;
    const r2 = mergeSales(sales.rakuten2, idx.rakuten2, [r2key, str(data.rakuten2_sku_old)]).qty;
    const shop = mergeSales(sales.shopify, idx.shopify, [str(data.shopify_sku) || amazonSku, str(data.shopify_sku_old)]).qty;
    const yahoo = mergeSales(sales.yahoo, idx.yahoo, [str(data.yahoo_sku) || amazonSku, str(data.yahoo_sku_old)]).qty;
    const q10m = mergeSales(sales.qoo10, idx.qoo10, [str(data.qoo10_sku) || amazonSku]);
    const q10 = q10m.hit ? q10m.qty : findSales(sales.qoo10, sku);
    let amz = null;
    if (amazonSku) { amz = sales.amazon[amazonSku] || (Object.entries(sales.amazon).find(([k]) => k.toUpperCase() === amazonSku.toUpperCase()) || [])[1] || null; }
    const amazon30 = (amz && amz.qty) || data.amazon30 || 0;
    const total30 = r1 + r2 + q10 + yahoo + shop + amazon30;
    const rslQty = rslStock[r1key.toLowerCase()] ?? rslStock[r2key.toLowerCase()] ?? (data.rsl_stock || 0);

    out[code] = {
      code, name: str(data.name), vari: str(data.variant),
      monthly: total30, fba: Number(data.fba_stock) || 0, rsl: Number(rslQty) || 0,
      office: 0, warehouse: 0,
    };
    office[code] = officeStock[code] || 0;
    warehouse[code] = ufStock[code] || 0;
  }
  const info = {
    products: Object.keys(out).length,
    officeUpdated: jimusho && jimusho.updated_at, ufUpdated: uf && uf.updated_at, rslUpdated: rsl && rsl.updated_at,
    salesUpdated: times,
  };
  return { sales: out, office, warehouse, info };
}
