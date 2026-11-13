// 月末棚卸表（会計資料）の元データを毎月 1 日の朝に記録する（2026-11-13〜）
//   ・毎月 1 日（日本時間）の最初の同期（8:30。月末の在庫が入った回）に、前月末の棚卸として inventoryBook/{YYYY-MM} に 1 件書く
//   ・画面（発注履歴の「📒 月末棚卸表」）がこれを読んで Excel にする。記録した数字は後から変わらない
//   ・12 ヶ月分を残す（それより古い月は消す）
//   ・載せる商品 = 画面に出している商品＋手動追加の商品＋非表示でも在庫か輸送中がある商品。
//     settings/inventoryBook.excludeFolders（既定 ["060"]＝組み合わせ商品）の品番は載せない
//   ・区分 = teps-2 の商品マスタのグループ。「UF在庫」は上段、それ以外（事務所在庫・その他在庫）は下段「事務所」
//   ・在庫 = FBA / RSL / UF / 事務所 / 輸送中（生産中は含めない）。レート = settings/fx（毎朝 9:00 の TTM。1 日 8:30 時点では月末日の朝の値）
//   ・棚卸単価 = システムの単価（その商品の品番の発注テンプレートの単価）。
//       同じ型番が 2 つ以上のテンプレートに違う単価で登録されている商品（二重登録）は、商品マスタで選んだテンプレート（settings/borders[code].invTpl = 品番3桁）の単価。
//       未選択なら自分の品番のテンプレート（備考に「単価が2件登録」と出す）
//       システムに単価が無い商品は settings/inventoryBook.prices（2026年10月末の棚卸表の単価）で補い、備考に出す。それも無ければ「単価未登録」
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
  const n = (v) => Number(v) || 0;
  const acc = cfg.prices || {};
  const exclude = new Set(Array.isArray(cfg.excludeFolders) ? cfg.excludeFolders : DEFAULT_EXCLUDE);
  const cand = {}, cur = {};   // cand = {型番: [{f: テンプレートの品番, p: 単価}]}
  (await db.collection("templates").get()).forEach((d) => {
    const t = d.data(); cur[d.id] = t.cur || "";
    for (const it of t.items || []) if (it && it.code && Number(it.price) > 0) (cand[it.code] = cand[it.code] || []).push({ f: d.id, p: Number(it.price) });
  });
  // 棚卸単価を決める
  const priceOf = (c, f) => {
    const cs = cand[c] || [], dup = new Set(cs.map((x) => x.p)).size > 1, sel = (policy[c] && policy[c].invTpl) || "";
    const hit = cs.find((x) => x.f === sel) || cs.find((x) => x.f === f) || cs[0];
    if (hit) return { p: hit.p, cur: cur[hit.f] || "", b: dup ? (cs.some((x) => x.f === sel) ? `単価は品番${hit.f}のテンプレート（商品マスタで選択）` : "単価が2件登録（商品マスタで未選択）") : "" };
    const a = acc[c] && n(acc[c].p) > 0 ? acc[c] : null;
    return a ? { p: n(a.p), cur: a.cur || "", b: "システムに単価なし（10月末の棚卸表の単価）" } : { p: 0, cur: "", b: "単価未登録" };
  };
  const fx = (await db.collection("settings").doc("fx").get()).data() || {};

  const list = products.map((p) => ({ ...p }));
  const have = new Set(list.map((p) => p.code));
  for (const [code, d] of Object.entries((snap && snap.items) || {})) if (d && d.manual && !have.has(code)) list.push({ ...d, code });
  const rows = [];
  for (const p of list) {
    const c = p.code, f = (c.match(/ADS(\d{3})/i) || [])[1] || "";
    if (!f || exclude.has(f)) continue;
    const qty = n(p.fba) + n(p.rsl) + n(p.warehouse) + n(p.office) + n(p.transit);
    if (policy[c] && policy[c].hidden === true && qty === 0) continue;   // 非表示で在庫も無い商品は載せない
    const pr = priceOf(c, f);
    rows.push({ c, n: p.name || "", v: p.vari || "", fba: n(p.fba), rsl: n(p.rsl), uf: n(p.warehouse), of: n(p.office), tr: n(p.transit),
      p: pr.p, cur: pr.cur, b: pr.b, s: (groups && groups[c] ? groups[c] : "UF在庫") === "UF在庫" ? 0 : 1 });
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
