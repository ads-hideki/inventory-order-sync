// teps-2 の商品マスタのグループ（UF在庫／事務所在庫／その他在庫）だけを読む。輸送手段の推奨に使う（事務所在庫はコンテナを使わない）
//   読み取りは teps-2 の Firestore REST（ログイン不要）。group の欄だけを取る（mask）。1日1回だけ読み、chat_state に覚えておく
const PROJECT = process.env.TEPS_PROJECT_ID || "teps-2";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/`;

export async function fetchGroups() {
  const out = {}; let token = "", pages = 0;
  do {
    const res = await fetch(`${BASE}sku_master?pageSize=300&mask.fieldPaths=group&mask.fieldPaths=deleted${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    if (!res.ok) throw new Error(`teps-2 の商品マスタを読めません ${res.status}`);
    const d = await res.json();
    for (const doc of d.documents || []) {
      const code = doc.name.split("/").pop().toUpperCase(), f = doc.fields || {};
      if (!/^ADS\d{3}/.test(code) || (f.deleted && f.deleted.booleanValue)) continue;
      const g = (f.group && f.group.stringValue || "").trim();
      if (g && g !== "UF在庫") out[code] = g;   // UF在庫（既定）以外だけ覚える
    }
    token = d.nextPageToken || ""; pages++;
  } while (token && pages < 20);
  return out;
}
