// エスプリム（中国の代行会社）とのチャットから「到着・検品」の報告を拾う（判定だけ。通信・書き込みはしない）
//   ・AI は使わない。キーワードと「発注日＋品番3桁」で、発注管理の生産中（orders）に結び付ける
//   ・拾うのは 生産中 → 輸送中 の間（エスプリム到着予定／検品待ち／検品中／検品済）と、箱数・CBM・入数だけ。
//     発注・輸送中・お届け済みは発注管理の画面が正（発注確定・インボイス取込・追跡）なので、チャットからは拾わない
//   ・判定できなかった報告は捨てずに「未判定」に回す（辞書に呼び名を足すと次の回で拾い直す）
export const STAGES = ["生産中", "到着予定", "検品待ち", "検品中", "検品済"];
export const AT_ESPRIM = new Set(["検品待ち", "検品中", "検品済"]);   // エスプリムに現物がある状態
const UNIT = "個箱枚冊元円本日月年時分秒色点件名人回着袋足組台セ";       // 「135個」「960箱」などを品番と読まないため
const JP = "ぁ-んァ-ヶ一-龠";

// Chatwork の本文から、引用・宛先・添付の記法を取り除く（引用は二重計上になるので中身ごと捨てる）
export function cleanBody(body) {
  let s = String(body || ""), prev;
  do { prev = s; s = s.replace(/\[qt\](?:(?!\[qt\])[\s\S])*?\[\/qt\]/g, "\n"); } while (s !== prev);
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
function takeOrderDate(line, msgDate) {
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
function findProducts(line, index) {
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
  const events = [], unknown = []; let pending = [], orphan = null;   // orphan = 「○○発注分 △△」とあるが品番が分からなかった行（次の行の状態と合わせて未判定に出す）
  const mk = (p, od, stage, line, date) => ({ folder: p.folder, code: p.code, how: p.how, orderDate: od, stage, date, qty: p.qty || 0,
    boxes: 0, cbm: 0, perBox: 0, msgId: String(msg.id), time: msg.time, who: msg.who || "", text: line.slice(0, 200) });
  for (const raw of lines) {
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
  return { events, unknown };
}

// 生産中の発注を「発注日｜品番3桁」のロットにまとめる。orders = [{id, d}]（status=production のもの）
export function buildLots(orders, products) {
  const lots = {};
  for (const { d } of orders) {
    if (!d || d.status !== "production") continue;
    const code = String(d.code || "").toUpperCase(), remain = (Number(d.qty) || 0) - (Number(d.shipped) || 0);
    const folder = (code.match(/ADS(\d{3})/) || [])[1]; const date = String(d.date || "").slice(0, 10);
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

// 輸送手段の推奨（エスプリムに現物があるロットだけ）。cfg = {lclDays, containerDays}（混載便・コンテナで売り場に並ぶまでの日数）
//   型番ごとに「（国内在庫＋輸送中）÷ 1日の販売」で何日もつかを出し、
//   混載便でも間に合わない分 → OCS ／ コンテナだと間に合わない分 → 混載便 ／ それ以外 → コンテナ
export function recommend(lot, products, cfg, perBox) {
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
    rows.push({ code: it.code, vari: it.vari, mode, qty, stock, transit, days: Math.floor(days) }); worst = Math.max(worst, mode);
  }
  rows.sort((a, b) => b.mode - a.mode || a.days - b.days);
  const label = ["コンテナ", "混載便", "OCS"][worst];
  const detail = rows.map((r) => `${["", "混載", "OCS"][r.mode]} ${r.vari || r.code} ${r.qty}個（在庫${r.stock}${r.transit ? "＋輸送中" + r.transit : ""}・あと${r.days}日）`).join("\n");
  const minDays = rows.length ? Math.min(...rows.map((r) => r.days)) : null;
  return { mode: worst, label, detail, rows, minDays };
}
