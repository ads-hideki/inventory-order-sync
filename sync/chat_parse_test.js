// 判定の確認（実際の書き方をもとにした例）。node chat_parse_test.js
import assert from "node:assert/strict";
import { parseMessage, buildIndex, buildLots, resolveLot, recommend, cleanBody, leadTimes, costTable } from "./lib/esprim.js";

const P = (name, o = {}) => ({ name, vari: "", office: 0, warehouse: 0, fba: 0, rsl: 0, transit: 0, monthly: 0, ...o });
const products = {
  ADS035A: P("キャッシュレス財布"), ADS050A: P("フラップ三つ折り財布"), ADS020A: P("通帳ケース"), ADS044A: P("がま口二つ折り財布"),
  ADS047A: P("スマートキーケース"), ADS011A: P("クラッチバッグ"), ADS032A: P("スマホショルダー"), ADS007A: P("スマホポーチ"),
  ADS002A: P("リュックインバッグ"), ADS003A: P("バッグインバッグ"), ADS024A: P("バッグインバッグ箱型"),
  ADS090C: P("長財布", { vari: "ピスタチオ×シナモン", monthly: 300 }), ADS090F: P("長財布", { vari: "ライトグレージュ×イエロー", monthly: 300, fba: 50 }),
  ADS090A: P("長財布", { vari: "ブラック", monthly: 300, fba: 250, transit: 100 }), ADS090B: P("長財布", { vari: "ネイビー", monthly: 30, fba: 400 }),
};
const index = buildIndex(products, { "リュックインバッグF": "002" });
const t = Math.floor(Date.UTC(2026, 10, 18, 3, 0) / 1000);   // 2026-11-18 12:00 JST
const msg = (body, id = "1") => ({ id, time: t, who: "なな", body });

// 1) 1行に「発注日＋番号＋品名＋状態」
let r = parseMessage(msg(`[To:1]渡津 路子さん
261006発注分035キャッシュレス財布 11/16 弊社に届きました。
261006発注分050フラップ三つ折り財布 11/16 弊社に届きました。
261006発注分047スマートキーケース 11/05到着済、検品中です。`), index);
assert.deepEqual(r.events.map((e) => [e.folder, e.orderDate, e.stage, e.date]),
  [["035", "2026-10-06", "検品待ち", "2026-11-16"], ["050", "2026-10-06", "検品待ち", "2026-11-16"], ["047", "2026-10-06", "検品中", "2026-11-05"]]);

// 2) 商品の行 → 次の行で「上記の商品が到着しました」。番号なしの呼び名は辞書で引く
r = parseMessage(msg(`[To:2]渡津 路子さん
おはようございます。
10.8発注分 リュックインバッグF 1100個（黒300 グレー400 ピンク200 緑200）
上記の商品がエスプリムに到着しました。`), index);
assert.deepEqual(r.events.map((e) => [e.folder, e.orderDate, e.stage, e.qty, e.how]), [["002", "2026-10-08", "検品待ち", 1100, "辞書"]]);

// 3) 引用は読まない（二重計上しない）。「届く予定」は到着予定・入数と箱サイズ
r = parseMessage(msg(`[qt][qtmeta aid=1 time=1]261006発注分035キャッシュレス財布 11/16 弊社に届きました。[/qt]
090財布お急ぎの4色、明日弊社事務所に届く予定です。
OCSで優先出荷数量をご指示いただければ幸いです。

箱サイズ50*40*30cm、1箱120個入りです。`), index);
assert.deepEqual(r.events.map((e) => [e.folder, e.stage, e.date, e.perBox, e.boxCbm]), [["090", "到着予定", "2026-11-19", 120, 0.06]]);

// 4) 箱数・CBM（「011A168個、6箱0.46CBM」）。丸数字つきの日付
r = parseMessage(msg(`261124出荷予定コンテナ分：
クラッチバッグ 011A168個、6箱0.46CBM`), index);
assert.deepEqual(r.events.map((e) => [e.folder, e.code, e.qty, e.boxes, e.cbm, e.stage]), [["011", "ADS011A", 168, 6, 0.46, ""]]);
assert.match(cleanBody("①260916発注分032スマホショルダー"), / 260916発注分032/);

// 5) 関係ない話・数量だけの行は拾わない
r = parseMessage(msg(`今日は38箱を事務所へ発送します。
①260916発注分032スマホショルダー
黒113 モカ8 グレージュ10 ベージュ1 アイボリー3 合計135個
フック60600個、重さは約750kg、工場に直接送ると送料は約900元です。
11月3日積み込みのコンテナが無事に倉庫へ入庫しました。
本日２００万円振り込みましたのでご確認ください。`), index);
assert.equal(r.events.length, 0); assert.equal(r.unknown.length, 0);

// 6) 品番が分からない到着報告は未判定へ。「バッグインバッグ箱型」は長い方の品名に当たる
r = parseMessage(msg(`10.8発注分 台形バッグ 弊社に届きました。\n9.16発注分バッグインバッグ箱型 検品済みです。`), index);
assert.equal(r.unknown.length, 1); assert.equal(r.unknown[0].reason, "品番が分からない");
assert.deepEqual(r.events.map((e) => [e.folder, e.stage]), [["024", "検品済"]]);

// 6-2) サンプルの到着は拾わない
r = parseMessage(msg("リュックインバッグPE ブルーのサンプルがエスプリムに到着しました。"), index);
assert.equal(r.events.length + r.unknown.length, 0);

// 7) ロットへの結び付け
const orders = [
  { id: "a", d: { status: "production", code: "ADS035A", date: "2026-10-06", qty: 500, shipped: 0 } },
  { id: "b", d: { status: "production", code: "ADS090C", date: "2026-10-01", qty: 300, shipped: 0 } },
  { id: "c", d: { status: "production", code: "ADS090F", date: "2026-10-01", qty: 300, shipped: 0 } },
  { id: "d", d: { status: "production", code: "ADS090A", date: "2026-10-01", qty: 300, shipped: 0 } },
  { id: "e", d: { status: "production", code: "ADS090B", date: "2026-10-01", qty: 300, shipped: 0 } },
  { id: "f", d: { status: "production", code: "ADS002A", date: "2026-10-08", qty: 1100, shipped: 1100 } },
  { id: "g", d: { status: "transit", code: "ADS035A", date: "2026-09-01", qty: 100 } },
];
orders.push({ id: "h", d: { status: "production", code: "ADS035A", date: "V2026/09/05", qty: 10, shipped: 0 } }, { id: "i", d: { status: "production", code: "ADS035A", date: "", qty: 10 } });
const lots = buildLots(orders, products);
assert.deepEqual(Object.keys(lots).sort(), ["2026-09-05|035", "2026-10-01|090", "2026-10-06|035"]);   // 「V2026/09/05」も読む・日付なしは飛ばす
assert.equal(resolveLot({ folder: "035", orderDate: "2026-10-06" }, lots).lot.key, "2026-10-06|035");
assert.equal(resolveLot({ folder: "090", orderDate: "" }, lots).lot.key, "2026-10-01|090");
assert.ok(resolveLot({ folder: "035", orderDate: "2026-08-01" }, lots).reason);
assert.ok(resolveLot({ folder: "002", orderDate: "2026-10-08" }, lots).reason);   // 全数出荷済み

// 8) 推奨: 在庫0 → OCS ／ 少ない → OCS ／ 混載で足りる → 混載 ／ 十分 → なし。入数120の箱単位・残数まで
const rec = recommend(lots["2026-10-01|090"], products, { lclDays: 20, containerDays: 40 }, 120);
assert.equal(rec.label, "OCS");
// OCS で混載便が届くまでをつなぎ、混載便でコンテナが届くまでをつなぐ（残数まで）
assert.deepEqual(rec.rows.map((x) => [x.code, x.mode, x.qty, x.days]), [["ADS090C", 2, 240, 0], ["ADS090F", 2, 240, 5], ["ADS090C", 1, 60, 0], ["ADS090F", 1, 60, 5], ["ADS090A", 1, 120, 35]]);
assert.match(rec.detail, /OCS→事務所 ピスタチオ×シナモン 240個/); assert.match(rec.detail, /混載→UF ブラック 120個/);
// 事務所在庫: コンテナは使わない（足りない分 OCS→事務所、残りは全部 混載→事務所）。在庫が十分でも「混載便」
const g = { ADS090C: "事務所在庫", ADS090F: "事務所在庫", ADS090A: "事務所在庫", ADS090B: "事務所在庫" };
const recO = recommend(lots["2026-10-01|090"], products, { lclDays: 20, containerDays: 40 }, 120, null, g);
assert.equal(recO.label, "OCS"); assert.equal(recO.office, "事務所在庫");
assert.deepEqual(recO.rows.map((x) => [x.code, x.mode, x.qty]), [["ADS090C", 2, 240], ["ADS090F", 2, 240], ["ADS090C", 1, 60], ["ADS090F", 1, 60], ["ADS090A", 1, 300]]);
assert.match(recO.detail, /混載→事務所 ブラック 300個/);
const recO2 = recommend({ items: [{ code: "ADS090B", vari: "ネイビー", remain: 300 }] }, products, { lclDays: 20, containerDays: 40 }, 120, null, g);
assert.equal(recO2.label, "混載便"); assert.equal(recO2.rows.length, 0);   // 在庫十分の事務所在庫は「混載便」（内訳なし）

// 9) 参考シート: 輸送日数（80%値・直近180日・5件以上）と原価（品番3桁・サイズ違いは入数の小さい方）
const L = (co, a, b) => ["", "", "", "", "", "", "", "", a, b, "", co];
const lt = leadTimes([...Array(10)].map((_, i) => L("海源", "2026/10/01", `2026/10/${10 + i}`)).concat([...Array(5)].map(() => L("OCS", "2026/11/01", "2026/11/06")), [L("海源コンテナ", "2026/11/01", "2026/11/20")], [L("海源", "2025/01/01", "2025/03/01")]), Date.UTC(2026, 10, 18));
assert.deepEqual(lt, { ocs: { p80: 5, n: 5 }, lcl: { p80: 17, n: 10 } });
const C = (code, c40, lcl, ocs, w) => { const r = Array(23).fill(""); r[0] = code; r[11] = c40; r[12] = lcl; r[13] = ocs; r[22] = w; return r; };
const ct = costTable([C("ADS002-M", "17 ", "22 ", "", "70 "), C("ADS002-L", "20", "27", "", "60"), C("ADS007", "ー", "66", "127", "45"), ["型番"]]);
assert.deepEqual(ct["002"], { cont20: 0, cont40: 17, lcl: 22, ocs: 0, perBox: 60 }); assert.equal(ct["007"].ocs, 127);
const rec2 = recommend(lots["2026-10-01|090"], products, { lclDays: 20, containerDays: 40 }, 120, { cont40: 10, lcl: 30, ocs: 0 });
assert.match(rec2.detail, /OCS料金未登録/); assert.match(rec2.detail, /混載→UF ブラック 120個.*コンテナ比 \+¥2,400/);

// 10) 納期の回答（引用の見出しから品番を取る）
r = parseMessage(msg(`[To:1]Kato さん
[qt][qtmeta aid=1 time=1]ちょうさん
【035 キャッシュレス財布 追加発注】
・納期の目安を教えてください。[/qt]
前金：41.6元*400個＝4992元
納期：30日-35日間ぐらい`), index);
assert.deepEqual(r.leads.map((l) => [l.folder, l.days]), [["035", 35]]); assert.equal(r.events.length, 0);
console.log("OK: 判定の確認 10件");
