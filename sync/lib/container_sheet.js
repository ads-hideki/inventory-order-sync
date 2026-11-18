// エスプリムの「コンテナ計算シート」（担当ごとのタブ: 兪・ナナ・張）を読む。チャットの補助
//   シートの形: 出荷ごとのブロック
//     ,261124出荷：40HQ 梱包済み分,箱数,（ｶｰﾄﾝ入数）,出荷数量,长,宽,高,体积,（ステータス）,メモ   ← 見出し行（列の並びは担当で少し違うので見出しの名前で探す）
//     A,"9.16発注分マザーズトート 1513個\n黒L857…",74,,1513,60,40,50,8.88,検品済,"11/13 混載便 黒L40"
//     ,,1,,,50,40,45,0.09                ← 商品名が空の行は、上の商品の続き（端数の箱）
//     ,合計,…
//   読むのは「まだ出荷していないブロック」だけ: 見出しの日付が6桁で今日より前なら出荷済みとして飛ばす（「2611出荷」「26出荷」のような未確定は読む）
import { takeOrderDate, findProducts } from "./esprim.js";

const STATUS = [[/検品済/, "検品済"], [/検品中/, "検品中"], [/検品待/, "検品待ち"], [/返品/, "返品中"], [/ストップ|停止/, "ストップ"], [/転送/, "転送"]];
const num = (s) => { const n = Number(String(s ?? "").replace(/[,\s]/g, "")); return isFinite(n) ? n : 0; };
// 出荷済みのブロックか（見出しの書き方はばらばら: 261124出荷／2611出荷／26出荷／0828出荷済み／9.20コンテナ出荷済み／9月分コンテナ出荷）
export function isShipped(head, today) {
  const h = head.normalize("NFKC").replace(/\s/g, ""), ym = today.slice(2, 4) + today.slice(5, 7);
  if (/出荷済/.test(h)) return true;
  let m = h.match(/(?<!\d)(\d{6})(?=\D|$)/);
  if (m) return `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}` < today;
  m = h.match(/(?<!\d)(\d{2})(\d{2})(?:\/\d{1,2})?出荷/);                // 2611出荷・2512/24出荷（年月）
  if (m && +m[2] >= 1 && +m[2] <= 12) return m[1] + m[2] < ym;
  m = h.match(/(\d{1,2})月分/);                                       // 9月分コンテナ出荷
  if (m) { const mo = +m[1], cur = +today.slice(5, 7); return mo !== cur && (cur - mo + 12) % 12 <= 6; }
  return false;                                                       // 26出荷・260出荷 など未確定は読む
}
const findCol = (h, re) => h.findIndex((c, i) => i >= 2 && re.test(String(c || "").replace(/\s/g, "")));

export function parseContainerTab(rows, index, today) {
  const items = [], unknown = []; let blk = null, cur = null;
  const flush = () => { if (cur) items.push(cur); cur = null; };
  for (const r0 of rows || []) {
    const r = r0.map((c) => String(c ?? "").normalize("NFKC").trim()), at = (i) => (i >= 0 && r[i]) || "";
    const b = r[1] || "";
    // 見出し行
    if (/出荷/.test(b) && r.some((c) => /^箱数$/.test(c.replace(/\s/g, "")))) {
      flush();
      blk = isShipped(b, today) ? null : {
        label: (b.split(/[：:]/)[0] || b).replace(/\s/g, ""),
        box: findCol(r, /^箱数$/), per: findCol(r, /入数/), qty: findCol(r, /出荷数量/), cbm: findCol(r, /体积|体積/),
        st: findCol(r, /ステータス/), memo: findCol(r, /^メモ$/),
      };
      continue;
    }
    if (!blk) continue;
    if (/^合計|纸箱|紙箱/.test(b) || /^合計/.test(r[0])) { flush(); continue; }
    const boxes = num(at(blk.box)), cbm = num(at(blk.cbm));
    if (!b) { if (cur && (boxes || cbm)) { cur.boxes += boxes; cur.cbm += cbm; cur.qty += num(at(blk.qty)); } continue; }
    flush();
    if (!boxes && !cbm) continue;   // 空の雛形の行
    // ステータス: ステータス列 → 無ければメモ列の先頭（兪・張のシートはメモ列に「検品済」と書く）
    const stText = at(blk.st) || at(blk.memo);
    const stage = (STATUS.find(([re]) => re.test(stText)) || [, ""])[1];
    const memo = (blk.st >= 0 ? [at(blk.memo), at(blk.memo + 1)] : [at(blk.memo + 1)]).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 120);
    const first = b.split(/\n/)[0];
    const od = takeOrderDate(first, today);
    const { list } = findProducts(od.rest, index);
    cur = { text: b.replace(/\s+/g, " ").slice(0, 160), label: blk.label, stage, stText: stText.slice(0, 20), memo,
      boxes, cbm, qty: num(at(blk.qty)), perBox: num(at(blk.per)), orderDate: od.date, folder: list.length === 1 ? list[0].folder : "",
      many: list.length > 1 };
  }
  flush();
  for (const it of items) it.cbm = Math.round(it.cbm * 100) / 100;
  return items;
}
