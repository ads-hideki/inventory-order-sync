// teps-2 から取得した販売数・在庫 → 商品ごとの必要発注数を計算
import { CONFIG } from "./config.js";

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
