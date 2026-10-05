// 季節性の参考データ（Amazon の月別販売数の目安・過去24ヶ月）を、別プロジェクトの Keepa 監視システムから取り込む。
//   ・読むのは 1 日 1 回、3 ドキュメントだけ（views/sales・state/families・views/comps）。書き込みはしない
//   ・結果は在庫システムの cache/keepa に、品番（3桁）ごとにまとめて保存する。画面は商品の編集を開いた時だけ読む
//   ・用途は「季節商品の販売期間を決める時の参考表示と提案」だけ。発注数の計算には使わない（最後は人が判断する）
//   ・鍵: 環境変数 KEEPA_FIREBASE_SERVICE_ACCOUNT（JSON の中身）。ローカルは KEEPA_SA_PATH（鍵ファイルの場所）。無ければ何もしない
// ※このリポジトリは公開。ASIN・ブランド名・商品名をコードやログに書かないこと（ログは件数だけ）
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import fs from "node:fs";

const MAX_COMPS = 4;   // 品番ごとに保存する競合の数（販売の多い順）

function keepaDb() {
  let json = process.env.KEEPA_FIREBASE_SERVICE_ACCOUNT;
  if (!json && process.env.KEEPA_SA_PATH && fs.existsSync(process.env.KEEPA_SA_PATH)) json = fs.readFileSync(process.env.KEEPA_SA_PATH, "utf8");
  if (!json) return null;
  const app = getApps().find((a) => a.name === "keepa") || initializeApp({ credential: cert(JSON.parse(json)) }, "keepa");
  return getFirestore(app);
}
const folderOf = (code) => (String(code || "").match(/ADS(\d{3})/i) || [])[1] || null;
const nums = (s) => (Array.isArray(s) ? s.map((v) => (typeof v === "number" && v > 0 ? v : 0)) : null);

// db = 在庫システムの Firestore / meta = cache/meta（発注テンプレートのまとめ文書の場所）
export async function buildKeepaSeason(db, meta) {
  const kdb = keepaDb();
  if (!kdb) return null;                                   // 鍵が無ければ取り込まない（画面は表が出ないだけ）
  const [sDoc, fDoc, cDoc] = await Promise.all([kdb.doc("views/sales").get(), kdb.doc("state/families").get(), kdb.doc("views/comps").get()]);
  const sales = sDoc.data() || {}, fam = (fDoc.data() || {}).items || {};
  const compList = (cDoc.data() || {}).items; const comps = Array.isArray(compList) ? compList : Object.values(compList || {});
  const months = sales.months || [];
  if (!months.length || !sales.own) throw new Error("月別販売のデータがありません");

  // ASIN → 品番（発注テンプレートの型番ごとの ASIN から。まとめ文書を読むので読み取りは 1〜2 件）
  const asin2folder = {};
  const n = (meta && meta.chunks && meta.chunks.templates) || 0;
  for (let i = 0; i < n; i++) {
    const d = await db.collection("cache").doc(`templates_${meta.buildId}_${i}`).get();
    for (const it of (d.exists && d.data().items) || []) for (const row of (it.d.items || [])) {
      const a = String(row.asin || "").trim().toUpperCase(), f = folderOf(row.code);
      if (/^B0[A-Z0-9]{8}$/.test(a) && f) asin2folder[a] = f;
    }
  }

  // 商品ページ（色・サイズ違いをまとめた単位）→ 含まれる品番。1ページに複数の品番が入ることがある
  const pageFolders = {};
  for (const [parent, f] of Object.entries(fam)) {
    const set = new Set(); for (const a of f.asins || []) if (asin2folder[a]) set.add(asin2folder[a]);
    if (set.size) pageFolders[parent] = [...set];
  }
  const folders = {};
  const slot = (f) => (folders[f] ||= { own: new Array(months.length).fill(0), pages: 0, shared: [], comps: [] });
  for (const [parent, s] of Object.entries(sales.own)) {
    const fs_ = pageFolders[parent]; const v = nums(s); if (!fs_ || !v) continue;
    for (const f of fs_) {
      const o = slot(f); o.pages++; v.forEach((x, i) => { o.own[i] += x; });
      for (const g of fs_) if (g !== f && !o.shared.includes(g)) o.shared.push(g);   // 同じ商品ページに入っている別の品番
    }
  }
  // 競合（同じカテゴリの他社商品）＝カテゴリとしての季節性の参考
  for (const c of comps) {
    const fs_ = pageFolders[c.parent]; const v = nums((sales.comps || {})[c.asin]);
    if (!fs_ || !v || !v.some((x) => x > 0)) continue;
    for (const f of fs_) slot(f).comps.push({ brand: String(c.brand || "").slice(0, 20), s: v, t: v.reduce((a, b) => a + b, 0) });
  }
  for (const o of Object.values(folders)) { o.comps.sort((a, b) => b.t - a.t); o.comps = o.comps.slice(0, MAX_COMPS).map(({ brand, s }) => ({ brand, s })); }

  await db.collection("cache").doc("keepa").set({ updatedAt: new Date(), sourceUpdatedAt: sales.updatedAt || null, months, folders });
  const list = Object.values(folders);
  return { folders: list.length, withData: list.filter((o) => o.own.some((x) => x > 0)).length, withComps: list.filter((o) => o.comps.length).length };
}
