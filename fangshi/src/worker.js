import { FangshiRoom } from "./room.js";
export { FangshiRoom };

// 房间码字母表:去掉 0/O/1/I/L 等易混字符
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{5}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 建房:由服务端生成房间码并在对应 DO 里登记房主
    if (url.pathname === "/api/create" && request.method === "POST") {
      const body = await request.text();
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch(`https://room/claim?code=${code}`, { method: "POST", body });
        if (res.ok) return Response.json({ code });
        // 撞上已存在的活跃房间就换个码重试
      }
      return new Response("busy", { status: 503 });
    }

    // WebSocket 入口:/ws?room=CODE
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode() {
  let s = "";
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}
