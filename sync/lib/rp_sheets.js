// 出荷依頼 → Google スプレッドシート出力（サービスアカウントで書き込む）
//   前提: 発注管理プロジェクトで Google Sheets API を有効化し、
//         出力先スプレッドシートをサービスアカウントの client_email に「編集者」で共有しておく
import { JWT } from "google-auth-library";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";

export function sheetsClient(serviceAccountJson) {
  const sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  async function call(method, url, body) {
    const { token } = await jwt.getAccessToken();
    const res = await fetch(url, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(j.error && j.error.message) || res.statusText}`);
    return j;
  }
  return { call, email: sa.client_email };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function sheetMap(c, id) {
  const j = await c.call("GET", `${API}${id}?fields=sheets.properties(sheetId,title)`);
  const m = {}; for (const s of j.sheets || []) m[s.properties.title] = s.properties.sheetId;
  return m;
}
async function ensureSheet(c, id, title, map) {
  if (map[title] != null) return map[title];
  const j = await c.call("POST", `${API}${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title } } }] });
  const sid = j.replies[0].addSheet.properties.sheetId; map[title] = sid; return sid;
}

// 「M月D日出荷分」タブ（今の出荷指示書と同じ並び）を作って書き込む
export async function writeInstruction(c, id, req) {
  const [, mm, dd] = req.shipDate.split("-").map(Number);   // 実行環境の時差に左右されないよう文字列から取る
  const title = `${mm}月${dd}日出荷分${req.suffix || ""}`;
  const map = await sheetMap(c, id);
  const sid = await ensureSheet(c, id, title, map);
  const lines = (req.lines || []).filter((l) => (l.fba.qty || 0) + (l.rsl.qty || 0) > 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const values = [
    ["", "出荷指示書", "", "", "", "", title, "", "株式会社アンダンスモア", "", "", "", ""],
    [],
    ["No", "型番", "商品名", "バリエーション", "amazon出荷数", "楽天出荷数", "出荷数合計", "備考", "UF前日在庫", "出荷後在庫数", "", "amazon入数", "楽天入数"],
    ...lines.map((l, i) => {
      const tot = (l.fba.qty || 0) + (l.rsl.qty || 0);
      return [i + 1, l.code, l.name, l.variation, l.fba.qty || "", l.rsl.qty || "", tot, l.noteExt || "",
        l.ufStock, l.ufStock - tot, "", l.fba.caseQty || "", l.rsl.caseQty || ""];
    }),
  ];
  await c.call("POST", `${API}${id}/values:batchClear`, { ranges: [q(title)] });
  await c.call("PUT", `${API}${id}/values/${encodeURIComponent(q(title) + "!A1")}?valueInputOption=RAW`, { values });
  await c.call("POST", `${API}${id}:batchUpdate`, {
    requests: [
      { repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }, fields: "userEnteredFormat.textFormat" } },
      { repeatCell: { range: { sheetId: sid, startRowIndex: 2, endRowIndex: 3, endColumnIndex: 13 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.87, green: 0.92, blue: 0.97 }, wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(textFormat,backgroundColor,wrapStrategy)" } },
      { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 3 } }, fields: "gridProperties.frozenRowCount" } },
      { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: "COLUMNS", startIndex: 0, endIndex: 13 } } },
    ],
  });
  return { title, count: lines.length };
}

// 「出荷履歴」タブに行を追加（今のシートの出荷履歴と同じ列）
export async function appendHistory(c, id, req, tabTitle) {
  const map = await sheetMap(c, id);
  const isNew = map["出荷履歴"] == null;
  const sid = await ensureSheet(c, id, "出荷履歴", map);
  // 確定を解除して出し直した依頼は、前回の行を消してから追加する（E列 = 依頼ID）
  if (!isNew) {
    const col = await c.call("GET", `${API}${id}/values/${encodeURIComponent(q("出荷履歴") + "!E:E")}`);
    const hit = (col.values || []).map((v, i) => (v[0] === req._id ? i : -1)).filter((i) => i >= 0).reverse();
    if (hit.length) await c.call("POST", `${API}${id}:batchUpdate`, {
      requests: hit.map((i) => ({ deleteDimension: { range: { sheetId: sid, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } })),
    });
  }
  const rows = [];
  if (isNew) rows.push(["出荷日", "型番", "出荷数", "区分", "依頼ID", "シート名", "備考"]);
  const date = req.shipDate.replace(/-/g, "/");
  for (const l of req.lines || []) {
    if (l.fba.qty > 0) rows.push([date, l.code, l.fba.qty, "AMAZON", req._id, tabTitle, l.noteExt || ""]);
    if (l.rsl.qty > 0) rows.push([date, l.code, l.rsl.qty, "RAKUTEN", req._id, tabTitle, l.noteExt || ""]);
  }
  if (!rows.length) return 0;
  await c.call("POST", `${API}${id}/values/${encodeURIComponent(q("出荷履歴") + "!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
  return rows.length - (isNew ? 1 : 0);
}

// 「未着一覧」タブを丸ごと書き換える
export async function writeInTransit(c, id, list) {
  const map = await sheetMap(c, id);
  await ensureSheet(c, id, "未着一覧", map);
  const label = { in_transit: "未着", partial: "一部着荷", candidate: "着荷候補" };
  const now = Date.now();
  const values = [["出荷日", "経過日数", "型番", "チャネル", "出荷数", "受領数", "状態", "更新"],
    ...list.map((x) => [x.shipDate, Math.floor((now - new Date(x.shipDate + "T00:00:00+09:00")) / 86400000), x.code,
      x.channel === "fba" ? "FBA" : "RSL", x.qty, x.receivedQty || 0, label[x.status] || x.status,
      new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })])];
  await c.call("POST", `${API}${id}/values:batchClear`, { ranges: [q("未着一覧")] });
  await c.call("PUT", `${API}${id}/values/${encodeURIComponent(q("未着一覧") + "!A1")}?valueInputOption=RAW`, { values });
}
