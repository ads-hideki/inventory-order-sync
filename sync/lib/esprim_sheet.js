// エスプリム在庫（Google スプレッドシート）の読み書き
//   タブ「エスプリム在庫」… エスプリムにいまある商品だけ（チャットが基準。コンテナ計算シートで補う）。状態・箱数・CBM・輸送手段の推奨
//   タブ「生産管理」    … 一元管理（発注管理）の生産中のうち、まだエスプリムに無いもの。到着予定（チャットの到着予定・納期の回答・リードタイム目安）
//   タブ「未判定」      … 状態の報告らしいが、品番が分からなかったもの（辞書に呼び名を足すと拾える）
//   タブ「辞書」        … チャットでの呼び名 → 品番3桁（人が足す。ここは書き換えない）
//   タブ「使い方」      … このシートの見方（毎回書き直す）
//   タブ「参考_*」      … IMPORTRANGE で取り込んだ参考データ（読むだけ。書き換えない）
//   毎回書き直すが、手入力の列（黄色）は行のキー（発注日|品番）ごとに残す
//   出力先のスプレッドシートを、このシステムのサービスアカウントに「編集者」で共有しておく（在庫計算書と同じ）
import { JWT } from "google-auth-library";
import fs from "node:fs";

const API = "https://sheets.googleapis.com/v4/spreadsheets/";
export const TAB = { main: "エスプリム在庫", prod: "生産管理", unknown: "未判定", dict: "辞書", howto: "使い方" };
const HEADER = ["担当", "ステータス", "ステータス上書き\n（手入力）", "発注日", "品番", "商品名", "数量", "色別の残数\n（一元管理）", "到着日", "箱数", "CBM", "入数",
  "推奨", "推奨の内訳", "在庫が\nもつ日数", "箱数①\n今回コンテナ", "箱数②\n次のコンテナ", "箱数③\n混載便・OCS", "今回\nCBM", "次回\nCBM", "混載等\nCBM", "備考", "出所",
  "チャットの報告", "報告日時", "コンテナ計算シート\n（エスプリム記入）", "キー"];
const COLS = HEADER.length;                                   // A〜AA
const KEEP = { over: 2, b1: 15, b2: 16, b3: 17, note: 21 };   // 手入力の列（更新しても残す）
const FALLBACK = { boxes: 9, cbm: 10, perBox: 11 };           // チャット・シートから取れなかった時は、手入力した値を残す
const PHEADER = ["担当", "発注日", "品番", "商品名", "残数", "色別の残数", "発注先", "発注から\n（日）", "到着予定", "到着予定の根拠", "備考（手入力）", "チャットの報告", "キー"];
const PCOLS = PHEADER.length;                                 // A〜M
const KEY_RE = /^(\d{4}-\d{2}-\d{2}|日付不明)\|\d{3}$/;

export function sheetsClient(scope = "https://www.googleapis.com/auth/spreadsheets") {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync("./serviceAccount.json") ? fs.readFileSync("./serviceAccount.json", "utf8") : "");
  if (!raw) throw new Error("サービスアカウントがありません");
  const sa = JSON.parse(raw);
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] });
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
  const call = sheetsClient();
  const meta = await call("GET", `${sheetId}?fields=sheets.properties`);
  const tabs = {}; for (const s of meta.sheets || []) tabs[s.properties.title] = s.properties;
  const need = Object.values(TAB).filter((t) => !tabs[t]);
  if (need.length) {
    const r = await call("POST", `${sheetId}:batchUpdate`, { requests: need.map((title) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 300, columnCount: title === TAB.main ? COLS + 1 : title === TAB.prod ? PCOLS + 1 : 8 } } } })) });
    r.replies.forEach((x) => { tabs[x.addSheet.properties.title] = x.addSheet.properties; });
    if (need.includes(TAB.dict)) await call("PUT", `${sheetId}/values/${enc(`${q(TAB.dict)}!A1`)}?valueInputOption=RAW`,
      { values: [["チャットでの呼び名", "品番（3桁）", "メモ（自由）"], ["（例）台形バッグ", "123", "番号なしで書かれる呼び名を足す（この行は例なので読まない）。次の更新で未判定から拾い直す"]] });
  }
  const aliases = {}, keep = {}, keepProd = {};
  const d = await call("GET", `${sheetId}/values/${enc(`${q(TAB.dict)}!A2:B`)}`);
  for (const r of d.values || []) { const k = String(r[0] || "").trim(), v = String(r[1] || "").trim(); if (k && v && !k.startsWith("（例）")) aliases[k] = v; }
  const cur = await call("GET", `${sheetId}/values/${enc(`${q(TAB.main)}!A3:AA`)}?valueRenderOption=UNFORMATTED_VALUE`);
  for (const r of cur.values || []) {
    const key = [r[COLS - 1], r[25], r[24]].map((x) => String(x || "").trim()).find((x) => KEY_RE.test(x)); if (!key) continue;   // 列の並びを変える前の行（キーが Y・Z 列）も読む
    const k = {}; for (const [name, i] of Object.entries({ ...KEEP, ...FALLBACK })) if (r[i] !== undefined && r[i] !== "") k[name] = r[i];
    keep[key] = k;
  }
  const curP = await call("GET", `${sheetId}/values/${enc(`${q(TAB.prod)}!A3:M`)}?valueRenderOption=UNFORMATTED_VALUE`);
  for (const r of curP.values || []) { const key = String(r[PCOLS - 1] || "").trim(); if (KEY_RE.test(key) && r[10]) keepProd[key] = { note: r[10] }; }
  return { call, sheetId, tabs, aliases, keep, keepProd };
}

const HOWTO = [
  ["エスプリム在庫シートの使い方（自動更新・毎日 9:50〜19:50 の2時間おき）"],
  [""],
  ["■ エスプリム在庫タブ", "エスプリムにいまある商品だけを出す。1行＝発注日×品番"],
  ["  どうやって拾うか", "チャット（Chatwork の中国代行1〜3）の「〜発注分 ◯◯ 弊社に届きました」「検品中です」などを読む。これが基準"],
  ["", "チャットに無い分は、エスプリムのコンテナ計算シート（兪・ナナ・張）で補う（出所の列に「シート」と出る）。シートは更新漏れがあるので、状態はチャットを優先"],
  ["  消えるとき", "一元管理（発注管理）でインボイス取込をして輸送中になったとき。または「ステータス上書き」に「出荷済」と入れたとき"],
  ["", "一元管理に発注が無い商品（修理分など）も載せる（出所に「一元管理に発注なし」）。45日チャットにもシートにも出てこなければ消える"],
  ["  推奨", "国内在庫＋輸送中が何日もつかで、OCS／混載便／コンテナ を出す。基準の日数は1行目（入力シートの実績から自動）。送料差は原価シートから"],
  ["  黄色の列（手入力）", "ステータス上書き・箱数①②③・備考。更新しても消えない。箱数①②③を入れると今回・次回・混載のCBMが計算される（1行目に合計と40HQの68CBM）"],
  ["  ステータス上書き", "自動の状態が違うときに入れる（検品待ち／検品中／検品済／出荷済）。空にすると自動に戻る"],
  [""],
  ["■ 生産管理タブ", "一元管理の生産中のうち、まだエスプリムに届いていないもの。到着予定の早い順"],
  ["  到着予定", "①チャットの「届く予定」 ②チャットの納期の回答（「納期：30日-35日」→ 発注日＋35日） ③一元管理のリードタイム（目安）の順"],
  ["", "到着予定を過ぎているものは赤字。備考（黄色）は手入力で残る"],
  [""],
  ["■ 未判定タブ", "到着などの報告らしいが、どの品番か分からなかったもの"],
  ["  直し方", "辞書タブに「チャットでの呼び名 → 品番3桁」を足す（例: リュックインバッグF → 091）。次の更新で拾い直す"],
  [""],
  ["■ 参考_* タブ", "入力シート・原価シート・コンテナ計算シートの取り込み（IMPORTRANGE）。消さない・書き換えない"],
];

// rows = エスプリム在庫の行 / prodRows = 生産管理の行
export async function writeSheet(sh, { rows, prodRows, unknown, now, cap, basis, format }) {
  const { call, sheetId, tabs, keep, keepProd } = sh;
  const values = [["エスプリム在庫（チャットから自動更新）", "", `更新 ${now}`, basis || "", "", "", "", "", "", "", "", "", "", "", "",
    "40HQ（CBM）", cap, "今回 計→", `=SUM(S3:S)`, `=SUM(T3:T)`, `=SUM(U3:U)`, "", "", "", "", "", ""], HEADER];
  rows.forEach((x, i) => {
    const r = i + 3, k = keep[x.key] || {};
    const part = (c) => `=IF(OR(N(J${r})=0,N(K${r})=0,N(${c}${r})=0),"",K${r}/J${r}*${c}${r})`;
    values.push([x.room || "", x.stage, k.over ?? "", x.date ? x.date.replace(/-/g, "/") : "日付不明", `'${x.folder}`, x.name, x.remain, x.items, x.arrive || "",
      x.boxes || k.boxes || "", x.cbm || k.cbm || "", x.perBox || k.perBox || "", x.rec || "", x.recDetail || "", x.minDays ?? "",
      k.b1 ?? "", k.b2 ?? "", k.b3 ?? "", part("P"), part("Q"), part("R"), k.note ?? "", x.source || "", x.text || "", x.at || "", x.sheet || "", x.key]);
  });
  const pvals = [[`生産管理（一元管理の生産中のうち、まだエスプリムに無いもの）`, "", `更新 ${now}`], PHEADER];
  prodRows.forEach((x) => pvals.push([x.room || "", x.date.replace(/-/g, "/"), `'${x.folder}`, x.name, x.remain, x.items, x.supplier, x.elapsed,
    x.eta ? x.eta.replace(/-/g, "/") : "", x.why, (keepProd[x.key] || {}).note ?? "", x.text, x.key]));

  for (const [tab, vals, range] of [[TAB.main, values, "A1:AA"], [TAB.prod, pvals, "A1:M"]]) {
    const t = tabs[tab];
    if ((t.gridProperties.rowCount || 0) < vals.length + 5) await call("POST", `${sheetId}:batchUpdate`, { requests: [{ appendDimension: { sheetId: t.sheetId, dimension: "ROWS", length: vals.length + 30 - (t.gridProperties.rowCount || 0) } }] });
    await call("POST", `${sheetId}/values/${enc(`${q(tab)}!${range}`)}:clear`, {});
    await call("PUT", `${sheetId}/values/${enc(`${q(tab)}!A1`)}?valueInputOption=USER_ENTERED`, { values: vals });
  }
  const u = [["報告日時", "担当", "発言者", "理由", "本文（抜粋）"], ...unknown.map((x) => [x.at, x.room || "", x.who || "", x.reason, x.text])];
  await call("POST", `${sheetId}/values/${enc(`${q(TAB.unknown)}!A1:E`)}:clear`, {});
  await call("PUT", `${sheetId}/values/${enc(`${q(TAB.unknown)}!A1`)}?valueInputOption=RAW`, { values: u });
  await call("POST", `${sheetId}/values/${enc(`${q(TAB.howto)}!A1:B`)}:clear`, {});
  await call("PUT", `${sheetId}/values/${enc(`${q(TAB.howto)}!A1`)}?valueInputOption=RAW`, { values: HOWTO });

  // 生産管理: 到着予定を過ぎたものを赤字（行数が変わるので毎回）
  try {
    const sid = tabs[TAB.prod].sheetId;
    const reqs = [{ repeatCell: { range: { sheetId: sid, startRowIndex: 2, startColumnIndex: 0, endColumnIndex: PCOLS }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 } } } }, fields: "userEnteredFormat.textFormat.foregroundColor" } }];
    prodRows.forEach((x, i) => { if (x.late) reqs.push({ repeatCell: { range: { sheetId: sid, startRowIndex: i + 2, endRowIndex: i + 3, startColumnIndex: 8, endColumnIndex: 10 }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 0.8, green: 0, blue: 0 }, bold: true } } }, fields: "userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.textFormat.bold" } }); });
    await call("POST", `${sheetId}:batchUpdate`, { requests: reqs });
  } catch (e) { console.error("[chat] 生産管理の色付けに失敗（続行）:", e.message); }
  if (format) await applyFormat(sh);
  return { rows: rows.length, prod: prodRows.length, unknown: unknown.length };
}

// 列幅・折り返し・固定・色（FORMAT_VER が変わった時だけ。手で直した幅を毎回戻さないため）
//   Sheets API の fields は括弧を使わず、パスをカンマ区切りで書く（括弧だと失敗する）
export const FORMAT_VER = 4;
const WIDTH = [45, 80, 95, 85, 50, 170, 60, 260, 70, 50, 55, 50, 70, 330, 70, 75, 75, 85, 60, 60, 65, 150, 130, 300, 120, 300, 130];
const WRAP_COLS = [5, 7, 13, 21, 22, 23, 25];   // 商品名・色別の残数・推奨の内訳・備考・出所・チャットの報告・コンテナ計算シート（長いので折り返す）
export async function applyFormat(sh) {
  const { call, sheetId, tabs } = sh, sid = tabs[TAB.main].sheetId;
  const rng = (c0, c1, r0, r1) => ({ sheetId: sid, startRowIndex: r0, ...(r1 != null ? { endRowIndex: r1 } : {}), startColumnIndex: c0, endColumnIndex: c1 });
  const fmt = (c0, c1, r0, r1, f, fields) => ({ repeatCell: { range: rng(c0, c1, r0, r1), cell: { userEnteredFormat: f }, fields } });
  const center = (c) => fmt(c, c + 1, 2, null, { horizontalAlignment: "CENTER" }, "userEnteredFormat.horizontalAlignment");
  const reqs = [
    { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 2, frozenColumnCount: 6 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
    ...WIDTH.map((px, i) => ({ updateDimensionProperties: { range: { sheetId: sid, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } })),
    // 本文: 上揃え・はみ出しは切る（長い列だけ折り返す）
    fmt(0, COLS, 2, null, { wrapStrategy: "CLIP", verticalAlignment: "TOP" }, "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment"),
    ...WRAP_COLS.map((c) => fmt(c, c + 1, 2, null, { wrapStrategy: "WRAP" }, "userEnteredFormat.wrapStrategy")),
    // 見出し（2行目）: 太字・色・折り返し・中央
    fmt(0, COLS, 1, 2, { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.98 }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", horizontalAlignment: "CENTER" },
      "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment,userEnteredFormat.horizontalAlignment"),
    { updateDimensionProperties: { range: { sheetId: sid, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 44 }, fields: "pixelSize" } },
    // 1行目: 折り返さず横にはみ出して表示
    fmt(0, COLS, 0, 1, { wrapStrategy: "OVERFLOW_CELL", textFormat: { bold: true } }, "userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.bold"),
    // 手入力の列は黄色
    ...[2, 15, 16, 17, 21].map((c) => fmt(c, c + 1, 2, null, { backgroundColor: { red: 1, green: 1, blue: 0.8 } }, "userEnteredFormat.backgroundColor")),
    fmt(3, 4, 2, null, { numberFormat: { type: "DATE", pattern: "yyyy/mm/dd" } }, "userEnteredFormat.numberFormat"),
    fmt(10, 11, 2, null, { numberFormat: { type: "NUMBER", pattern: "0.00" } }, "userEnteredFormat.numberFormat"),
    fmt(18, 21, 2, null, { numberFormat: { type: "NUMBER", pattern: "0.00" } }, "userEnteredFormat.numberFormat"),
    fmt(6, 7, 2, null, { numberFormat: { type: "NUMBER", pattern: "#,##0" } }, "userEnteredFormat.numberFormat"),
    ...[0, 1, 4, 8, 9, 11, 12, 14].map(center),
    fmt(26, 27, 2, null, { textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } }, "userEnteredFormat.textFormat.foregroundColor"),
  ];
  // 未判定タブ: 本文の列を広く・折り返し
  if (tabs[TAB.unknown]) {
    const u = tabs[TAB.unknown].sheetId;
    [120, 45, 120, 260, 520].forEach((px, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: u, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } }));
    reqs.push({ repeatCell: { range: { sheetId: u, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment" } });
    reqs.push({ updateSheetProperties: { properties: { sheetId: u, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } });
  }
  // 生産管理タブ
  if (tabs[TAB.prod]) {
    const p = tabs[TAB.prod].sheetId;
    [45, 85, 50, 170, 60, 300, 120, 70, 85, 160, 200, 300, 130].forEach((px, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: p, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } }));
    reqs.push({ updateSheetProperties: { properties: { sheetId: p, gridProperties: { frozenRowCount: 2, frozenColumnCount: 4 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } });
    reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 2, startColumnIndex: 0, endColumnIndex: PCOLS }, cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment" } });
    for (const c of [3, 5, 10, 11]) reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 2, startColumnIndex: c, endColumnIndex: c + 1 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } });
    reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: PCOLS }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.95, blue: 0.9 }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment,userEnteredFormat.horizontalAlignment" } });
    reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 2, startColumnIndex: 10, endColumnIndex: 11 }, cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0.8 } } }, fields: "userEnteredFormat.backgroundColor" } });
    reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: PCOLS }, cell: { userEnteredFormat: { wrapStrategy: "OVERFLOW_CELL", textFormat: { bold: true } } }, fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.bold" } });
    reqs.push({ repeatCell: { range: { sheetId: p, startRowIndex: 2, startColumnIndex: 12, endColumnIndex: 13 }, cell: { userEnteredFormat: { textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } } }, fields: "userEnteredFormat.textFormat.foregroundColor" } });
  }
  // 使い方タブ
  if (tabs[TAB.howto]) {
    const h = tabs[TAB.howto].sheetId;
    [200, 900].forEach((px, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: h, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } }));
    reqs.push({ repeatCell: { range: { sheetId: h, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 2 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment" } });
    reqs.push({ repeatCell: { range: { sheetId: h, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 }, wrapStrategy: "OVERFLOW_CELL" } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.wrapStrategy" } });
  }
  // タブの並び: エスプリム在庫 → 生産管理 → 未判定 → 辞書 → 使い方 → 参考_*
  [TAB.main, TAB.prod, TAB.unknown, TAB.dict, TAB.howto].forEach((t, i) => { if (tabs[t]) reqs.push({ updateSheetProperties: { properties: { sheetId: tabs[t].sheetId, index: i }, fields: "index" } }); });
  if (tabs[TAB.dict]) [200, 90, 400].forEach((px, i) => reqs.push({ updateDimensionProperties: { range: { sheetId: tabs[TAB.dict].sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } }));
  try { await call("POST", `${sheetId}:batchUpdate`, { requests: reqs }); return true; }
  catch (e) { console.error("[chat] シートの書式設定に失敗（続行）:", e.message); return false; }
}
