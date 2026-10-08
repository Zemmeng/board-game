import { TableRoom } from "./room.js";
export { TableRoom };

// /api/room/1234            GET 本轮共享状态(?k=who:3)、POST 操作
// /api/room/1234/bank       GET 房主词库
const ROUTE = /^\/api\/room\/(\d{4})(\/bank)?$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const m = url.pathname.match(ROUTE);
      if (!m) return Response.json({ error: "not found" }, { status: 404 });
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      const res = await stub.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set("cache-control", "no-store");
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
