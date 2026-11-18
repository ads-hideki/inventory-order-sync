// エスプリム（中国の代行会社）とのチャットを読み、「エスプリム在庫」スプレッドシートを更新する。
//   起動: VPS の cron → gh-dispatch.sh chat-sync.yml（9:50〜19:50 の2時間おき）
//   1) Chatwork の対象ルームから新しいメッセージを読む（1ルーム直近100件まで。API の上限）
//   2) 到着予定／検品待ち／検品中／検品済・箱数・CBM・入数・納期の回答を拾う（lib/esprim.js。AI は使わない）。チャットが基準
//   3) エスプリムのコンテナ計算シート（担当ごとのタブ）で補う。更新漏れがあるので状態はチャットを優先
//   4) タブ「エスプリム在庫」= エスプリムにいまある商品だけ（一元管理に発注が無くても載せる）。OCS／混載便／コンテナ の推奨つき
//      teps-2 のグループが「事務所在庫」の商品はコンテナを使わない（混載便か OCS）。OCS の行き先はいつも事務所
//      タブ「生産管理」    = 一元管理の生産中のうち、まだエスプリムに無いもの。到着予定（チャットの到着予定 → 納期の回答 → リードタイム目安）
//   5) 設定があれば、新しく到着した低在庫の商品を Chatwork に通知する
//   ※ チャットの本文・品番・数量は実行ログに出さない（このリポジトリは公開で、実行ログは誰でも見られる）。ログは件数だけ
//   ※ Firestore の読み書きは 1 回あたり 読み取り約6〜10件・書き込み1件（まとめ文書 cache/* を使う）
// 設定: Firestore settings/chatSync（公開リポジトリにルームID・シートIDを書かないため）
//   { rooms: [{id, label}], sheetId, notifyRoomId?, containerCbm?,
//     leadSheet?: {id, range}  … 発注・入庫の入力シート（出荷日 I・入庫日 J・輸送会社 L）。輸送方法ごとの日数（直近180日の80%値）を出す
//     costSheet?: {id, range}  … 原価シート（40ft L・混載便 M・OCS N・国際入数 W）。1個あたりの送料差と入数に使う
//     containerTabs?: [{range, room}] … エスプリムのコンテナ計算シート（担当ごとのタブを IMPORTRANGE で取り込んだもの）
//     sheetOnlyRows?: false … チャットに出てこない商品を、コンテナ計算シートだけを根拠に載せない（既定は載せる。出所「シート」）
//     safetyDays? … 欠品しないための余裕の日数（既定 3）。OCS は「混載便が届くまで＋余裕」、混載便は「コンテナが届くまで＋余裕」の分
//     lclWait?, containerWait? … 混載便・コンテナの出荷待ちの日数（既定 3・7）。lclDays/containerDays は入力シートが読めない時の日数 }
//   参考シートはエスプリム在庫シートのタブ「参考_*」に IMPORTRANGE で取り込み、そこから読む（--setup --refs=here）
// 鍵:   CHATWORK_API_TOKEN（GitHub Secret）／ FIREBASE_SERVICE_ACCOUNT（daily-sync と同じ）
// 使い方: node chat_sync.js [--dry-run] [--format]
//         node chat_sync.js --setup --sheet=<スプレッドシートID> --rooms=<ルームID>:<担当>,… / --refs=here / --notify=<ルームID>
import { fetchMessages, postMessage, newerId } from "./lib/chatwork.js";
import { parseMessage, buildIndex, buildLots, resolveLot, recommend, leadTimes, costTable, costNames, AT_ESPRIM } from "./lib/esprim.js";
import { openSheet, writeSheet, FORMAT_VER } from "./lib/esprim_sheet.js";
import { parseContainerTab } from "./lib/container_sheet.js";
import { fetchGroups } from "./lib/teps_groups.js";
import { initFirestore, readSnapshotProducts } from "./lib/firestore.js";

const DRY = process.argv.includes("--dry-run");
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ""; };
const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
const DEF = { lclDays: 16, containerDays: 29, lclWait: 3, containerWait: 7, containerCbm: 68, safetyDays: 3 };   // safetyDays: 欠品しないための余裕（日）   // lclDays/containerDays は入力シートが読めない時の日数（2026-11 の実績: 混載13＋3・コンテナ22＋7）

// 生産中の発注（まとめ文書＋その後に画面で変わった分。画面と同じ読み方で、読み取りを数件に抑える）
async function readOpenOrders(db, meta) {
  const map = new Map(); const n = (meta.chunks && meta.chunks.orders) || 0; let ok = !!(meta.buildId && n);
  for (let i = 0; ok && i < n; i++) {
    const d = await db.collection("cache").doc(`orders_${meta.buildId}_${i}`).get();
    if (!d.exists) { ok = false; break; }
    for (const it of d.data().items || []) map.set(it.id, it.d);
  }
  if (!ok) { map.clear(); (await db.collection("orders").where("status", "==", "production").get()).forEach((d) => map.set(d.id, d.data())); }
  else if (meta.builtAt) {
    (await db.collection("orders").where("updatedAt", ">", meta.builtAt).get()).forEach((d) => map.set(d.id, d.data()));
    for (const id of Object.keys((meta.tomb && meta.tomb.orders) || {})) map.delete(id);
  }
  return [...map].map(([id, d]) => ({ id, d }));
}

async function setup(db) {
  const rooms = arg("rooms").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [id, label] = x.split(":"); return { id: id.trim(), label: (label || "").trim() }; });
  const patch = {}; if (rooms.length) patch.rooms = rooms; if (arg("sheet")) patch.sheetId = arg("sheet"); if (arg("notify")) patch.notifyRoomId = arg("notify");
  if (arg("lead")) patch.leadSheet = { id: arg("lead"), range: "入力シート!A2:L" };
  if (arg("cost")) patch.costSheet = { id: arg("cost"), range: "原価!A3:W" };
  // --refs=here … 参考シートを共有せず、エスプリム在庫シートのタブ「参考_入力」「参考_原価」（IMPORTRANGE で取り込んだもの）から読む
  if (arg("refs") === "here") {
    const id = patch.sheetId || ((await db.collection("settings").doc("chatSync").get()).data() || {}).sheetId;
    if (!id) throw new Error("先に --sheet= でエスプリム在庫シートを登録してください");
    patch.leadSheet = { id, range: "参考_入力!A1:L" }; patch.costSheet = { id, range: "参考_原価!A1:W" };
    patch.containerTabs = [{ range: "参考_兪!A1:L", room: "1" }, { range: "参考_ナナ!A1:L", room: "2" }, { range: "参考_張!A1:L", room: "3" }];
  }
  if (!Object.keys(patch).length) throw new Error("--sheet= / --rooms= / --lead= / --cost= / --refs=here / --notify= のどれかを指定してください");
  await db.collection("settings").doc("chatSync").set({ ...patch, updatedAt: new Date() }, { merge: true });
  console.log(`[chat] 設定を保存しました（${Object.keys(patch).join("・")}）`);
}

async function main() {
  const t0 = Date.now(), db = initFirestore();
  if (process.argv.includes("--setup")) return setup(db);
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) throw new Error("CHATWORK_API_TOKEN がありません");
  const cfg = { ...DEF, ...((await db.collection("settings").doc("chatSync").get()).data() || {}) };
  if (!Array.isArray(cfg.rooms) || !cfg.rooms.length) throw new Error("settings/chatSync に rooms がありません（node chat_sync.js --setup で登録）");

  const stateRef = db.collection("chat_state").doc("esprim");
  const state = { last: {}, items: null, eta: {}, unknown: [], box: {}, ...((await stateRef.get()).data() || {}) };
  const meta = (await db.collection("cache").doc("meta").get()).data() || {};
  const products = (await readSnapshotProducts(db, meta)).items;
  const lots = buildLots(await readOpenOrders(db, meta), products);

  const sh = cfg.sheetId ? await openSheet(cfg.sheetId) : null;

  // 参考シート（輸送日数・送料・入数）。読めなくても続ける
  let lead = {}, costs = {}, cnames = {};
  const readRange = async (ref, def) => { const r = await sh.call("GET", `${ref.id}/values/${encodeURIComponent(ref.range || def)}`); return r.values || []; };
  if (sh && cfg.leadSheet && cfg.leadSheet.id) try { lead = leadTimes(await readRange(cfg.leadSheet, "入力シート!A2:L")); } catch (e) { console.error("[chat] 入力シート（輸送日数）を読めません（続行）:", e.message); }
  if (sh && cfg.costSheet && cfg.costSheet.id) try { const cr = await readRange(cfg.costSheet, "原価!A3:W"); costs = costTable(cr); cnames = costNames(cr); } catch (e) { console.error("[chat] 原価シートを読めません（続行）:", e.message); }
  // teps-2 のグループ（事務所在庫はコンテナを使わない）。1日1回だけ読む
  const todayJ = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  if (state.groupsDate !== todayJ) try { state.groups = await fetchGroups(); state.groupsDate = todayJ; } catch (e) { console.error("[chat] teps-2 のグループを読めません（前回の値で続行）:", e.message); }
  const groups = state.groups || {};
  // 呼び名の索引: 一元管理の品名 ＋ 原価シートの商品名 ＋ 辞書タブ（辞書が優先）
  const index = buildIndex(products, { ...cnames, ...(sh ? sh.aliases : {}) });
  if (lead.lcl) cfg.lclDays = lead.lcl.p80 + cfg.lclWait;
  if (lead.container) cfg.containerDays = lead.container.p80 + cfg.containerWait;
  if (lead.ocs) cfg.ocsDays = lead.ocs.p80;
  const basis = `推奨の基準: OCS ${lead.ocs ? lead.ocs.p80 + "日" : "-"}／混載便 ${lead.lcl ? `${lead.lcl.p80}日＋出荷待ち${cfg.lclWait}日` : cfg.lclDays + "日（仮）"}／コンテナ ${lead.container ? `${lead.container.p80}日＋出荷待ち${cfg.containerWait}日` : cfg.containerDays + "日（仮）"}（入力シートの直近180日・80%値）＋余裕${cfg.safetyDays}日`;

  // 1) 新しいメッセージ（前回の続きは message_id で判定）＋ 前回までの未判定（辞書が増えていれば拾える）
  const events = [], unknown = [], leadReplies = []; let fetched = 0, fresh = 0, failed = 0;
  const take = (r, room) => { for (const e of r.events) events.push({ ...e, room }); for (const u of r.unknown) unknown.push({ ...u, room }); for (const l of r.leads || []) leadReplies.push(l); };
  for (const u of state.unknown) if (Date.now() / 1000 - u.time < 30 * 86400) take(parseMessage({ id: u.msgId, time: u.time, who: u.who, body: u.text }, index), u.room);
  for (const room of cfg.rooms) {
    try {
      const list = await fetchMessages(token, room.id); fetched += list.length;
      let last = state.last[room.id] || "0";
      for (const m of list) {
        if (!newerId(m.id, state.last[room.id])) continue;
        fresh++; take(parseMessage(m, index), room.label || ""); if (newerId(m.id, last)) last = m.id;
      }
      state.last[room.id] = last;
    } catch (e) { failed++; console.error("[chat] 取得に失敗（続行）:", e.message); }
  }

  // 2) チャットの報告を「発注日|品番」ごとにまとめる（チャットが基準）。
  //    一元管理（発注管理）の生産中と結び付けば残数・色別がわかる。結び付かなくても（未登録・修理分など）エスプリム在庫には載せる
  const keyOf = (x) => { const r = resolveLot(x, lots); return r.lot ? { key: r.lot.key, lot: r.lot } : { key: `${x.orderDate || "日付不明"}|${x.folder}`, lot: null }; };
  const items = (state.items ||= state.lots || {}); const eta = (state.eta ||= {});
  events.sort((a, b) => a.time - b.time);
  let applied = 0; const arrived = new Set();
  for (const e of events) {
    const { key, lot } = keyOf(e);
    const s = (items[key] ||= { stage: "", folder: e.folder, orderDate: lot ? lot.date : e.orderDate }), was = s.stage;
    if (lot) s.matched = true;
    if (e.stage && (!s.time || e.time >= s.time)) {
      s.stage = e.stage; s.time = e.time; s.who = e.who; s.text = e.text;
      if (e.stage === "到着予定") s.eta = e.date; else if (!s.arrive || e.stage === "検品待ち") s.arrive = e.date;
      if (AT_ESPRIM.has(s.stage) && !AT_ESPRIM.has(was)) arrived.add(key);
    }
    if (e.qty && !lot) s.qty = e.qty;
    if (e.room) s.room = e.room;
    if (e.boxes) { s.boxes = e.boxes; s.cbm = e.cbm; }
    const b = (state.box[e.folder] ||= {}); if (e.perBox) b.perBox = e.perBox; if (e.boxCbm) b.boxCbm = e.boxCbm;
    s.upd = Date.now(); applied++;
  }
  // 納期の回答 → 生産管理の到着予定（その品番の、回答日の少し前〜20日前に発注した生産中）
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
  const addDays = (d, n) => { const t = Date.parse(d); return isNaN(t) ? "" : new Date(t + n * 86400000).toISOString().slice(0, 10); };
  for (const l of leadReplies) {
    const lot = Object.values(lots).filter((x) => x.folder === l.folder && dayDiff(l.date, x.date) >= -3 && dayDiff(l.date, x.date) <= 20).sort((x, y) => (x.date < y.date ? 1 : -1))[0];
    if (lot) eta[lot.key] = { date: addDays(lot.date, l.days), days: l.days, at: l.time };
  }

  // 2-b) コンテナ計算シート（エスプリム記入・補助）。更新漏れがあるので状態はチャットを優先し、チャットに無い分だけシートで補う。箱数・CBM・入数はシートの実数
  const sheetLot = {}, sheetUnknown = []; let sheetItems = 0;
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  for (const t of (sh && cfg.containerTabs) || []) {
    let list = [];
    try { list = parseContainerTab((await sh.call("GET", `${cfg.sheetId}/values/${encodeURIComponent(t.range)}`)).values || [], index, today); }
    catch (e) { console.error("[chat] コンテナ計算シートを読めません（続行）:", e.message); continue; }
    for (const it of list) {
      sheetItems++;
      if (!it.folder) { if (it.stage !== "返品中") sheetUnknown.push({ reason: "コンテナ計算シート: " + (it.many ? "品番が2つ以上書かれている" : "品番が分からない"), time: 0, at: `（シート ${it.label}）`, room: t.room, who: "", text: it.text }); continue; }
      const { key } = keyOf(it);
      const L = (sheetLot[key] ||= { room: t.room, folder: it.folder, orderDate: it.orderDate, parts: [], boxes: 0, cbm: 0, qty: 0, perBox: 0, best: null, text: it.text });
      L.parts.push(`${it.label} ${it.stage || it.stText || "-"} ${it.boxes}箱 ${it.cbm}CBM${it.memo ? "（" + it.memo + "）" : ""}`);
      if (AT_ESPRIM.has(it.stage)) { L.boxes += it.boxes; L.cbm += it.cbm; L.qty += it.qty; }
      if (it.perBox) L.perBox = it.perBox;
      if (AT_ESPRIM.has(it.stage) && (!L.best || it.boxes > L.best.boxes)) L.best = it;
    }
  }

  // 3) エスプリム在庫（エスプリムにいまある商品だけ）
  const keep = (sh && sh.keep) || {}, keepProd = (sh && sh.keepProd) || {};
  const folderName = (f) => { const p = Object.entries(products).find(([c, x]) => (x.folder || c.slice(3, 6)) === f && x.name); return p ? p[1].name : ""; };
  const folderCodes = (f) => Object.entries(products).filter(([c, x]) => (x.folder || c.slice(3, 6)) === f && !x.tepsDeleted).map(([c, x]) => ({ code: c, vari: x.vari || "" }));
  const stockKeys = new Set([
    ...Object.keys(items).filter((k) => AT_ESPRIM.has(items[k].stage)),
    ...Object.keys(sheetLot).filter((k) => sheetLot[k].best && (cfg.sheetOnlyRows !== false || AT_ESPRIM.has((items[k] || {}).stage))),   // sheetOnlyRows=false でチャットに無い商品はシートだけでは載せない
    ...Object.keys(keep).filter((k) => AT_ESPRIM.has(String(keep[k].over || "").trim())),
  ]);
  const rows = []; let shippedOut = 0;
  for (const key of stockKeys) {
    const s = items[key] || {}, sl = sheetLot[key], k = keep[key] || {}, lot = lots[key];
    const [date, folder] = key.split("|");
    const over = String(k.over || "").trim();
    if (over === "出荷済") continue;                                            // 手入力で外す
    if (s.matched && !lot) { shippedOut++; continue; }                           // 一元管理で輸送中（インボイス取込）になった＝もうエスプリムに無い
    if (!lot && !sl && Date.now() - (s.upd || 0) > 45 * 86400000) continue;      // 一元管理に無く、45日報告もシートも無い
    const fromChat = AT_ESPRIM.has(s.stage);
    const stage = over || (fromChat ? s.stage : sl.best.stage);
    const b = state.box[folder] || {}, c = costs[folder];
    const perBox = Number(b.perBox) || (sl && sl.perBox) || Number(k.perBox) || (c && c.perBox) || 0;
    const qty = lot ? lot.remain : (s.qty || (sl && sl.qty) || 0);
    let boxes = (sl && sl.boxes) || s.boxes || 0, cbm = (sl && Math.round(sl.cbm * 100) / 100) || s.cbm || 0;
    if (!boxes && perBox && qty) { boxes = Math.ceil(qty / perBox); if (b.boxCbm) cbm = Math.round(boxes * b.boxCbm * 100) / 100; }
    const recLot = lot || { items: folderCodes(folder).map((x) => ({ ...x, remain: qty || 1e9 })) };
    const rec = AT_ESPRIM.has(stage) ? recommend(recLot, products, cfg, perBox, c, groups) : null;
    rows.push({ key, room: s.room || (sl && sl.room) || "", stage, date: date === "日付不明" ? "" : date, folder, name: (lot && lot.name) || folderName(folder), remain: qty || "",
      items: lot ? lot.items.map((i) => `${i.vari || i.code} ${i.remain}`).join("、") : "",
      arrive: (s.arrive || "").slice(5).replace("-", "/"), boxes, cbm, perBox,
      rec: rec ? rec.label : "", recSummary: rec ? rec.summary : "", recDetail: rec ? (rec.office !== "UF在庫" ? `【${rec.office}：コンテナ不可】\n` : "") + rec.detail : "", minDays: rec ? rec.minDays : null,
      source: [fromChat ? "チャット" : "", sl ? "シート" : "", lot ? "" : "（一元管理に発注なし）"].filter(Boolean).join("＋").replace("＋（", "（"),
      sheet: sl ? sl.parts.join("\n") : "", text: s.text || (sl ? sl.text : ""), at: s.time ? jst(s.time * 1000) : "", _rec: rec, _new: arrived.has(key) });
  }
  const order = (st) => ({ "検品待ち": 0, "転送": 0, "検品中": 1, "検品済": 2 }[st] ?? 3);
  rows.sort((a, b) => order(a.stage) - order(b.stage) || (a.rec === b.rec ? 0 : a.rec === "OCS" ? -1 : b.rec === "OCS" ? 1 : a.rec === "混載便" ? -1 : 1) || (a.date < b.date ? -1 : 1));

  // 3-b) 生産管理（一元管理の生産中のうち、まだエスプリムに無いもの）＋到着予定
  const shown = new Set(rows.map((r) => r.key)), prodRows = [];
  for (const lot of Object.values(lots)) {
    if (shown.has(lot.key)) continue;
    const s = items[lot.key] || {}, e2 = eta[lot.key], p0 = products[lot.items[0].code] || {};
    let etaDate = "", why = "";
    if (s.stage === "到着予定" && s.eta) { etaDate = s.eta; why = "チャット（到着予定）"; }
    else if (e2) { etaDate = e2.date; why = `納期の回答 ${e2.days}日`; }
    else if (Number(p0.lead) > 0) { etaDate = addDays(lot.date, Number(p0.lead)); why = `リードタイム目安 ${p0.lead}日`; }
    prodRows.push({ key: lot.key, room: s.room || "", date: lot.date, folder: lot.folder, name: lot.name, remain: lot.remain, supplier: lot.supplier || "",
      items: lot.items.map((i) => `${i.vari || i.code} ${i.remain}`).join("、"), elapsed: dayDiff(today, lot.date), eta: etaDate, why, late: etaDate && etaDate < today, text: s.text || "" });
  }
  prodRows.sort((a, b) => (a.eta || "9999") < (b.eta || "9999") ? -1 : (a.eta || "9999") > (b.eta || "9999") ? 1 : a.date < b.date ? -1 : 1);

  // 未判定（品番が分からない報告だけ）は新しい順に 150 件まで
  const seen = new Set();
  state.unknown = unknown.sort((a, b) => b.time - a.time).filter((u) => { const k2 = u.msgId + "|" + u.text; if (seen.has(k2)) return false; seen.add(k2); return true; }).slice(0, 150)
    .map((u) => ({ reason: u.reason, msgId: u.msgId, time: u.time, who: u.who || "", room: u.room || "", text: u.text }));
  for (const k2 of Object.keys(items)) if (!lots[k2] && Date.now() - (items[k2].upd || 0) > 60 * 86400000) delete items[k2];
  for (const k2 of Object.keys(eta)) if (!lots[k2]) delete eta[k2];

  const count = {}; for (const r of rows) count[r.stage] = (count[r.stage] || 0) + 1;
  const summary = `参考シート 輸送日数${Object.keys(lead).length ? "あり" : "なし"}・原価${Object.keys(costs).length ? Object.keys(costs).length + "品番" : "なし"}・コンテナ計算 ${sheetItems}行（品番不明 ${sheetUnknown.length}）・teps-2 事務所在庫 ${Object.values(groups).filter((g) => g === "事務所在庫").length}品 ／ メッセージ ${fetched}件（新規 ${fresh}）／ 報告 ${applied}件・納期 ${leadReplies.length}件 ／ エスプリム在庫 ${rows.length}件（${Object.entries(count).map(([k2, v]) => `${k2}${v}`).join("・")}・一元管理で出荷済み ${shippedOut}）／ 生産管理 ${prodRows.length}件 ／ 未判定 ${state.unknown.length + sheetUnknown.length}件 ／ 推奨 OCS ${rows.filter((r) => r.rec === "OCS").length}・混載便 ${rows.filter((r) => r.rec === "混載便").length}`;
  if (DRY) { console.log(`[chat] ${summary}`); console.log("[chat] DRY-RUN のため書き込みなし"); return; }

  // 4) 書き出し・通知・状態の保存
  const format = sh && (state.formatVer !== FORMAT_VER || state.formatSheet !== cfg.sheetId || process.argv.includes("--format"));
  if (sh) await writeSheet(sh, { rows, prodRows, unknown: state.unknown.map((u) => ({ ...u, at: jst(u.time * 1000) })).concat(sheetUnknown), now: jst(Date.now()), cap: cfg.containerCbm, basis, format });
  if (format) { state.formatVer = FORMAT_VER; state.formatSheet = cfg.sheetId; }
  const alerts = rows.filter((r) => r._new && r._rec && r._rec.mode > 0);
  let notified = 0;
  if (cfg.notifyRoomId && alerts.length) {
    const body = "[info][title]エスプリム到着：在庫が少ない商品があります（自動）[/title]" +
      alerts.map((r) => `■ ${r.folder} ${r.name}（${r.date ? r.date.slice(5).replace("-", "/") + "発注分・" : ""}${r.stage}）→ ${r.rec} 推奨\n${r.recDetail}`).join("\n\n") + "[/info]";
    try { await postMessage(token, cfg.notifyRoomId, body); notified = alerts.length; } catch (e) { console.error("[chat] 通知に失敗（続行）:", e.message); }
  }
  await stateRef.set({ last: state.last, items: state.items, eta: state.eta, lots: null, unknown: state.unknown, box: state.box, groups: state.groups || {}, groupsDate: state.groupsDate || "", formatVer: state.formatVer || 0, formatSheet: state.formatSheet || "", updatedAt: new Date(), summary });
  console.log(`[chat] ${summary}${notified ? ` ／ 通知 ${notified}件` : ""}${sh ? "" : " ／ シート未設定"}`);
  console.log(`[chat] 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed === cfg.rooms.length) process.exit(1);
}

main().catch((e) => { console.error("[chat] エラー:", e.message); process.exit(1); });
