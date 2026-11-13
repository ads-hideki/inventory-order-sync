// 在庫計算書（Google スプレッドシート）への書き出し（2026-11-13〜）
//   ・1 日 1 回（その日の最初の同期＝事務所・UF在庫を取り込んだ回）に、ダッシュボードの情報を「在庫計算書」と同じ列の並びで 1 つのタブに書く
//   ・設定は Firestore `settings/zaikoSheet`（公開リポジトリにシート ID を書かないため）
//       { sheetId, tab, lastYearLabel, lastYear: {商品コード: 昨年3ヶ月平均販売数} }   sheetId が無ければ何もしない
//   ・出力先のスプレッドシートを、このシステムのサービスアカウントに「編集者」で共有しておく
//   ・書き出すだけ。スプレッドシートで入力した内容は、このシステム（Firestore・ダッシュボード）には一切戻さない（入口はダッシュボードだけ）
//   ・手入力の列（増減係数 P・発注数 W・備考 AD・輸送予定 AF）は、同じシートの中で型番ごとに残すだけ（更新しても消えない）
//   ・計算の列は式で入れる（発注数を手入力すると発注計が出る）。発注の計算には関係しない。失敗しても同期は続ける
import { JWT } from "google-auth-library";
import fs from "node:fs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
const KEEP = { P: 15, W: 22, AD: 29, AF: 31 };   // 手入力の列（0 始まりの列番号）
const COLS = 42;                                  // A〜AP

function client() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync("./serviceAccount.json") ? fs.readFileSync("./serviceAccount.json", "utf8") : "");
  if (!raw) throw new Error("サービスアカウントがありません");
  const sa = JSON.parse(raw);
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return async (method, path, body) => {
    const { token } = await jwt.getAccessToken();
    const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(j.error && j.error.message) || res.statusText}`);
    return j;
  };
}
const HEADER = ["型番", "商品名", "バリエーション", "FBA在庫", "RSL在庫", "UF在庫", "事務所\n在庫", "輸送中", "生産・\n検品中", "合計\n在庫数",
  "AMAZON\n月販売数", "楽天1\n月販売数", "楽天2\n月販売数", "Yahoo\n月販売数", "合計\n販売数", "増減係数", "昨年3ヶ月\n平均販売数", "仕入基準\n販売数",
  "倉庫残数", "在庫消化\n予測日数", "*ヶ月", "最低必要数", "発注数", "単価/\n元USD", "通貨", "単価/円", "発注計（円）", "担当",
  "発注～入庫の\n目安（日）", "備考", "", "輸送予定", "輸送予定込", "輸送中込みで何日もつか", "生産中込みで何日もつか", "", "", "日本にある在庫", "輸送中含む在庫数", "", "", "amazon割合"];

// products = 同期で計算した商品 / malls = {商品コード: [Amazon, 楽天1, 楽天2, Yahoo]} / policy = settings/borders / snap = 前回の商品（手動追加の商品を拾う）
export async function writeZaikoSheet(db, { products, malls, policy, snap, today }) {
  const cfg = (await db.collection("settings").doc("zaikoSheet").get()).data();
  if (!cfg || !cfg.sheetId) return null;
  const id = cfg.sheetId, tab = cfg.tab || "在庫計算書", lastYear = cfg.lastYear || {};
  const call = client(); const q = `'${tab.replace(/'/g, "''")}'`; const enc = encodeURIComponent;

  // 単価・通貨・発注先（発注テンプレート）と為替
  const price = {}, cur = {}, sup = {};
  (await db.collection("templates").get()).forEach((d) => {
    const t = d.data(); cur[d.id] = t.cur || ""; sup[d.id] = t.sup || "";
    for (const it of t.items || []) if (it && it.code) price[it.code] = Number(it.price) || 0;
  });
  const fx = (await db.collection("settings").doc("fx").get()).data() || {};

  // 対象 = 画面に出している商品（非表示を除く）＋手動追加の商品
  const list = products.filter((p) => !(policy[p.code] && policy[p.code].hidden === true)).map((p) => ({ ...p }));
  const have = new Set(list.map((p) => p.code));
  for (const [code, d] of Object.entries((snap && snap.items) || {})) {
    if (d && d.manual && !have.has(code) && !(policy[code] && policy[code].hidden === true)) list.push({ ...d, code });
  }
  list.sort((a, b) => (a.code < b.code ? -1 : 1));

  // タブ（無ければ作る）と、手入力の列の今の値
  const meta = await call("GET", `${id}?fields=sheets.properties`);
  let sheet = (meta.sheets || []).map((s) => s.properties).find((s) => s.title === tab), created = false;
  if (!sheet) {
    const r = await call("POST", `${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: tab, gridProperties: { rowCount: list.length + 30, columnCount: COLS + 2 } } } }] });
    sheet = r.replies[0].addSheet.properties; created = true;
  }
  const keep = {};
  if (!created) {
    const cur0 = await call("GET", `${id}/values/${enc(`${q}!A3:AF`)}?valueRenderOption=FORMULA`);
    for (const r of cur0.values || []) {
      const code = String(r[0] || "").trim(); if (!/^ADS\d{3}/i.test(code)) continue;
      const k = {}; for (const [name, i] of Object.entries(KEEP)) if (r[i] !== undefined && r[i] !== "") k[name] = r[i];
      if (Object.keys(k).length) keep[code] = k;
    }
  }

  const n = (v) => Number(v) || 0;
  const row1 = Array(COLS).fill("");
  row1[0] = "在庫計算書（ダッシュボード出力）"; row1[2] = today.replace(/-/g, "/"); row1[16] = cfg.lastYearLabel || "";
  row1[22] = n(fx.RMB) || ""; row1[23] = "元"; row1[24] = n(fx.USD) || ""; row1[25] = "USD";
  const rows = [row1, HEADER];
  list.forEach((p, i) => {
    const r = i + 3, c = p.code, pol = policy[c] || {}, f = (c.match(/ADS(\d{3})/i) || [])[1] || "", m = (malls && malls[c]) || [0, 0, 0, 0], k = keep[c] || {};
    const base = n(pol.baseSales), pr = price[c] || "";
    rows.push([
      c, p.name || "", p.vari || "", n(p.fba), n(p.rsl), n(p.warehouse), n(p.office), n(p.transit), n(p.prod),
      `=SUM(D${r}:I${r})`, n(m[0]), n(m[1]), n(m[2]), n(m[3]), `=SUM(K${r}:N${r})`,
      k.P ?? "", lastYear[c] ?? "", base || "",
      `=IF(N(R${r})=0,"",J${r}/R${r})`, `=IF(O${r}=0,"",AL${r}/O${r}*30)`,
      n(p.border) || "", `=IF(OR(N(R${r})=0,N(U${r})=0),"",R${r}*U${r}-J${r})`,
      k.W ?? "", pr, pr ? cur[f] || "" : "",
      `=IF(N(X${r})=0,"",ROUNDUP(X${r}*IF(Y${r}="USD",$Y$1,IF(Y${r}="元",$W$1,1)),-1))`, `=IF(N(Z${r})=0,0,N(W${r})*Z${r})`,
      sup[f] || "", n(p.lead) || "", k.AD ?? "", "", k.AF ?? "",
      `=IF(O${r}=0,"",(AM${r}+N(AF${r}))/O${r}*30)`, `=IF(O${r}=0,"",AM${r}/O${r}*30)`, `=IF(O${r}=0,"",J${r}/O${r}*30)`,
      "", "", `=SUM(D${r}:G${r})`, `=AL${r}+H${r}`, "", "", `=IF(O${r}=0,"",K${r}/O${r})`,
    ]);
  });
  const last = rows.length;
  rows.push(["合計", "", "", ..."DEFGHIJKLMNO".split("").map((c) => `=SUM(${c}3:${c}${last})`), ...Array(11).fill(""), `=SUM(AA3:AA${last})`]);
  const L = rows.length;

  // 行が足りなければ足してから、全体を書き直す（残った古い行は消す）
  if ((sheet.gridProperties.rowCount || 0) < L + 5) {
    await call("POST", `${id}:batchUpdate`, { requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: "ROWS", length: L + 20 - (sheet.gridProperties.rowCount || 0) } }] });
  }
  await call("POST", `${id}/values/${enc(`${q}!A1:AP`)}:clear`, {});
  await call("PUT", `${id}/values/${enc(`${q}!A1`)}?valueInputOption=USER_ENTERED`, { values: rows });

  // 書式（失敗しても本体には影響させない）。列幅・固定・見出しはタブを作った時だけ（手で直した幅を戻さない）
  try {
    const sid = sheet.sheetId;
    const rng = (c0, c1, r0, r1) => ({ sheetId: sid, startRowIndex: r0, ...(r1 != null ? { endRowIndex: r1 } : {}), startColumnIndex: c0, endColumnIndex: c1 });
    const fmt = (c0, c1, r0, r1, f, fields) => ({ repeatCell: { range: rng(c0, c1, r0, r1), cell: { userEnteredFormat: f }, fields } });
    const num = (c0, c1, pattern, type = "NUMBER") => fmt(c0, c1, 2, null, { numberFormat: { type, pattern } }, "userEnteredFormat.numberFormat");
    const bg = (c0, c1, r0, r1, red, green, blue) => fmt(c0, c1, r0, r1, { backgroundColor: { red, green, blue } }, "userEnteredFormat.backgroundColor");
    const reqs = [
      num(3, 15, "#,##0"), num(16, 18, "#,##0"), num(18, 19, "0.0"), num(19, 20, "#,##0"), num(20, 21, "0.0"), num(21, 23, "#,##0"),
      num(25, 27, "#,##0"), num(31, 39, "#,##0"), num(41, 42, "0%", "PERCENT"),
      bg(9, 10, 2, L, 1, 0.95, 0.8), bg(14, 15, 2, L, 1, 0.95, 0.8),
      bg(22, 23, 2, L - 1, 1, 1, 0.6), bg(31, 32, 2, L - 1, 1, 1, 0.6),
      fmt(0, COLS, 2, null, { textFormat: { bold: false } }, "userEnteredFormat.textFormat.bold"),
      fmt(0, COLS, L - 1, L, { textFormat: { bold: true } }, "userEnteredFormat.textFormat.bold"),
      { updateCells: { rows: [{ values: [{ note: `出所: 在庫・発注 一元管理システム（在庫・輸送中・生産中・仕入基準販売数・ボーダー・リードタイム・単価・為替）と teps-2（モール別の直近30日販売数）。\n毎日1回（朝の同期）自動で書き直す。最終更新 ${today}。\n黄色の列（発注数・輸送予定）と増減係数・備考は手入力。更新しても型番ごとに残る。それ以外の列は毎日上書きされる。` }] }], fields: "note", start: { sheetId: sid, rowIndex: 0, columnIndex: 0 } } },
    ];
    if (created) {
      const dim = (dimension, s, e, pixelSize) => ({ updateDimensionProperties: { range: { sheetId: sid, dimension, startIndex: s, endIndex: e }, properties: { pixelSize }, fields: "pixelSize" } });
      reqs.push(
        { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 2, frozenColumnCount: 3 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
        fmt(0, COLS, 1, 2, { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.9, blue: 0.96 }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" },
          "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy"),
        fmt(0, 1, 0, 1, { textFormat: { bold: true, fontSize: 12 } }, "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize"),
        dim("ROWS", 1, 2, 48), dim("COLUMNS", 1, 3, 170), dim("COLUMNS", 3, COLS, 78));
    }
    await call("POST", `${id}:batchUpdate`, { requests: reqs });
  } catch (e) { console.error("[sync] 在庫計算書の書式設定はスキップ:", e.message); }
  return { rows: list.length, kept: Object.keys(keep).length, created };
}
