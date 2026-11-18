// エスプリム（中国の代行会社）とのチャットから「到着・検品」の報告を拾う（判定だけ。通信・書き込みはしない）
//   ・AI は使わない。キーワードと「発注日＋品番3桁」で、発注管理の生産中（orders）に結び付ける
//   ・拾うのは 生産中 → 輸送中 の間（エスプリム到着予定／検品待ち／検品中／検品済）と、箱数・CBM・入数だけ。
//     発注・輸送中・お届け済みは発注管理の画面が正（発注確定・インボイス取込・追跡）なので、チャットからは拾わない
//   ・判定できなかった報告は捨てずに「未判定」に回す（辞書に呼び名を足すと次の回で拾い直す）
export const STAGES = ["生産中", "到着予定", "検品待ち", "検品中", "検品済"];
export const AT_ESPRIM = new Set(["検品待ち", "検品中", "検品済", "転送"]);   // エスプリムに現物がある状態（転送＝青島の工場から届いた分）
const UNIT = "個箱枚冊元円本日月年時分秒色点件名人回着袋足組台セ";       // 「135個」「960箱」などを品番と読まないため
const JP = "ぁ-んァ-ヶ一-龠";

// Chatwork の本文から、引用・宛先・添付の記法を取り除く（引用は二重計上になるので中身ごと捨てる）
export function cleanBody(body) {
  let s = String(body || ""), prev;
  // 引用は捨てる。ただし「【001 リクルートバッグ 追加発注】」の見出しだけは残す（返信の「納期：25日間」がどの品番かを知るため）
  do { prev = s; s = s.replace(/\[qt\]((?:(?!\[qt\])[\s\S])*?)\[\/qt\]/g, (_, inner) => "\n" + (inner.match(/【[^】]{0,40}】/g) || []).join("\n") + "\n"); } while (s !== prev);
  s = s.replace(/\[download:[^\]]*\][\s\S]*?\[\/download\]/g, " ")
    .replace(/\[(?:To|rp|qtmeta|piconname|picon|toall)[^\]]*\]/gi, " ")
    .replace(/\[\/?(?:info|title|code|hr|dtext[^\]]*|preview[^\]]*)\]/gi, "\n")
    .replace(/[①-⑳●■◆○・]/g, " ");   // ①〜⑳●■◆○・（NFKC で数字に化けて日付とつながるのを防ぐ）
  return s.normalize("NFKC");
}
const norm = (s) => String(s || "").normalize("NFKC").replace(/[\s　:：・\-_/()（）]/g, "").toUpperCase();
const pad = (n) => String(n).padStart(2, "0");
const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);

// 月日だけの日付に年を付ける（メッセージの日より limit 日以上先になるなら前年）
function withYear(m, d, msgDate, limit) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  const y = Number(msgDate.slice(0, 4));
  const c = `${y}-${pad(m)}-${pad(d)}`;
  return dayDiff(c, msgDate) > limit ? `${y - 1}-${pad(m)}-${pad(d)}` : c;
}

// 「261006発注分」「10.8発注分」「9/16発注分」「0916発注分」→ 発注日。見つけた部分は行から取り除く
export function takeOrderDate(line, msgDate) {
  const m = line.match(/(?<!\d)(\d{6}|\d{4}|\d{1,2}\s?[./]\s?\d{1,2})\s*発注分?/);
  if (!m) return { date: "", rest: line, has: /発注分/.test(line) };
  const t = m[1].replace(/\s/g, ""); let date = "";
  if (t.length === 6 && !/[./]/.test(t)) { const c = `20${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}`; if (!isNaN(new Date(c + "T00:00:00Z"))) date = c; }
  else if (t.length === 4 && !/[./]/.test(t)) date = withYear(+t.slice(0, 2), +t.slice(2, 4), msgDate, 7);
  else { const [a, b] = t.split(/[./]/); date = withYear(+a, +b, msgDate, 7); }
  return { date, rest: line.replace(m[0], " "), has: true };
}

// 状態のキーワード（強い順）。到着の「予定」は到着より先に見る
export function findStage(line) {
  if (/検品\s*(?:済|完了|終了|が?終わり)/.test(line)) return "検品済";
  if (/検品中/.test(line)) return "検品中";
  if (/(?:届く|到着(?:する)?)\s*(?:予定|見込)/.test(line)) return "到着予定";
  if (/到着済|届きました|到着(?:しました|致しました|いたしました)/.test(line)) return "検品待ち";
  return "";
}

// 品名の索引。products = {商品コード: {name, folder}} / aliases = {呼び名: 品番3桁}（辞書タブ）
export function buildIndex(products, aliases = {}) {
  const folders = new Set(), names = [];
  for (const [code, p] of Object.entries(products || {})) {
    const f = (p && p.folder) || (code.match(/ADS(\d{3})/i) || [])[1]; if (!f) continue;
    folders.add(f);
    const n = norm(p.name); if (n.length >= 4) names.push({ n, f, how: "品名" });
  }
  for (const [k, v] of Object.entries(aliases)) {
    const n = norm(k), f = String(v || "").replace(/\D/g, "").padStart(3, "0").slice(-3);
    if (n.length >= 2 && /^\d{3}$/.test(f)) { names.push({ n, f, how: "辞書" }); folders.add(f); }
  }
  // 同じ呼び名は1つにまとめる（辞書を優先）。長い呼び名から先に当てる
  const seen = new Map();
  for (const x of names) { const k = x.n + "|" + x.f; if (!seen.has(k) || x.how === "辞書") seen.set(k, x); }
  return { folders, names: [...seen.values()].sort((a, b) => b.n.length - a.n.length || (a.how === "辞書" ? -1 : 1)) };
}

// 1行から商品（品番3桁）を探す。番号 → 呼び名の順。呼び名が複数の品番に同じ長さで当たったら「あいまい」
export function findProducts(line, index) {
  const out = []; const add = (folder, code, how, qty) => { if (index.folders.has(folder) && !out.some((x) => x.folder === folder)) out.push({ folder, code: code || "", how, qty: qty || 0 }); };
  for (const m of line.matchAll(/ADS\s?(\d{3})([A-Z])?/gi)) add(m[1], m[2] ? `ADS${m[1]}${m[2].toUpperCase()}` : "", "番号");
  for (const m of line.matchAll(/(?<![\dA-Za-z.*\/])(\d{3})([A-Z])(\d+)個/g)) add(m[1], `ADS${m[1]}${m[2]}`, "番号", +m[3]);   // 「011A168個」
  const re = new RegExp(`(?<![\\dA-Za-z.*\\/])(\\d{3})(?!\\d)([A-Z](?![A-Za-z]))?[_ ]?(?=[${JP}])(?![${UNIT}])`, "g");
  for (const m of line.matchAll(re)) add(m[1], m[2] ? `ADS${m[1]}${m[2]}` : "", "番号");
  if (out.length) return { list: out, ambiguous: false };
  const t = norm(line); let hit = null, ambiguous = false;
  for (const x of index.names) {
    if (hit && x.n.length < hit.n.length) break;
    if (!t.includes(x.n)) continue;
    if (!hit) hit = x; else if (x.f !== hit.f && x.how === hit.how) ambiguous = true;
  }
  if (hit && !ambiguous) add(hit.f, "", hit.how);
  return { list: out, ambiguous };
}

// 1メッセージ → 報告の一覧。msg = {id, time(秒), who, body}
//   行ごとに「商品」と「状態」を探す。商品だけの行の後に「上記の商品が到着しました」と続く書き方にも対応する
export function parseMessage(msg, index) {
  const msgDate = new Date(msg.time * 1000 + 9 * 3600000).toISOString().slice(0, 10);
  const lines = cleanBody(msg.body).split(/\n/).map((s) => s.trim()).filter(Boolean);
  const events = [], unknown = [], leads = []; let pending = [], orphan = null, head = "";   // orphan = 「○○発注分 △△」とあるが品番が分からなかった行（次の行の状態と合わせて未判定に出す）
  const mk = (p, od, stage, line, date) => ({ folder: p.folder, code: p.code, how: p.how, orderDate: od, stage, date, qty: p.qty || 0,
    boxes: 0, cbm: 0, perBox: 0, msgId: String(msg.id), time: msg.time, who: msg.who || "", text: line.slice(0, 200) });
  for (const raw of lines) {
    // 納期の回答（「【001 リクルートバッグ 追加発注】」→「納期：25日間ぐらい」「納期：30日-35日間」）
    const hm = raw.match(/【\s*(?:ADS)?(\d{3})/i); if (hm && index.folders.has(hm[1])) head = hm[1];
    const lm = raw.match(/納期\s*[:：]?\s*(\d{1,3})\s*(?:日)?(?:間)?\s*(?:[-~〜～]\s*(\d{1,3}))?\s*日/);
    if (lm && head) { leads.push({ folder: head, days: Math.max(+lm[1], +(lm[2] || 0)), date: msgDate, msgId: String(msg.id), time: msg.time, text: raw.slice(0, 100) }); continue; }
    const od = takeOrderDate(raw, msgDate), line = od.rest, stage = findStage(line);
    const boxInfo = /\d\s*箱/.test(line) || /CBM/i.test(line);
    const looksCode = new RegExp(`(?<!\\d)\\d{3}(?!\\d)[A-Z]?[_ ]?[${JP}]|ADS\\s?\\d{3}`, "i").test(line);
    if (!od.has && !stage && !boxInfo && !looksCode) continue;
    if (/サンプル|見本|試作/.test(line)) { pending = []; orphan = null; continue; }   // サンプルの到着は発注の進捗ではない
    const { list, ambiguous } = findProducts(line, index);
    // 日付: 行の中の「11/16」「明日」など。無ければメッセージの日
    let date = msgDate; const dm = line.match(/(?<![\d.])(\d{1,2})\/(\d{1,2})(?![\d/])/);
    if (dm) date = withYear(+dm[1], +dm[2], msgDate, 60) || msgDate;
    else if (/明後日/.test(line)) date = addDays(msgDate, 2); else if (/明日/.test(line)) date = addDays(msgDate, 1);
    const bx = line.match(/(\d+)\s*箱/), cb = line.match(/(\d+(?:\.\d+)?)\s*CBM/i), qy = line.match(/(\d[\d,]*)\s*個/);
    if (list.length) {
      const evs = list.map((p) => { const e = mk(p, od.date, stage, raw, date); if (list.length === 1) { if (bx && cb) { e.boxes = +bx[1]; e.cbm = +cb[1]; } if (!e.qty && qy) e.qty = +qy[1].replace(/,/g, ""); } return e; });
      if (stage) { events.push(...evs); pending = []; }
      else if (evs.some((e) => e.boxes)) { events.push(...evs); pending = evs; }
      else pending = od.has || pending.length === 0 ? evs : pending.concat(evs);
    } else if (stage && pending.length) {
      for (const e of pending) events.push({ ...e, stage, date, text: (e.text + " ／ " + raw).slice(0, 200) });
      pending = [];
    } else if (stage && (od.has || ambiguous || orphan || /弊社|エスプリム|当社/.test(line))) {
      const amb = ambiguous || (orphan && orphan.ambiguous);
      unknown.push({ reason: amb ? "呼び名が複数の品番に当たる" : "品番が分からない", stage, orderDate: od.date || (orphan ? orphan.date : ""), date,
        msgId: String(msg.id), time: msg.time, who: msg.who || "", text: ((orphan && !od.has ? orphan.raw + " ／ " : "") + raw).slice(0, 200) });
      orphan = null;
    } else if (od.has && !stage) orphan = { raw, date: od.date, ambiguous };
  }
  // 「箱サイズ50*40*30cm、1箱120個入り」… メッセージの商品が1つだけの時に、その商品の入数・1箱の体積にする
  const body = lines.join("\n"), pb = body.match(/1\s*箱\s*(?:あたり)?\s*(\d+)\s*個\s*入/), sz = body.match(/箱サイズ\s*(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*cm/i);
  const fs = [...new Set(events.map((e) => e.folder))];
  if (fs.length === 1 && (pb || sz)) for (const e of events) { if (pb) e.perBox = +pb[1]; if (sz) e.boxCbm = Math.round(sz[1] * sz[2] * sz[3] / 1000) / 1000; }
  return { events, unknown, leads };
}

// 生産中の発注を「発注日｜品番3桁」のロットにまとめる。orders = [{id, d}]（status=production のもの）
export function buildLots(orders, products) {
  const lots = {};
  for (const { d } of orders) {
    if (!d || d.status !== "production") continue;
    const code = String(d.code || "").toUpperCase(), remain = (Number(d.qty) || 0) - (Number(d.shipped) || 0);
    // 発注日は「2026-10-06」に揃える（「2026/10/6」や前後に文字が付いた値もあるため。読めない日付の発注は飛ばす）
    const dm = String(d.date || "").match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    const date = dm ? `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}` : "";
    const folder = (code.match(/ADS(\d{3})/) || [])[1];
    if (!folder || !date || remain <= 0) continue;
    const key = `${date}|${folder}`, p = products[code] || {};
    const lot = (lots[key] ||= { key, date, folder, name: "", supplier: d.supplier || "", items: [], remain: 0 });
    if (!lot.name && p.name) lot.name = p.name;
    const it = lot.items.find((x) => x.code === code);
    if (it) it.remain += remain; else lot.items.push({ code, vari: p.vari || "", remain });
    lot.remain += remain;
  }
  for (const l of Object.values(lots)) l.items.sort((a, b) => (a.code < b.code ? -1 : 1));
  return lots;
}

// 報告をロットに結び付ける。発注日があれば近い日のロット（±10日）、無ければその品番のロットが1つの時だけ
export function resolveLot(ev, lots) {
  const cand = Object.values(lots).filter((l) => l.folder === ev.folder);
  if (!cand.length) return { reason: "生産中の発注が無い（発注管理に未登録・出荷済み・修理分など）" };
  if (ev.orderDate) {
    const best = cand.map((l) => ({ l, diff: Math.abs(dayDiff(l.date, ev.orderDate)) })).sort((a, b) => a.diff - b.diff)[0];
    return best.diff <= 10 ? { lot: best.l } : { reason: `発注日 ${ev.orderDate} に近い生産中の発注が無い` };
  }
  return cand.length === 1 ? { lot: cand[0] } : { reason: "発注日が書かれておらず、生産中の発注が複数ある" };
}

// 輸送手段の推奨（エスプリムに現物があるロットだけ）
//   cfg = {lclDays, containerDays}（混載便・コンテナで国内に入庫するまでの日数。出荷待ちを含む）
//   cost = {cont40, lcl, ocs}（1個あたりの国際送料・円。原価シートの L〜N 列。無ければ料金は出さない）
//   型番ごとに「（国内在庫＋輸送中）÷ 1日の販売」で何日もつかを出し、
//   混載便でも間に合わない分 → OCS ／ コンテナだと間に合わない分 → 混載便 ／ それ以外 → コンテナ
export function recommend(lot, products, cfg, perBox, cost) {
  const rows = []; let worst = 0;
  for (const it of lot.items) {
    const p = products[it.code]; if (!p) continue;
    const stock = ["office", "warehouse", "fba", "rsl"].reduce((s, k) => s + (Number(p[k]) || 0), 0), transit = Number(p.transit) || 0;
    const daily = (Number(p.demand) || Number(p.monthly) || 0) / 30; if (daily <= 0) continue;
    const days = (stock + transit) / daily; let mode = 0, until = 0;
    if (days < cfg.lclDays) { mode = 2; until = cfg.lclDays; } else if (days < cfg.containerDays) { mode = 1; until = cfg.containerDays; }
    if (!mode) continue;
    let qty = Math.ceil(daily * (until - days)); if (perBox > 0) qty = Math.ceil(qty / perBox) * perBox;
    qty = Math.min(qty, it.remain); if (qty <= 0) continue;
    // コンテナ（40ft）で送る場合との差額
    const unit = cost ? (mode === 2 ? cost.ocs : cost.lcl) : 0, base = cost ? cost.cont40 || cost.lcl : 0;
    const extra = unit > 0 && base > 0 ? Math.round((unit - base) * qty) : null;
    rows.push({ code: it.code, vari: it.vari, mode, qty, stock, transit, days: Math.floor(days), extra, noCost: !!cost && mode === 2 && !(cost.ocs > 0) });
    worst = Math.max(worst, mode);
  }
  rows.sort((a, b) => b.mode - a.mode || a.days - b.days);
  const label = ["コンテナ", "混載便", "OCS"][worst];
  const yen = (n) => "¥" + n.toLocaleString("ja-JP");
  const detail = rows.map((r) => `${["", "混載", "OCS"][r.mode]} ${r.vari || r.code} ${r.qty}個（在庫${r.stock}${r.transit ? "＋輸送中" + r.transit : ""}・あと${r.days}日` +
    (r.extra > 0 ? `・コンテナ比 +${yen(r.extra)}` : r.noCost ? "・OCS料金未登録" : "") + "）").join("\n");
  const extraTotal = rows.reduce((s, r) => s + (r.extra || 0), 0);
  const minDays = rows.length ? Math.min(...rows.map((r) => r.days)) : null;
  return { mode: worst, label, detail, rows, minDays, extraTotal };
}

// 参考データ（Google スプレッドシート。人が管理しているものを読むだけ）
//   leadRows: 発注・入庫の入力シート [[…, 出荷日(I), 入庫日(J), 期間, 輸送会社(L), …]] → 輸送方法ごとの日数（直近 days 日に出荷した分の 80% 値）
//   costRows: 原価シート [[型番(A), …, 20ft(K), 40ft(L), 混載便(M), OCS(N), …, 国際入数(W)]] → 品番3桁ごとの 1個あたり送料・入数
const toDate = (s) => { const m = String(s || "").match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const num = (s) => { const n = Number(String(s ?? "").replace(/[,¥円\s]/g, "")); return isFinite(n) ? n : 0; };
export const LEAD_MODES = { ocs: /^OCS/i, lcl: /^(海源|TW|EW)(?!.*コンテナ)/, container: /コンテナ/ };
export function leadTimes(leadRows, now = Date.now(), days = 180) {
  const v = { ocs: [], lcl: [], container: [] };
  for (const r of leadRows || []) {
    const a = toDate(r[8]), b = toDate(r[9]), co = String(r[11] || "").trim();
    if (!co || isNaN(a) || isNaN(b) || now - a > days * 86400000) continue;
    const d = Math.round((b - a) / 86400000); if (d < 0 || d > 120) continue;
    for (const [k, re] of Object.entries(LEAD_MODES)) if (re.test(co)) { v[k].push(d); break; }
  }
  const out = {};
  for (const [k, list] of Object.entries(v)) if (list.length >= 5) { list.sort((x, y) => x - y); out[k] = { p80: list[Math.min(list.length - 1, Math.floor(list.length * 0.8))], n: list.length }; }
  return out;
}
export function costTable(costRows) {
  const out = {};
  for (const r of costRows || []) {
    const m = String(r[0] || "").match(/^ADS(\d{3})/i); if (!m) continue;
    const x = { cont20: num(r[10]), cont40: num(r[11]), lcl: num(r[12]), ocs: num(r[13]), perBox: num(r[22]) };
    const o = out[m[1]];
    if (!o) out[m[1]] = x;   // サイズ違い（ADS002-M／-L）は1つ目を使い、入数は小さい方（箱数を少なく見積もらないため）
    else if (x.perBox > 0 && (!o.perBox || x.perBox < o.perBox)) o.perBox = x.perBox;
  }
  return out;
}
