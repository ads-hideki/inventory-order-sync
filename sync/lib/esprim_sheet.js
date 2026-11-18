// エスプリム在庫（Google スプレッドシート）の読み書き
//   タブ「エスプリム在庫」… 生産中の発注ロットごとの状態・箱数・CBM・輸送手段の推奨。毎回書き直す（手入力の列は発注ロットごとに残す）
//   タブ「未判定」      … 状態の報告らしいが、商品や発注に結び付けられなかったメッセージ
//   タブ「辞書」        … チャットでの呼び名 → 品番3桁（人が足す。ここは書き換えない）
//   出力先のスプレッドシートを、このシステムのサービスアカウントに「編集者」で共有しておく（在庫計算書と同じ）
import { JWT } from "google-auth-library";
import fs from "node:fs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
export const TAB = { main: "エスプリム在庫", unknown: "未判定", dict: "辞書" };
const HEADER = ["担当", "ステータス", "ステータス上書き\n（手入力・空で自動）", "発注日", "品番", "商品名", "残数", "色別の残数", "到着日\n（予定）", "箱数", "CBM", "入数",
  "推奨", "推奨の内訳", "在庫が\nもつ日数", "箱数①\n今回コンテナ", "箱数②\n次のコンテナ", "箱数③\n混載便・OCS", "今回\nCBM", "次回\nCBM", "混載等\nCBM", "備考", "チャットの報告", "報告日時", "キー"];
const COLS = HEADER.length;                                   // A〜Y
const KEEP = { over: 2, b1: 15, b2: 16, b3: 17, note: 21 };   // 手入力の列（更新しても残す）
const FALLBACK = { boxes: 9, cbm: 10, perBox: 11 };           // チャットから取れなかった時は、シートに手入力した値を残す

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
const enc = encodeURIComponent, q = (t) => `'${t.replace(/'/g, "''")}'`;

// シートを開く。無いタブは作る。辞書と、手入力の列の今の値を読む
export async function openSheet(sheetId) {
  const call = client();
  const meta = await call("GET", `${sheetId}?fields=sheets.properties`);
  const tabs = {}; for (const s of meta.sheets || []) tabs[s.properties.title] = s.properties;
  const need = Object.values(TAB).filter((t) => !tabs[t]);
  if (need.length) {
    const r = await call("POST", `${sheetId}:batchUpdate`, { requests: need.map((title) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 300, columnCount: title === TAB.main ? COLS + 1 : 8 } } } })) });
    r.replies.forEach((x) => { tabs[x.addSheet.properties.title] = x.addSheet.properties; });
    if (need.includes(TAB.dict)) await call("PUT", `${sheetId}/values/${enc(`${q(TAB.dict)}!A1`)}?valueInputOption=RAW`,
      { values: [["チャットでの呼び名", "品番（3桁）", "メモ（自由）"], ["（例）台形バッグ", "123", "番号なしで書かれる呼び名を足す（この行は例なので読まない）。次の更新で未判定から拾い直す"]] });
  }
  const created = need.includes(TAB.main);
  const aliases = {}, keep = {};
  const d = await call("GET", `${sheetId}/values/${enc(`${q(TAB.dict)}!A2:B`)}`);
  for (const r of d.values || []) { const k = String(r[0] || "").trim(), v = String(r[1] || "").trim(); if (k && v && !k.startsWith("（例）")) aliases[k] = v; }
  if (!created) {
    const cur = await call("GET", `${sheetId}/values/${enc(`${q(TAB.main)}!A3:Y`)}?valueRenderOption=UNFORMATTED_VALUE`);
    for (const r of cur.values || []) {
      const key = String(r[COLS - 1] || "").trim(); if (!key.includes("|")) continue;
      const k = {}; for (const [name, i] of Object.entries({ ...KEEP, ...FALLBACK })) if (r[i] !== undefined && r[i] !== "") k[name] = r[i];
      keep[key] = k;
    }
  }
  return { call, sheetId, tabs, created, aliases, keep };
}

// rows = [{key, room, stage, date, folder, name, remain, items, arrive, boxes, cbm, perBox, rec, recDetail, minDays, text, at}]
export async function writeSheet(sh, { rows, unknown, now, cap }) {
  const { call, sheetId, tabs, keep } = sh;
  const values = [["エスプリム在庫（チャットから自動更新）", "", `更新 ${now}`, "", "", "", "", "", "", "", "", "", "", "", "",
    "40HQ（CBM）", cap, "今回 計→", `=SUM(S3:S)`, `=SUM(T3:T)`, `=SUM(U3:U)`, "", "", "", ""], HEADER];
  rows.forEach((x, i) => {
    const r = i + 3, k = keep[x.key] || {};
    const part = (c) => `=IF(OR(N(J${r})=0,N(K${r})=0,N(${c}${r})=0),"",K${r}/J${r}*${c}${r})`;
    values.push([x.room || "", x.stage, k.over ?? "", x.date.replace(/-/g, "/"), `'${x.folder}`, x.name, x.remain, x.items, x.arrive || "",
      x.boxes || k.boxes || "", x.cbm || k.cbm || "", x.perBox || k.perBox || "", x.rec || "", x.recDetail || "", x.minDays ?? "",
      k.b1 ?? "", k.b2 ?? "", k.b3 ?? "", part("P"), part("Q"), part("R"), k.note ?? "", x.text || "", x.at || "", x.key]);
  });
  const main = tabs[TAB.main], L = values.length;
  if ((main.gridProperties.rowCount || 0) < L + 5) await call("POST", `${sheetId}:batchUpdate`, { requests: [{ appendDimension: { sheetId: main.sheetId, dimension: "ROWS", length: L + 30 - (main.gridProperties.rowCount || 0) } }] });
  await call("POST", `${sheetId}/values/${enc(`${q(TAB.main)}!A1:Y`)}:clear`, {});
  await call("PUT", `${sheetId}/values/${enc(`${q(TAB.main)}!A1`)}?valueInputOption=USER_ENTERED`, { values });

  const u = [["報告日時", "担当", "発言者", "理由", "本文（抜粋）"], ...unknown.map((x) => [x.at, x.room || "", x.who || "", x.reason, x.text])];
  await call("POST", `${sheetId}/values/${enc(`${q(TAB.unknown)}!A1:E`)}:clear`, {});
  await call("PUT", `${sheetId}/values/${enc(`${q(TAB.unknown)}!A1`)}?valueInputOption=RAW`, { values: u });

  // 書式はタブを作った時だけ（手で直した幅・色を戻さない）。失敗しても本体には影響させない
  if (sh.created) try {
    const sid = main.sheetId, w = (i, px) => ({ updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
    const fmt = (c0, c1, r0, r1, f, fields) => ({ repeatCell: { range: { sheetId: sid, startRowIndex: r0, ...(r1 != null ? { endRowIndex: r1 } : {}), startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: f }, fields } });
    await call("POST", `${sheetId}:batchUpdate`, { requests: [
      { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 2, frozenColumnCount: 6 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      fmt(0, COLS, 1, 2, { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.98 }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" }, "userEnteredFormat(textFormat.bold,backgroundColor,wrapStrategy,verticalAlignment)"),
      fmt(0, COLS, 2, null, { wrapStrategy: "WRAP", verticalAlignment: "TOP" }, "userEnteredFormat(wrapStrategy,verticalAlignment)"),
      ...[2, 15, 16, 17, 21].map((c) => fmt(c, c + 1, 2, null, { backgroundColor: { red: 1, green: 1, blue: 0.8 } }, "userEnteredFormat.backgroundColor")),
      fmt(18, 21, 2, null, { numberFormat: { type: "NUMBER", pattern: "0.00" } }, "userEnteredFormat.numberFormat"),
      w(5, 180), w(7, 220), w(13, 300), w(21, 160), w(22, 320), w(24, 110),
    ] });
  } catch (e) { console.error("[chat] シートの書式設定に失敗（続行）:", e.message); }
  return { rows: rows.length, unknown: unknown.length };
}
