// 過去の月別販売数（Google スプレッドシート）を 1 日 1 回 cache/pastSales に取り込む。
//   ・使うのは画面の「🧧 春節用の試算」だけ（季節の係数・昨年同期間の実績）。普段の発注計算には使わない
//   ・読むだけで、シートには書かない
//   ・設定は Firestore の settings/pastSales { sheetId, tab, catTab }（シート ID はコードに書かない。無ければ何もしない）
//   ・シートの形: A 列が「型番」の行が見出し（「1月」…「12月」が並ぶ）。そのすぐ上の行に「2021年」などの年。見出しの下から型番ごとの月別販売数
//     （見出しの上に説明の行があってもよい。2026-11-25 から teps-2 が自動更新する「月別販売数（モール別・SKU別）」の「合計」タブを読む。それまでは手入力の旧シート）
//   ・カテゴリは、見出しに「カテゴリー1」の列があればそれ、無ければ catTab（「商品マスタ」タブ。型番・カテゴリー1 の列）から取る
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
export function parsePastSales(values, catValues = null) {
  const hr = values.findIndex((r) => String((r || [])[0] ?? "").trim() === "型番");
  if (hr < 1) throw new Error("見出しの行（A 列が「型番」）を見つけられませんでした");
  const h0 = values[hr - 1] || [], h1 = values[hr] || [];
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
  for (const r of values.slice(hr + 1)) {
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
  // カテゴリが月別のタブに無い時は、別タブ（型番・カテゴリー1）から
  if (catCol < 0 && catValues && catValues.length) {
    const ch = catValues[0].map((x) => String(x ?? "")), cc = ch.findIndex((x) => x.trim() === "型番"), ck = ch.findIndex((x) => /カテゴリー?\s*1/.test(x));
    if (cc >= 0 && ck >= 0) for (const r of catValues.slice(1)) { const code = String(r[cc] ?? "").trim().toUpperCase(), k = String(r[ck] ?? "").trim(); if (/^ADS\d{3}/.test(code) && k) cat[code.slice(3, 6)] = k; }
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
  let catValues = null;
  if (cfg.catTab) { try { catValues = await readValues(cfg.sheetId, `${cfg.catTab}!A1:L`); } catch (e) { console.warn("[past] カテゴリのタブを読めませんでした（カテゴリ平均は使わず全体平均になります）:", e.message); } }
  const d = parsePastSales(values, catValues);
  const codes = Object.keys(d.sales).length;
  if (codes < 50) throw new Error(`型番が少なすぎます（${codes}件）。シートの形が変わっていないか確認してください`);
  // シートの直近の月が入力途中のことがある（2026-11-25: 10月の合計がシステムの記録の約 1/4 だった）。
  // 終わった直近 2 ヶ月について、シートの合計がシステムの月次記録（salesHistory/YYYY-MM ＝ 翌月1日時点の直近30日販売）の 6 割未満なら、その月はシステムの記録で置き換える
  const patched = [];
  const [sy, sm] = d.start.split("-").map(Number), j = new Date(Date.now() + 9 * 3600 * 1000);
  for (let back = 1; back <= 2; back++) {
    const t = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth() - back, 1)), y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
    const i = (y - sy) * 12 + (m - sm), key = `${y}-${String(m).padStart(2, "0")}`;
    if (i < 0) continue;
    const sh = (await db.collection("salesHistory").doc(key).get()).data(); if (!sh || !sh.data) continue;
    let sheet = 0, sys = 0;
    for (const [c, v] of Object.entries(sh.data)) { if (d.sales[c]) { sheet += d.sales[c][i] || 0; sys += Number(v) || 0; } }
    if (sys > 0 && sheet < sys * 0.6) {
      for (const [c, v] of Object.entries(sh.data)) { if (d.sales[c]) { while (d.sales[c].length <= i) d.sales[c].push(0); d.sales[c][i] = Math.round(Number(v) || 0); } }
      if (i + 1 > d.n) d.n = i + 1;
      patched.push(key);
    }
  }
  await db.collection("cache").doc("pastSales").set({ updatedAt: new Date(), start: d.start, n: d.n, codes, patched, json: JSON.stringify({ sales: d.sales, cat: d.cat }) });
  return { codes, months: d.n, start: d.start, patched };
}
