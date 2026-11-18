// エスプリム（中国の代行会社）とのチャットを読み、生産中の発注ごとの状態を「エスプリム在庫」スプレッドシートにまとめる。
//   起動: VPS の cron → gh-dispatch.sh chat-sync.yml（2〜3時間おき）
//   1) Chatwork の対象ルームから新しいメッセージを読む（1ルーム直近100件まで。API の上限）
//   2) 到着予定／検品待ち／検品中／検品済・箱数・CBM・入数の報告を拾い、「発注日＋品番3桁」で生産中の発注に結び付ける（lib/esprim.js。AI は使わない）
//   3) エスプリムに現物がある発注について、国内在庫と販売数から OCS／混載便／コンテナ の推奨を出す
//   4) スプレッドシートに書き出す（手入力の列は残す）。設定があれば、新しく到着した低在庫の商品を Chatwork に通知する
//   ※ チャットの本文・品番・数量は実行ログに出さない（このリポジトリは公開で、実行ログは誰でも見られる）。ログは件数だけ
//   ※ Firestore の読み書きは 1 回あたり 読み取り約6〜10件・書き込み1件（まとめ文書 cache/* を使う）
// 設定: Firestore settings/chatSync（公開リポジトリにルームID・シートIDを書かないため）
//   { rooms: [{id, label}], sheetId, notifyRoomId?, lclDays?, containerDays?, containerCbm? }
// 鍵:   CHATWORK_API_TOKEN（GitHub Secret）／ FIREBASE_SERVICE_ACCOUNT（daily-sync と同じ）
// 使い方: node chat_sync.js [--dry-run]
//         node chat_sync.js --setup --sheet=<スプレッドシートID> --rooms=<ルームID>:<担当>,<ルームID>:<担当>…   （設定を保存するだけ）
import { fetchMessages, postMessage, newerId } from "./lib/chatwork.js";
import { parseMessage, buildIndex, buildLots, resolveLot, recommend, STAGES, AT_ESPRIM } from "./lib/esprim.js";
import { openSheet, writeSheet } from "./lib/esprim_sheet.js";
import { initFirestore, readSnapshotProducts } from "./lib/firestore.js";

const DRY = process.argv.includes("--dry-run");
const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ""; };
const jst = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
const DEF = { lclDays: 20, containerDays: 40, containerCbm: 68 };   // 仮の値。混載便・コンテナで売り場に並ぶまでの日数（担当者に確認して settings/chatSync で直す）

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
  if (!Object.keys(patch).length) throw new Error("--sheet= か --rooms= を指定してください");
  await db.collection("settings").doc("chatSync").set({ ...patch, updatedAt: new Date() }, { merge: true });
  console.log(`[chat] 設定を保存しました（ルーム ${rooms.length || "変更なし"}・シート ${patch.sheetId ? "あり" : "変更なし"}）`);
}

async function main() {
  const t0 = Date.now(), db = initFirestore();
  if (process.argv.includes("--setup")) return setup(db);
  const token = process.env.CHATWORK_API_TOKEN;
  if (!token) throw new Error("CHATWORK_API_TOKEN がありません");
  const cfg = { ...DEF, ...((await db.collection("settings").doc("chatSync").get()).data() || {}) };
  if (!Array.isArray(cfg.rooms) || !cfg.rooms.length) throw new Error("settings/chatSync に rooms がありません（node chat_sync.js --setup で登録）");

  const stateRef = db.collection("chat_state").doc("esprim");
  const state = { last: {}, lots: {}, unknown: [], box: {}, ...((await stateRef.get()).data() || {}) };
  const meta = (await db.collection("cache").doc("meta").get()).data() || {};
  const products = (await readSnapshotProducts(db, meta)).items;
  const lots = buildLots(await readOpenOrders(db, meta), products);

  const sh = cfg.sheetId ? await openSheet(cfg.sheetId) : null;
  const index = buildIndex(products, sh ? sh.aliases : {});

  // 1) 新しいメッセージ（前回の続きは message_id で判定）＋ 前回までの未判定（辞書が増えていれば拾える）
  const events = [], unknown = []; let fetched = 0, fresh = 0, failed = 0;
  const take = (r, room) => { for (const e of r.events) events.push({ ...e, room }); for (const u of r.unknown) unknown.push({ ...u, room }); };
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

  // 2) 発注ロットに結び付ける（古い順）。状態は新しい報告で上書き。箱数・入数は品番ごとにも覚える
  events.sort((a, b) => a.time - b.time);
  let applied = 0; const arrived = new Set();
  for (const e of events) {
    const r = resolveLot(e, lots);
    if (!r.lot) { if (e.stage) unknown.push({ reason: r.reason, stage: e.stage, msgId: e.msgId, time: e.time, who: e.who, room: e.room, text: e.text }); continue; }
    const s = (state.lots[r.lot.key] ||= { stage: "生産中" }), was = s.stage;
    if (e.stage && (!s.time || e.time >= s.time)) {
      s.stage = e.stage; s.time = e.time; s.who = e.who; s.text = e.text;
      if (e.stage === "到着予定") s.eta = e.date; else if (!s.arrive || e.stage === "検品待ち") s.arrive = e.date;
      if (AT_ESPRIM.has(s.stage) && !AT_ESPRIM.has(was)) arrived.add(r.lot.key);
    }
    if (e.room) s.room = e.room;
    if (e.boxes) { s.boxes = e.boxes; s.cbm = e.cbm; }
    const b = (state.box[e.folder] ||= {}); if (e.perBox) b.perBox = e.perBox; if (e.boxCbm) b.boxCbm = e.boxCbm;
    s.upd = Date.now(); applied++;
  }

  // 3) 1行 = 生産中の発注ロット。エスプリムに現物があるものに推奨を付ける
  const rows = [];
  for (const lot of Object.values(lots)) {
    const s = state.lots[lot.key] || { stage: "生産中" }, k = (sh && sh.keep[lot.key]) || {}, b = state.box[lot.folder] || {};
    const stage = String(k.over || "").trim() || s.stage, perBox = Number(b.perBox) || Number(k.perBox) || 0;
    let boxes = s.boxes || 0, cbm = s.cbm || 0;
    if (!boxes && perBox && AT_ESPRIM.has(stage)) { boxes = Math.ceil(lot.remain / perBox); if (b.boxCbm) cbm = Math.round(boxes * b.boxCbm * 100) / 100; }   // 報告が無ければ 残数÷入数 の目安
    const rec = AT_ESPRIM.has(stage) ? recommend(lot, products, cfg, perBox) : null;
    rows.push({ key: lot.key, room: s.room || "", stage, date: lot.date, folder: lot.folder, name: lot.name, remain: lot.remain,
      items: lot.items.map((i) => `${i.vari || i.code} ${i.remain}`).join("、"),
      arrive: stage === "到着予定" ? (s.eta ? `${s.eta.slice(5).replace("-", "/")} 予定` : "") : (s.arrive || "").slice(5).replace("-", "/"),
      boxes, cbm, perBox, rec: rec ? rec.label : "", recDetail: rec ? rec.detail : "", minDays: rec ? rec.minDays : null,
      text: s.text || "", at: s.time ? jst(s.time * 1000) : "", _rec: rec, _new: arrived.has(lot.key) });
  }
  const order = (st) => { const i = STAGES.indexOf(st); return i < 0 ? 2.5 : i; };
  rows.sort((a, b) => order(b.stage) - order(a.stage) || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.folder < b.folder ? -1 : 1));

  // 未判定は新しい順に 150 件まで。同じメッセージ・同じ本文は 1 つにする
  const seen = new Set();
  state.unknown = unknown.sort((a, b) => b.time - a.time).filter((u) => { const key = u.msgId + "|" + u.text; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 150)
    .map((u) => ({ reason: u.reason, msgId: u.msgId, time: u.time, who: u.who || "", room: u.room || "", text: u.text }));
  // 出荷が終わって 45 日たった発注の記録は消す
  for (const key of Object.keys(state.lots)) if (!lots[key] && Date.now() - (state.lots[key].upd || 0) > 45 * 86400000) delete state.lots[key];

  const count = {}; for (const r of rows) count[r.stage] = (count[r.stage] || 0) + 1;
  const summary = `メッセージ ${fetched}件（新規 ${fresh}）／ 報告 ${applied}件を反映 ／ 未判定 ${state.unknown.length}件 ／ 発注ロット ${rows.length}件（${Object.entries(count).map(([k, v]) => `${k}${v}`).join("・")}）／ 推奨 OCS ${rows.filter((r) => r.rec === "OCS").length}・混載便 ${rows.filter((r) => r.rec === "混載便").length}`;
  if (DRY) { console.log(`[chat] ${summary}`); console.log("[chat] DRY-RUN のため書き込みなし"); return; }

  // 4) 書き出し・通知・状態の保存
  if (sh) await writeSheet(sh, { rows, unknown: state.unknown.map((u) => ({ ...u, at: jst(u.time * 1000) })), now: jst(Date.now()), cap: cfg.containerCbm });
  const alerts = rows.filter((r) => r._new && r._rec && r._rec.mode > 0);
  let notified = 0;
  if (cfg.notifyRoomId && alerts.length) {
    const body = "[info][title]エスプリム到着：在庫が少ない商品があります（自動）[/title]" +
      alerts.map((r) => `■ ${r.folder} ${r.name}（${r.date.slice(5).replace("-", "/")}発注分・${r.stage}）→ ${r.rec} 推奨\n${r.recDetail}`).join("\n\n") + "[/info]";
    try { await postMessage(token, cfg.notifyRoomId, body); notified = alerts.length; } catch (e) { console.error("[chat] 通知に失敗（続行）:", e.message); }
  }
  await stateRef.set({ last: state.last, lots: state.lots, unknown: state.unknown, box: state.box, updatedAt: new Date(), summary });
  console.log(`[chat] ${summary}${notified ? ` ／ 通知 ${notified}件` : ""}${sh ? "" : " ／ シート未設定"}`);
  console.log(`[chat] 完了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failed === cfg.rooms.length) process.exit(1);
}

main().catch((e) => { console.error("[chat] エラー:", e.message); process.exit(1); });
