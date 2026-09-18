// 出荷依頼の商品マスタ（rp_data/items）に、今のスプレッドシートの入数・商品名・並び順を 1 回だけ入れる。
//   データ: data/rp_seed.json（業務データなので .gitignore 済みの sync/data/ に置く）
//   使い方: node rp_seed.js           … 入数が未設定の項目だけ埋める
//           node rp_seed.js --force   … シートの値で上書き
import fs from "node:fs";
import { initFirestore } from "./lib/firestore.js";

const FORCE = process.argv.includes("--force");
const seed = JSON.parse(fs.readFileSync(new URL("./data/rp_seed.json", import.meta.url), "utf8"));
const db = initFirestore();
const ref = db.collection("rp_data").doc("items");
const snap = await ref.get();
const items = (snap.exists && snap.data().items) || {};
let count = 0;
for (const [code, s] of Object.entries(seed)) {
  const it = items[code] || { code, active: true, createdAt: new Date().toISOString() };
  let touched = false;
  for (const k of ["name", "variation", "fbaCaseQty", "rslCaseQty", "sortOrder"]) {
    if (s[k] == null || s[k] === "") continue;
    if (FORCE || it[k] == null || it[k] === "") { it[k] = s[k]; touched = true; }
  }
  if (it.fbaCaseQty && it.rslCaseQty) it.isNew = false;
  if (touched) { items[code] = it; count++; }
}
await ref.set({ items, updatedAt: new Date() }, { merge: true });
console.log(`[rp_seed] ${count}件 更新（シート ${Object.keys(seed).length}件）/ 書き込み1件`);
