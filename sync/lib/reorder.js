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

// 計算に使う月販（需要）。後半15日が前半15日の1.5倍以上に伸びている商品は「後半15日×2」を使う（勢い補正）
export function demandOf({ monthly, first15, last15 }) {
  const r = CONFIG.rule, m = monthly || 0, f = first15 || 0, l = last15 || 0;
  return (l >= r.momentumMin && l >= r.momentumRatio * Math.max(f, 1)) ? Math.max(m, l * 2) : m;
}
// 必要発注数（画面の calc() と同じ式にすること）
//   発注するか  … 引当合計（在庫＋輸送中＋生産中）が 需要×発注点 を下回ったら
//                 発注点 = ボーダー（生産中がある品番）／ ボーダー＋1ヶ月（生産中が無い品番。次の入荷予定が無いので早めに）
//   いくつ発注か … 入庫までの間も売れるので「ボーダー＋リードタイム」分まで積む。ロット単位で四捨五入（最低1ロット）
//   （2026-10-01 の実発注との比較: 発注した品番の一致 36/62 → 49/62）
export function reorderQty({ monthly, first15, last15, office, warehouse, fba, rsl, transit, prod, border, lot, lead }) {
  const stock = office + warehouse + fba + rsl;
  const total = stock + transit + prod;
  const demand = demandOf({ monthly, first15, last15 });
  const point = border + (prod <= 0 ? CONFIG.rule.earlyMargin : 0);
  const trigger = demand > 0 && total < demand * point;
  const raw = trigger ? demand * (border + (lead || 0) / 30) - total : 0;
  const need = raw > 0 ? Math.max(1, Math.round(raw / lot)) * lot : 0;
  return { stock, total, need, demand };
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
    const lead = pol.lead ?? 0;                      // 発注〜入庫の日数（商品ごと・settings/borders）
    const hidden = pol.hidden === true;             // 発注管理しない（画面の商品マスタで設定）
    const { stock, need: raw, demand } = reorderQty({ ...p, ...agg, border, lot, lead });
    const need = hidden ? 0 : raw;
    list.push({ ...p, ...agg, border, lot, lead, stock, need, demand, folder: (code.match(/ADS(\d{3})/i) || [])[1] || null });
  }
  return list;
}
