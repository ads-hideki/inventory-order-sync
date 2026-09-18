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
//   同期の書き込みには updatedAt を付けない（syncedAt を使う）。
//   画面は「updatedAt が新しい文書だけ」を差分として読むため、ここで updatedAt を変えると毎朝全商品を読み直してしまう。
//   同期の結果は buildCache() のまとめ文書で画面に届く。
export async function writeProducts(db, products) {
  const now = new Date();
  for (let i = 0; i < products.length; i += 450) {
    const batch = db.batch();
    for (const p of products.slice(i, i + 450)) {
      batch.set(db.collection("products").doc(p.code), { ...p, syncedAt: now }, { merge: true });
    }
    await batch.commit();
  }
}

// 画面の読み取り回数を減らすための「まとめ文書」を作る（毎朝の同期の最後に1回）
//   cache/{kind}_{buildId}_{n} … products / orders / templates を1文書あたり約700KBまでに詰めたもの
//   cache/meta                … builtAt（この時刻より後の変更は画面が差分で読む）・buildId・chunks・imgIndex（画像ありの型番一覧）
//                               tomb.orders（画面で削除した発注の記録。builtAt より前のものはまとめ文書に反映済みなので整理する）
export async function buildCache(db, extra = {}) {
  const t0 = new Date();                       // 読み始める前の時刻＝以降の変更は画面が差分で拾う
  const buildId = String(t0.getTime());
  const LIMIT = 700 * 1024;
  const metaRef = db.collection("cache").doc("meta");
  const oldMeta = (await metaRef.get()).data() || {};

  const chunks = {}; const written = [];
  for (const kind of ["products", "orders", "templates"]) {
    const snap = await db.collection(kind).get();
    const parts = [[]]; let size = 0;
    snap.forEach((d) => {
      const item = { id: d.id, d: d.data() };
      const sz = Buffer.byteLength(JSON.stringify(item));
      if (size + sz > LIMIT && parts[parts.length - 1].length) { parts.push([]); size = 0; }
      parts[parts.length - 1].push(item); size += sz;
    });
    for (let i = 0; i < parts.length; i++) {
      const ref = db.collection("cache").doc(`${kind}_${buildId}_${i}`);
      await ref.set({ kind, buildId, part: i, items: parts[i] });
      written.push(ref.id);
    }
    chunks[kind] = parts.length;
  }
  // 画像ありの型番一覧（テンプレ一覧の🖼️表示用。画像本体は画面で必要な時だけ読む）
  const imgIndex = {};
  (await db.collection("images").get()).forEach((d) => {
    const codes = Object.keys((d.data() || {}).photos || {}); if (codes.length) imgIndex[d.id] = codes;
  });
  await metaRef.set({ builtAt: t0, buildId, chunks, imgIndex, syncedAt: new Date(), ...extra },
    { mergeFields: ["builtAt", "buildId", "chunks", "imgIndex", "syncedAt", ...Object.keys(extra)] });

  // 前回までのまとめ文書を削除（画面が読み替える時間を見て、今回と前回の2世代は残す）
  const keep = new Set([buildId, String(oldMeta.buildId || "")]);
  const old = (await db.collection("cache").select("buildId").get()).docs.filter((d) => d.id !== "meta" && !keep.has(String((d.data() || {}).buildId)));
  for (const d of old) await d.ref.delete();
  // まとめ文書に反映済みの削除記録を整理（念のため5分の余裕を見る）
  const tomb = ((oldMeta.tomb || {}).orders) || {};
  const { FieldValue } = await import("firebase-admin/firestore");
  const prune = {};
  Object.entries(tomb).forEach(([id, ms]) => { if (Number(ms) < t0.getTime() - 5 * 60 * 1000) prune[`tomb.orders.${id}`] = FieldValue.delete(); });
  if (Object.keys(prune).length) await metaRef.update(prune);
  return { buildId, chunks, docs: written.length, imgFolders: Object.keys(imgIndex).length, removedOld: old.length, prunedTomb: Object.keys(prune).length };
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
