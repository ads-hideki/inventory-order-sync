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
  const DBG = process.env.WAREHOUSE_DEBUG !== "0";
  const jar = {};
  // ① ログインページ → CSRFトークン＆セッションCookie
  let res = await fetch(`${BASE}/login`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
  mergeCookies(jar, res);
  const loginHtml = await res.text();
  const m = loginHtml.match(/name="_csrfToken"[^>]*value="([^"]+)"/);
  const csrf = m ? m[1] : "";
  if (DBG) console.log(`[wh] ①login GET status=${res.status} csrf=${csrf ? "取得(" + csrf.length + "字)" : "なし"} cookies=[${Object.keys(jar).join(",")}]`);
  // ② ログインPOST
  const body = new URLSearchParams({ _method: "POST", _csrfToken: csrf, username, password });
  res = await fetch(`${BASE}/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cookie": cookieHeader(jar), "User-Agent": "Mozilla/5.0", "Referer": `${BASE}/login` },
    body,
  });
  mergeCookies(jar, res);
  if (DBG) console.log(`[wh] ②login POST status=${res.status} location=${res.headers.get("location") || "なし"} cookies=[${Object.keys(jar).join(",")}]`);
  // 302リダイレクト先を辿る（未認証なら/loginに戻される）
  const loc = res.headers.get("location");
  // ③ 一覧ページ → 最新のzipリンクを抽出
  res = await fetch(`${BASE}/index`, { redirect: "manual", headers: { "Cookie": cookieHeader(jar), "User-Agent": "Mozilla/5.0" } });
  mergeCookies(jar, res);
  const indexHtml = await res.text();
  const loggedIn = /ログアウト|logout|Logout/.test(indexHtml);
  const stillLogin = /name="password"|name="_csrfToken"/.test(indexHtml) && !loggedIn;
  const zipCount = (indexHtml.match(/\.zip/g) || []).length;
  const dlCount = (indexHtml.match(/download\//g) || []).length;
  if (DBG) console.log(`[wh] ③index GET status=${res.status} 長さ=${indexHtml.length} ログイン後=${loggedIn} ログイン画面のまま=${stillLogin} .zip出現=${zipCount} download/出現=${dlCount} POST後location=${loc || "なし"}`);
  const links = [...indexHtml.matchAll(/download\/([\w.\-]+\.zip)/g)].map((x) => x[1]);
  if (!links.length) {
    if (stillLogin) throw new Error("ログインに失敗しています（/index がログイン画面のまま）。ID/パスワード・CSRF処理を確認してください");
    throw new Error(`ダウンロードリンクが見つかりません（zip出現=${zipCount}, download/出現=${dlCount}）。/index の構造が想定と異なる可能性`);
  }
  const latest = [...new Set(links)].sort().at(-1); // 日付-時刻順で最新
  // ④ zip取得
  res = await fetch(`${BASE}/download/${latest}`, { headers: { "Cookie": cookieHeader(jar) } });
  if (!res.ok) throw new Error(`zipダウンロード失敗 ${res.status}: ${latest}`);
  const zipBuf = Buffer.from(await res.arrayBuffer());
  // ⑤ 解凍（ZIPはパスワード付き＝ログインと同じパスワード）→ xlsx
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntries().find((e) => /\.xlsx$/i.test(e.entryName)) || zip.getEntries().find((e) => /\.csv$/i.test(e.entryName));
  if (!entry) throw new Error("zip内にxlsx/csvが見つかりません");
  let entryData;
  try { entryData = entry.getData(password); }   // ZIPパスワード = ログインパスワード
  catch (e) { throw new Error("zipの解凍に失敗（パスワード誤り、またはAES暗号で非対応の可能性）: " + e.message); }
  if (!entryData || !entryData.length) throw new Error("zip解凍結果が空（パスワード誤りの可能性）");
  const map = {};
  if (/\.csv$/i.test(entry.entryName)) {
    const { parseCSV } = await import("./sheets.js");
    const rows = parseCSV(entryData.toString("utf8"));
    for (let i = 1; i < rows.length; i++) { const code = String(rows[i][2] || "").trim().toUpperCase(); const st = Number(String(rows[i][5] || "").replace(/,/g, "")); if (/^ADS/i.test(code)) map[code] = (map[code] || 0) + (Number.isFinite(st) ? st : 0); }
  } else {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(entryData);
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
