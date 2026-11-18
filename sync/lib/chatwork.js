// Chatwork API（読み取りと、設定した時だけの通知）。本文・品番はログに出さないこと（公開リポジトリの実行ログは誰でも見られる）
const API = "https://api.chatwork.com/v2";
const tail = (id) => "…" + String(id).slice(-3);

// ルームの直近100件（API の上限）。force=1 で既読に関係なく取り、前回の続きは message_id で自分で判定する
export async function fetchMessages(token, roomId) {
  const res = await fetch(`${API}/rooms/${roomId}/messages?force=1`, { headers: { "X-ChatWorkToken": token } });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`Chatwork API ${res.status}（ルーム${tail(roomId)}）`);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map((m) => ({ id: String(m.message_id), time: Number(m.send_time) || 0, who: (m.account && m.account.name) || "", body: m.body || "" }));
}
export async function postMessage(token, roomId, body) {
  const res = await fetch(`${API}/rooms/${roomId}/messages`, { method: "POST",
    headers: { "X-ChatWorkToken": token, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ body, self_unread: "1" }) });
  if (!res.ok) throw new Error(`Chatwork 通知 ${res.status}（ルーム${tail(roomId)}）`);
}
// message_id は桁数の多い数字。文字列のまま大小を比べる
export const newerId = (a, b) => { a = String(a || "0"); b = String(b || "0"); return a.length !== b.length ? a.length > b.length : a > b; };
