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
//   仕入れ基準販売数（商品マスタで入力。「これくらい売れる」という数）があれば、直近30日販売の代わりにそれを使う（勢い補正なし）
export function demandOf({ monthly, first15, last15, baseSales }) {
  if (baseSales > 0) return baseSales;
  const r = CONFIG.rule, m = monthly || 0, f = first15 || 0, l = last15 || 0;
  return (l >= r.momentumMin && l >= r.momentumRatio * Math.max(f, 1)) ? Math.max(m, l * 2) : m;
}
const SEASON_PRE_MONTHS = CONFIG.rule.seasonPreMonths;
// ---- 季節商品（商品マスタで「販売期間 ○月〜○月」を設定した商品） ----
//   発注対象になるのは「販売開始の3ヶ月前 〜 販売終了月の前月」。終了月に入ったら次のシーズン前まで発注しない
//   phase: null=通年商品 / "pre"=シーズン前の仕込み時期 / "in"=販売期間中 / "off"=シーズン外（発注しない）
export function seasonPhase(s, month) {
  const from = +s.seasonFrom, to = +s.seasonTo;
  if (!s.seasonOn || !(from >= 1 && from <= 12) || !(to >= 1 && to <= 12)) return null;
  const len = ((to - from + 12) % 12) + 1;        // 販売期間の月数
  if (((month - from + 12) % 12) < len - 1) return "in";       // 販売期間（終了月を除く）
  const before = (from - month + 12) % 12;         // 販売開始まであと何ヶ月か
  return before >= 1 && before <= SEASON_PRE_MONTHS ? "pre" : "off";
}
// 昨シーズンの平均月販。月次記録（salesHistory/YYYY-MM）は「その月の販売数」（翌月1日時点の直近30日）なので、
// 販売期間の各月の記録をそのまま使う（直近13ヶ月分から）
export function seasonBaseOf(hist, code, from, to) {
  if (!(from >= 1) || !(to >= 1)) return 0;
  const len = ((to - from + 12) % 12) + 1; const want = new Set();
  for (let i = 0; i < len; i++) want.add(((from - 1 + i) % 12) + 1);
  const vals = [];
  for (const k of Object.keys(hist || {}).sort().slice(-13)) {
    const salesMonth = +k.slice(5, 7), v = (hist[k] || {})[code];
    if (want.has(salesMonth) && v != null) vals.push(+v || 0);
  }
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
}
// 必要発注数（画面の calc() と同じ式にすること）
//   発注するか  … 引当合計（在庫＋輸送中＋生産中）が 需要×発注点 を下回ったら
//                 発注点 = ボーダー（生産中がある品番）／ ボーダー＋1ヶ月（生産中が無い品番。次の入荷予定が無いので早めに）
//   いくつ発注か … 入庫までの間も売れるので「ボーダー＋リードタイム」分まで積む。ロット単位で四捨五入（最低1ロット）
//   （2026-10-01 の実発注との比較: 発注した品番の一致 36/62 → 49/62）
//   季節商品   … シーズン外は発注しない。シーズン前は「見込み月販（無ければ昨シーズンの平均月販）」を需要に使う（仕入れ基準販売数があればそちら）
export function reorderQty({ monthly, first15, last15, baseSales, office, warehouse, fba, rsl, transit, prod, border, lot, lead, phase, seasonBase, seasonForecast }) {
  const stock = office + warehouse + fba + rsl;
  const total = stock + transit + prod;
  const actual = demandOf({ monthly, first15, last15, baseSales });
  const preBase = phase === "pre" && !(baseSales > 0) ? (seasonForecast > 0 ? seasonForecast : (seasonBase || 0)) : 0;   // 仕入れ基準販売数があればそれを優先
  const demand = Math.max(actual, preBase);
  const point = border + (prod <= 0 ? CONFIG.rule.earlyMargin : 0);
  const trigger = phase !== "off" && demand > 0 && total < demand * point;
  const raw = trigger ? demand * (border + (lead || 0) / 30) - total : 0;
  const need = raw > 0 ? Math.max(1, Math.round(raw / lot)) * lot : 0;
  return { stock, total, need, demand };
}

// 全部を統合して products 配列を生成
//   hist = 月次販売数（季節商品の昨シーズン実績用） / month = 現在の月（日本時間。1〜12）
export function computeProducts({ sales, office, warehouse, orders, policy, hist, month }) {
  const mNow = month || (new Date(Date.now() + 9 * 3600 * 1000).getUTCMonth() + 1);
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
    const baseSales = +pol.baseSales > 0 ? +pol.baseSales : 0;   // 仕入れ基準販売数（あれば直近30日販売の代わりに使う）
    const phase = seasonPhase(pol, mNow);            // 季節商品の状態（通年商品は null）
    const seasonBase = pol.seasonOn ? seasonBaseOf(hist, code, +pol.seasonFrom, +pol.seasonTo) : 0;
    const { stock, need: raw, demand } = reorderQty({ ...p, ...agg, baseSales, border, lot, lead, phase, seasonBase, seasonForecast: +pol.seasonForecast || 0 });
    const need = hidden ? 0 : raw;
    list.push({ ...p, ...agg, border, lot, lead, baseSales, stock, need, demand, seasonPhase: phase, seasonBase, folder: (code.match(/ADS(\d{3})/i) || [])[1] || null });
  }
  return list;
}
