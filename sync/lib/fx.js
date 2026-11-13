// 為替レート（三菱UFJ銀行のリアルタイム相場の TTM＝TTS と TTB の中間値）を 1 日 1 回取り込み、settings/fx に書く
//   2026-11-13 に TTS → TTM へ変更。このページに TTM は無いので (TTS＋TTB)÷2 で出す（銀行が 10 時ごろ公表する仲値とは少しずれる）
//   ページ: https://www.bk.mufg.jp/ippan/rate/real.html
//   ページが読んでいるデータ（JS）: https://www.bk.mufg.jp/gdocs/rate/kinri_data_utf8.js
//     G001TTSZ / G001TTBZ = USD の TTS / TTB、G069TTSZ / G069TTBZ = CNY（人民元・オフショア相場）の TTS / TTB、G001DATE = 更新日時
//   用途は発注履歴の円換算だけ（発注書・発注一覧は元の通貨のまま）
const URL = "https://www.bk.mufg.jp/gdocs/rate/kinri_data_utf8.js";
const KEYS = { USD: "G001", RMB: "G069" };

export async function fetchMufgTtm() {
  const res = await fetch(URL, { headers: { "user-agent": "Mozilla/5.0 (inventory-order-sync)" } });
  if (!res.ok) throw new Error(`MUFG ${res.status}`);
  const text = await res.text();
  const pick = (k) => { const m = text.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`)); return m ? m[1] : ""; };
  const out = { asOf: pick("G001DATE") };
  for (const [cur, k] of Object.entries(KEYS)) {
    const tts = parseFloat(pick(k + "TTSZ").replace(/,/g, "")), ttb = parseFloat(pick(k + "TTBZ").replace(/,/g, ""));
    if (!(tts > 0) || !(ttb > 0)) throw new Error(`${cur} のレートが読めません（${k} TTS="${pick(k + "TTSZ")}" TTB="${pick(k + "TTBZ")}"）`);
    out[cur] = Math.round((tts + ttb) / 2 * 100) / 100;   // TTM（中間値・小数2桁）
  }
  return out;
}

// db = 在庫システムの Firestore。成功したら settings/fx を更新して値を返す
export async function updateFx(db) {
  const r = await fetchMufgTtm();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  await db.collection("settings").doc("fx").set(
    { RMB: r.RMB, USD: r.USD, updatedAt: today, auto: true, source: "三菱UFJ銀行 リアルタイム相場 TTM（TTSとTTBの中間値）", asOf: r.asOf, fetchedAt: new Date() },
    { merge: true });
  return r;
}
