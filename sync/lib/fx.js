// 為替レート（三菱UFJ銀行のリアルタイム相場・TTS）を 1 日 1 回取り込み、settings/fx に書く
//   ページ: https://www.bk.mufg.jp/ippan/rate/real.html
//   ページが読んでいるデータ（JS）: https://www.bk.mufg.jp/gdocs/rate/kinri_data_utf8.js
//     G001TTSZ = USD の TTS / G069TTSZ = CNY（人民元・オフショア相場）の TTS / G001DATE = 更新日時
//   用途は発注履歴の円換算だけ（発注書・発注一覧は元の通貨のまま）
const URL = "https://www.bk.mufg.jp/gdocs/rate/kinri_data_utf8.js";
const KEYS = { USD: "G001TTSZ", RMB: "G069TTSZ" };

export async function fetchMufgTts() {
  const res = await fetch(URL, { headers: { "user-agent": "Mozilla/5.0 (inventory-order-sync)" } });
  if (!res.ok) throw new Error(`MUFG ${res.status}`);
  const text = await res.text();
  const pick = (k) => { const m = text.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`)); return m ? m[1] : ""; };
  const out = { asOf: pick("G001DATE") };
  for (const [cur, k] of Object.entries(KEYS)) {
    const v = parseFloat(pick(k).replace(/,/g, ""));
    if (!(v > 0)) throw new Error(`${cur} のレートが読めません（${k}="${pick(k)}"）`);
    out[cur] = v;
  }
  return out;
}

// db = 在庫システムの Firestore。成功したら settings/fx を更新して値を返す
export async function updateFx(db) {
  const r = await fetchMufgTts();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  await db.collection("settings").doc("fx").set(
    { RMB: r.RMB, USD: r.USD, updatedAt: today, auto: true, source: "三菱UFJ銀行 リアルタイム相場 TTS", asOf: r.asOf, fetchedAt: new Date() },
    { merge: true });
  return r;
}
