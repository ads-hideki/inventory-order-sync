// 過去の月別販売数（Google スプレッドシート）を 1 日 1 回 cache/pastSales に取り込む。
//   ・使うのは画面の「🧧 春節用の試算」だけ（季節の係数・昨年同期間の実績）。普段の発注計算には使わない
//   ・読むだけで、シートには書かない
//   ・設定は Firestore の settings/pastSales { sheetId, tab }（シート ID はコードに書かない。無ければ何もしない）
//   ・シートの形: 1行目に「2021年」などの年（その年の最初の月の列）、2行目に「型番 / 品名 / バリ / 1月…12月 / … / カテゴリー1」、3行目から型番ごとの月別販売数
import { JWT } from "google-auth-library";
import fs from "node:fs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";

async function readValues(sheetId, range) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync("./serviceAccount.json") ? fs.readFileSync("./serviceAccount.json", "utf8") : "");
  if (!raw) throw new Error("サービスアカウントがありません");
  const sa = JSON.parse(raw);
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const { token } = await jwt.getAccessToken();
  const res = await fetch(`${API}${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(j.error && j.error.message) || res.statusText}`);
  return j.values || [];
}

const num = (x) => { if (typeof x === "number") return x; const s = String(x ?? "").replace(/,/g, "").trim(); const v = Number(s); return s && Number.isFinite(v) ? v : 0; };

// 表 → { start: "YYYY-MM", n: 月数, sales: {型番: [月別…]}, cat: {品番3桁: カテゴリ} }
export function parsePastSales(values) {
  const h0 = values[0] || [], h1 = values[1] || [];
  const cols = [];   // [{ col, y, m }]
  let year = null;
  for (let c = 0; c < h1.length; c++) {
    const ym = String(h0[c] ?? "").match(/(20\d{2})\s*年/); if (ym) year = +ym[1];
    const mm = String(h1[c] ?? "").match(/^\s*(\d{1,2})\s*月\s*$/);
    if (year && mm) cols.push({ col: c, y: year, m: +mm[1] });
  }
  if (!cols.length) throw new Error("年・月の見出しを読み取れませんでした");
  const catCol = h1.findIndex((x) => /カテゴリー?\s*1/.test(String(x ?? "")));
  const first = cols[0], idx = (y, m) => (y - first.y) * 12 + (m - first.m);
  const n = idx(cols[cols.length - 1].y, cols[cols.length - 1].m) + 1;
  const sales = {}, cat = {};
  for (const r of values.slice(2)) {
    const code = String(r[0] ?? "").trim().toUpperCase();
    if (!/^ADS\d{3}/.test(code)) continue;
    const v = new Array(n).fill(0);
    for (const c of cols) v[idx(c.y, c.m)] = Math.round(num(r[c.col]));
    // 同じ型番が 2 行ある時は、直近 12 ヶ月の数字が多い方を使う
    const recent = (a) => a.slice(-12).reduce((s, x) => s + x, 0);
    if (sales[code] && recent(v) < recent(sales[code])) continue;
    sales[code] = v;
    const k = catCol >= 0 ? String(r[catCol] ?? "").trim() : "";
    if (k) cat[code.slice(3, 6)] = k;
  }
  // 末尾の、どの型番も 0 の月は落とす（まだ来ていない月）
  let last = n - 1;
  while (last > 0 && !Object.values(sales).some((a) => a[last] > 0)) last--;
  for (const k of Object.keys(sales)) sales[k] = sales[k].slice(0, last + 1);
  return { start: `${first.y}-${String(first.m).padStart(2, "0")}`, n: last + 1, sales, cat };
}

export async function cachePastSales(db) {
  const cfg = (await db.collection("settings").doc("pastSales").get()).data();
  if (!cfg || !cfg.sheetId) return null;
  const values = await readValues(cfg.sheetId, `${cfg.tab || "合計売上"}!A1:DZ`);
  const d = parsePastSales(values);
  const codes = Object.keys(d.sales).length;
  if (codes < 50) throw new Error(`型番が少なすぎます（${codes}件）。シートの形が変わっていないか確認してください`);
  await db.collection("cache").doc("pastSales").set({ updatedAt: new Date(), start: d.start, n: d.n, codes, json: JSON.stringify({ sales: d.sales, cat: d.cat }) });
  return { codes, months: d.n, start: d.start };
}
