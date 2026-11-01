import { WordRoom } from "./room.js";
export { WordRoom };

const CODE_RE = /^\d{4}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const body = await request.text(); // { size: 2~4 }
      // 4 位房间号空间小,撞上还活着的房间就换一个
      for (let i = 0; i < 20; i++) {
        const code = String(1000 + Math.floor(Math.random() * 9000));
        const res = await room(env, code).fetch(`https://room/claim?code=${code}`, { method: "POST", body });
        if (res.ok) return Response.json({ code });
      }
      return new Response("busy", { status: 503 });
    }

    if (url.pathname === "/ws") {
      const code = url.searchParams.get("room") || "";
      if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      return room(env, code).fetch(request);
    }

    // 房间链接 /r/1234 和单机模式 /solo 都是同一个页面,前端看路径决定显示什么
    if (/^\/r\/\d{4}\/?$/.test(url.pathname) || url.pathname === "/solo") {
      return env.ASSETS.fetch(new Request(new URL("/", url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

const room = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
