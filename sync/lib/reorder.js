// スプレッドシート/CSVの行データ → 商品ごとの在庫・必要発注数を計算
import { num } from "./sheets.js";
import { CONFIG } from "./config.js";

const isCode = (s) => /^ADS\d{3}/i.test(String(s || "").trim());

// 販売数シート → { code: {name, vari, monthly, fba, rsl} }（初出のみ・重複コード除去）
export function buildFromSales(rows) {
  const c = CONFIG.salesSheet.col, out = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const code = String(r[c.code] || "").trim().toUpperCase();
    if (!isCode(code) || out[code]) continue;
    out[code] = {
      code, name: (r[c.name] || "").trim(), vari: (r[c.vari] || "").trim(),
      monthly: num(r[c.monthly]), fba: num(r[c.fba]), rsl: num(r[c.rsl]),
      office: 0, warehouse: 0,
    };
  }
  return out;
}

// 事務所在庫シート → { code: 在庫 }
export function officeMap(rows) {
  const c = CONFIG.officeSheet.col, m = {};
  for (let i = 1; i < rows.length; i++) {
    const code = String(rows[i][c.code] || "").trim().toUpperCase();
    if (isCode(code)) m[code] = num(rows[i][c.stock]);
  }
  return m;
}

// 倉庫CSV → { code: 有効在庫数 }（同コード複数行は合算）
export function warehouseMap(rows) {
  if (!rows) return {};
  const c = CONFIG.warehouseCol, m = {};
  for (let i = 1; i < rows.length; i++) {
    const code = String(rows[i][c.code] || "").trim().toUpperCase();
    if (isCode(code)) m[code] = (m[code] || 0) + num(rows[i][c.stock]);
  }
  return m;
}

// ordersスナップショット → { code: {transit, prod} }
export function orderAgg(orders) {
  const m = {};
  for (const o of orders) {
    const code = String(o.code || "").toUpperCase();
    m[code] = m[code] || { transit: 0, prod: 0 };
    if (o.status === "transit") m[code].transit += Number(o.qty) || 0;
    else if (o.status === "production") m[code].prod += (Number(o.qty) || 0) - (Number(o.shipped) || 0);
  }
  return m;
}

// 必要発注数
export function reorderQty({ monthly, office, warehouse, fba, rsl, transit, prod, border, lot }) {
  const stock = office + warehouse + fba + rsl;
  const total = stock + transit + prod;
  const raw = Math.max(0, monthly * border - total);
  const need = raw > 0 ? Math.ceil(raw / lot) * lot : 0;
  return { stock, total, need };
}

// 全部を統合して products 配列を生成
export function computeProducts({ sales, office, warehouse, orders, policy }) {
  const oAgg = orderAgg(orders || []);
  const list = [];
  for (const code of Object.keys(sales)) {
    const p = sales[code];
    p.office = office[code] || 0;
    p.warehouse = warehouse[code] || 0;
    const agg = oAgg[code] || { transit: 0, prod: 0 };
    const pol = (policy && policy[code]) || {};
    const border = pol.border ?? CONFIG.defaults.border;
    const lot = pol.lot ?? CONFIG.defaults.lot;
    const { stock, need } = reorderQty({ ...p, ...agg, border, lot });
    list.push({ ...p, ...agg, border, lot, stock, need, folder: (code.match(/ADS(\d{3})/i) || [])[1] || null });
  }
  return list;
}
