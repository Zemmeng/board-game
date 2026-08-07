import { MajiangRoom } from "./room.js";
export { MajiangRoom };

// 房间码字母表:去掉 0/O/1/I/L 这些看着像的
const CODE_RE = /^[A-HJ-KM-NP-Z2-9]{5}$/;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const body = await request.text();
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch(`https://room/claim?code=${code}`, { method: "POST", body });
        if (res.ok) return Response.json({ code });
        // 撞上还活着的房间就换个码
      }
      return new Response("busy", { status: 503 });
    }

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

function randomCode() {
  let s = "";
  const buf = new Uint8Array(5);
  crypto.getRandomValues(buf);
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}
