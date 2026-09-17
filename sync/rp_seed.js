// 出荷依頼の商品マスタ（rp_items）に、今のスプレッドシートの入数・商品名・並び順を 1 回だけ入れる。
//   データ: data/rp_seed.json（業務データなので .gitignore 済みの sync/data/ に置く）
//   使い方: node rp_seed.js           … 入数が未設定の項目だけ埋める
//           node rp_seed.js --force   … シートの値で上書き
import fs from "node:fs";
import { initFirestore } from "./lib/firestore.js";

const FORCE = process.argv.includes("--force");
const seed = JSON.parse(fs.readFileSync(new URL("./data/rp_seed.json", import.meta.url), "utf8"));
const db = initFirestore();
const snap = await db.collection("rp_items").get();
const cur = {}; snap.docs.forEach((d) => (cur[d.id] = d.data()));
let batch = db.batch(), n = 0, count = 0;
for (const [code, s] of Object.entries(seed)) {
  const c = cur[code] || {};
  const patch = { code };
  for (const k of ["name", "variation", "fbaCaseQty", "rslCaseQty", "sortOrder"]) {
    if (s[k] == null || s[k] === "") continue;
    if (FORCE || c[k] == null || c[k] === "") patch[k] = s[k];
  }
  if (!cur[code]) { patch.active = true; patch.createdAt = new Date(); }
  if (patch.fbaCaseQty != null || patch.rslCaseQty != null || (c.fbaCaseQty != null && c.rslCaseQty != null)) patch.isNew = false;
  if (Object.keys(patch).length <= 1) continue;
  batch.set(db.collection("rp_items").doc(code), patch, { merge: true }); count++;
  if (++n >= 450) { await batch.commit(); batch = db.batch(); n = 0; }
}
if (n) await batch.commit();
console.log(`[rp_seed] ${count}件 更新（シート ${Object.keys(seed).length}件）`);
