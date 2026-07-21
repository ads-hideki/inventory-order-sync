// GoogleスプレッドシートをCSVとして取得し、行配列に変換する（公開シート・認証不要）
import fs from "node:fs";

function csvUrl(id, gid) {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

// 簡易CSVパーサ（ダブルクォート・改行・カンマ対応）
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export async function fetchSheet(id, gid, retries = 4) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(csvUrl(id, gid));
      if (res.ok) return parseCSV(await res.text());
      last = new Error(`シート取得失敗 ${res.status}: ${id}/${gid}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));   // 1.5s,3s,4.5s… 待って再試行
  }
  throw last;
}

export function readLocalCSV(path) {
  if (!path || !fs.existsSync(path)) return null;
  return parseCSV(fs.readFileSync(path, "utf8"));
}

export const num = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
