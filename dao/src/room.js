// GameRoom:一房一实例的 Durable Object,先立骨架打通部署,游戏逻辑随后填充
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = (await this.ctx.storage.get("game")) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/claim") {
      if (this.game) return new Response("room exists", { status: 409 });
      const { hostToken, nick } = JSON.parse(await request.text());
      this.game = { code: url.searchParams.get("code"), hostToken, hostNick: nick, phase: "lobby" };
      await this.ctx.storage.put("game", this.game);
      return new Response("ok");
    }

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    ws.send(JSON.stringify({ t: "echo", raw: String(raw) }));
  }

  async webSocketClose() {}
  async webSocketError() {}
}
