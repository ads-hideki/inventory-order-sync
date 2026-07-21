// 倉庫システム(utopia.ufsystem.jp)に自動ログインし、最新の在庫エクスポート(zip内xlsx)を取得。
//   認証情報は環境変数 WAREHOUSE_ID / WAREHOUSE_PASS（Secrets）から。コードには書かない。
//   フロー: login(CSRF) → /index の最新download/*.zip → 取得 → 解凍 → xlsx解析
//   返り値: { map: {商品コード: 有効在庫数}, filename }
const BASE = process.env.WAREHOUSE_BASE || "https://utopia.ufsystem.jp/utopia_web";

function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); }
function mergeCookies(jar, res) {
  const list = (res.headers.getSetCookie && res.headers.getSetCookie()) || [];
  for (const sc of list) { const p = sc.split(";")[0]; const i = p.indexOf("="); if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
}

export async function fetchWarehouseStock(username, password) {
  if (!username || !password) throw new Error("倉庫の認証情報(WAREHOUSE_ID/WAREHOUSE_PASS)が未設定です");
  const jar = {};
  // ① ログインページ → CSRFトークン＆セッションCookie
  let res = await fetch(`${BASE}/login`, { redirect: "manual" });
  mergeCookies(jar, res);
  const loginHtml = await res.text();
  const m = loginHtml.match(/name="_csrfToken"[^>]*value="([^"]+)"/);
  const csrf = m ? m[1] : "";
  // ② ログインPOST
  const body = new URLSearchParams({ _method: "POST", _csrfToken: csrf, username, password });
  res = await fetch(`${BASE}/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookieHeader(jar) },
    body,
  });
  mergeCookies(jar, res);
  // ③ 一覧ページ → 最新のzipリンクを抽出
  res = await fetch(`${BASE}/index`, { redirect: "manual", headers: { "Cookie": cookieHeader(jar) } });
  mergeCookies(jar, res);
  const indexHtml = await res.text();
  const links = [...indexHtml.matchAll(/\/utopia_web\/download\/([\w.\-]+\.zip)/g)].map((x) => x[1]);
  if (!links.length) throw new Error("ダウンロードリンクが見つかりません（ログイン失敗の可能性・CSRF/認証を確認）");
  const latest = [...new Set(links)].sort().at(-1); // 日付-時刻順で最新
  // ④ zip取得
  res = await fetch(`${BASE}/download/${latest}`, { headers: { "Cookie": cookieHeader(jar) } });
  if (!res.ok) throw new Error(`zipダウンロード失敗 ${res.status}: ${latest}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  // ⑤ 解凍 → xlsx
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntries().find((e) => /\.xlsx$/i.test(e.entryName)) || zip.getEntries().find((e) => /\.csv$/i.test(e.entryName));
  if (!entry) throw new Error("zip内にxlsx/csvが見つかりません");
  const map = {};
  if (/\.csv$/i.test(entry.entryName)) {
    const { parseCSV } = await import("./sheets.js");
    const rows = parseCSV(entry.getData().toString("utf8"));
    for (let i = 1; i < rows.length; i++) { const code = String(rows[i][2] || "").trim().toUpperCase(); const st = Number(String(rows[i][5] || "").replace(/,/g, "")); if (/^ADS/i.test(code)) map[code] = (map[code] || 0) + (Number.isFinite(st) ? st : 0); }
  } else {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(entry.getData());
    const ws = wb.worksheets[0];
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const code = String(row.getCell(3).value ?? "").trim().toUpperCase();   // C列=商品コード
      let st = row.getCell(6).value;                                          // F列=有効在庫数
      st = Number(typeof st === "object" && st ? (st.result ?? st.text ?? 0) : st);
      if (/^ADS/i.test(code)) map[code] = (map[code] || 0) + (Number.isFinite(st) ? st : 0);
    });
  }
  return { map, filename: latest, count: Object.keys(map).length };
}
