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
