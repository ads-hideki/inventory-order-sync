// 一度だけ実行: 発注テンプレート(templates.json)をFirestoreの templates コレクションへ投入
import fs from "node:fs";
import { initFirestore } from "./lib/firestore.js";

const tpl = JSON.parse(fs.readFileSync("./data/templates.json", "utf8"));
const db = initFirestore();

const keys = Object.keys(tpl);
console.log(`[seed] テンプレート ${keys.length} 品番を投入します...`);
let n = 0;
for (let i = 0; i < keys.length; i += 400) {
  const batch = db.batch();
  for (const k of keys.slice(i, i + 400)) {
    batch.set(db.collection("templates").doc(k), tpl[k]);
    n++;
  }
  await batch.commit();
}
// システム設定の初期値
await db.collection("settings").doc("system").set({
  recalcTime: "06:00", orderDays: [1, 15], updatedAt: new Date(),
});
console.log(`[seed] 完了: templates ${n}件 + settings/system`);
process.exit(0);
