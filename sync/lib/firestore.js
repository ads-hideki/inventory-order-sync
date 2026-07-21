// Firestore書き込み（firebase-admin）。サービスアカウントは環境変数 or ファイルから。
import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";

export function initFirestore() {
  if (getApps().length) return getFirestore();
  // 優先: GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT(JSON文字列) or serviceAccount.json
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  } else if (fs.existsSync("./serviceAccount.json")) {
    credential = cert(JSON.parse(fs.readFileSync("./serviceAccount.json", "utf8")));
  } else {
    credential = applicationDefault();
  }
  initializeApp({ credential });
  return getFirestore();
}

// products をバッチ書き込み（500件ごと）
export async function writeProducts(db, products) {
  const now = new Date();
  for (let i = 0; i < products.length; i += 450) {
    const batch = db.batch();
    for (const p of products.slice(i, i + 450)) {
      batch.set(db.collection("products").doc(p.code), { ...p, updatedAt: now }, { merge: true });
    }
    await batch.commit();
  }
}

// 生産中/輸送中のスナップショットを取得（在庫計算に使用）
export async function readOrders(db) {
  const snap = await db.collection("orders").where("status", "in", ["production", "transit"]).get();
  return snap.docs.map((d) => d.data());
}

// 発注ポリシー（ボーダー・ロット）読み込み
export async function readPolicy(db) {
  const doc = await db.collection("settings").doc("borders").get();
  return doc.exists ? doc.data() : {};
}

// 画面で削除された商品コード（同期で復活させない）
export async function readDeleted(db) {
  const doc = await db.collection("settings").doc("deleted").get();
  return doc.exists && doc.data().codes ? doc.data().codes : [];
}

// 古い履歴・完了発注の自動整理（既定: 約1年=400日より前を削除）
//   history: 400日より前を全削除
//   orders : 400日より前 かつ 完了(closed/delivered/received) のみ削除（進行中は年齢問わず保持）
export async function cleanupOld(db, days = 400) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const DONE = new Set(["closed", "delivered", "received"]);
  let delHist = 0, delOrd = 0;

  const commitBatch = async (docs) => {
    for (let i = 0; i < docs.length; i += 450) {
      const batch = db.batch();
      docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  };
  // history: ts < cutoff
  try {
    const hSnap = await db.collection("history").where("ts", "<", cutoff).get();
    await commitBatch(hSnap.docs); delHist = hSnap.size;
  } catch (e) { console.error("[cleanup] history:", e.message); }
  // orders: date < cutoff かつ 完了
  try {
    const oSnap = await db.collection("orders").where("date", "<", cutoffStr).get();
    const old = oSnap.docs.filter((d) => DONE.has(d.data().status));
    await commitBatch(old); delOrd = old.length;
  } catch (e) { console.error("[cleanup] orders:", e.message); }
  return { delHist, delOrd, cutoff: cutoffStr };
}
