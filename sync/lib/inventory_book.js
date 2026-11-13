// 月末棚卸表（会計資料）の元データを毎月 1 日の朝に記録する（2026-11-13〜）
//   ・毎月 1 日（日本時間）の最初の同期（8:30。月末の在庫が入った回）に、前月末の棚卸として inventoryBook/{YYYY-MM} に 1 件書く
//   ・画面（発注履歴の「📒 月末棚卸表」）がこれを読んで Excel にする。記録した数字は後から変わらない
//   ・12 ヶ月分を残す（それより古い月は消す）
//   ・載せる商品 = 画面に出している商品＋手動追加の商品＋非表示でも在庫か輸送中がある商品。
//     settings/inventoryBook.excludeFolders（既定 ["060"]＝組み合わせ商品）の品番は載せない
//   ・区分 = teps-2 の商品マスタのグループ。「UF在庫」は上段、それ以外（事務所在庫・その他在庫）は下段「事務所」
//   ・在庫 = FBA / RSL / UF / 事務所 / 輸送中（生産中は含めない）。
//     単価・通貨 = settings/inventoryBook.prices（棚卸用の単価 {商品コード: {p, cur}}。2026年10月末の棚卸表から取り込み）を優先し、無い商品は発注テンプレートの単価（備考に出す）。
//     発注テンプレートの単価はセット商品の部材単価だったり未登録だったりして、棚卸の単価とは一致しないため
//    レート = settings/fx（毎朝 9:00 の TTM。1 日 8:30 時点では月末日の朝の値）
//   ・取り直し: node sync.js --inventory-book=YYYY-MM（その時点の在庫で上書きする。1 日の同期が失敗した時だけ使う）
const KEEP_MONTHS = 12;
const DEFAULT_EXCLUDE = ["060"];

const pad = (n) => String(n).padStart(2, "0");
const ym = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;

// jst = 日本時間に 9 時間ずらした Date。force = "YYYY-MM"（取り直し）
export async function recordInventoryBook(db, { products, groups, policy, snap, jst, force }) {
  const prev = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - 1, 1));
  const month = force || ym(prev);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月の指定が正しくありません: ${month}`);
  const ref = db.collection("inventoryBook").doc(month);
  if (!force && (jst.getUTCDate() !== 1 || (await ref.get()).exists)) return null;   // 1 日の最初の回だけ

  const cfg = (await db.collection("settings").doc("inventoryBook").get()).data() || {};
  const acc = cfg.prices || {};
  const exclude = new Set(Array.isArray(cfg.excludeFolders) ? cfg.excludeFolders : DEFAULT_EXCLUDE);
  const price = {}, cur = {};
  (await db.collection("templates").get()).forEach((d) => {
    const t = d.data(); cur[d.id] = t.cur || "";
    for (const it of t.items || []) if (it && it.code) price[it.code] = Number(it.price) || 0;
  });
  const fx = (await db.collection("settings").doc("fx").get()).data() || {};

  const n = (v) => Number(v) || 0;
  const list = products.map((p) => ({ ...p }));
  const have = new Set(list.map((p) => p.code));
  for (const [code, d] of Object.entries((snap && snap.items) || {})) if (d && d.manual && !have.has(code)) list.push({ ...d, code });
  const rows = [];
  for (const p of list) {
    const c = p.code, f = (c.match(/ADS(\d{3})/i) || [])[1] || "";
    if (!f || exclude.has(f)) continue;
    const qty = n(p.fba) + n(p.rsl) + n(p.warehouse) + n(p.office) + n(p.transit);
    if (policy[c] && policy[c].hidden === true && qty === 0) continue;   // 非表示で在庫も無い商品は載せない
    const a = acc[c] && n(acc[c].p) > 0 ? acc[c] : null, pr = a ? n(a.p) : price[c] || 0;
    rows.push({ c, n: p.name || "", v: p.vari || "", fba: n(p.fba), rsl: n(p.rsl), uf: n(p.warehouse), of: n(p.office), tr: n(p.transit),
      p: pr, cur: a ? a.cur || "" : pr ? cur[f] || "" : "", b: a ? "" : pr ? "単価は発注テンプレート" : "単価未登録", s: (groups && groups[c] ? groups[c] : "UF在庫") === "UF在庫" ? 0 : 1 });
  }
  rows.sort((a, b) => a.s - b.s || (a.c < b.c ? -1 : 1));
  const [y, m] = month.split("-").map(Number);
  const date = `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;   // 月末日
  await ref.set({ month, date, createdAt: new Date(), stockAsOf: jst.toISOString().slice(0, 10), forced: !!force,
    fx: { RMB: n(fx.RMB), USD: n(fx.USD), asOf: fx.asOf || "", source: fx.source || "" },
    count: rows.length, json: JSON.stringify(rows) });   // 行は 1 つの文字列にまとめる（読み取り 1 回・項目数の上限を避ける）
  // 12 ヶ月より前は消す
  const cut = ym(new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - KEEP_MONTHS, 1)));
  const old = await db.collection("inventoryBook").get(); let pruned = 0;
  for (const d of old.docs) if (/^\d{4}-\d{2}$/.test(d.id) && d.id < cut) { await d.ref.delete(); pruned++; }
  return { month, rows: rows.length, office: rows.filter((r) => r.s === 1).length, pruned };
}
