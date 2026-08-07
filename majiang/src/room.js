// MajiangRoom:一房一实例的 Durable Object,持有权威牌局。
//
// ⚠️ 广播一律走 viewFor(g, seat) 按座位裁剪,**绝不整份下发 g** —— 麻将有暗牌,
// 整份广播等于让人开控制台看牌。这是它跟本仓库其它几款游戏最大的不同。
import {
  createGame, setLack, setSwap, discard, respond, angang, bugang, zimo,
  legalActions, swappableSuits, SEATS,
} from "../public/js/shared/game.js";
import { viewFor } from "../public/js/shared/view.js";
import { pickLack, pickSwap, pickResponse, pickTurn } from "../public/js/shared/ai.js";

const IDLE_WIPE_MS = 12 * 60 * 60 * 1000;
const BOT_NICKS = ["雀友·东", "雀友·南", "雀友·西", "雀友·北"];
const BOT_DELAY = [420, 900];          // 机器人思考时间,给点节奏感

export class MajiangRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.botTimer = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("game")) ?? null;
      this.lobby = (await this.ctx.storage.get("lobby")) ?? null;
      this.pump();                      // 实例被唤醒时,若正轮到机器人就把它续上
    });
  }

  async save() {
    await this.ctx.storage.put("lobby", this.lobby);
    if (this.g) await this.ctx.storage.put("game", this.g);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
  }

  async alarm() {
    clearTimeout(this.botTimer);
    this.g = null; this.lobby = null;
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "room expired");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/claim") {
      if (this.lobby && this.lobby.seats.length) return new Response("room exists", { status: 409 });
      const { hostToken } = JSON.parse(await request.text());
      this.lobby = { code: url.searchParams.get("code"), hostToken, seats: [], started: false };
      this.g = null;
      await this.save();
      return new Response("ok");
    }
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  // ---------- 连接 ----------

  seatOf(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.token || !this.lobby) return -1;
    return this.lobby.seats.findIndex((s) => s.token === att.token);
  }

  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch { /* 断了 */ } }

  /** 每条连接只收到自己那份视图 */
  broadcast() {
    if (!this.lobby) return;
    for (const ws of this.ctx.getWebSockets()) {
      const i = this.seatOf(ws);
      if (i < 0) continue;
      this.send(ws, this.g
        ? { t: "state", v: this.decorate(viewFor(this.g, i)) }
        : { t: "lobby", l: this.lobbyView() });
    }
  }

  decorate(v) {
    for (const s of v.seats) {
      const L = this.lobby.seats[s.seat];
      if (L) { s.nick = L.nick; s.bot = !!L.bot; s.connected = L.connected !== false; }
    }
    return v;
  }

  lobbyView() {
    return {
      code: this.lobby.code,
      started: this.lobby.started,
      seats: this.lobby.seats.map((s) => ({ nick: s.nick, bot: !!s.bot, connected: s.connected !== false })),
      hostToken: this.lobby.hostToken,
    };
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    try {
      await this.handle(ws, m);
    } catch (e) {
      this.send(ws, { t: "err", msg: e?.message ?? String(e) });
    }
  }

  async handle(ws, m) {
    if (m.t === "join") {
      if (!this.lobby) throw new Error("房间不存在或已过期");
      let i = this.lobby.seats.findIndex((s) => s.token === m.token);
      if (i < 0) {
        if (this.lobby.started) throw new Error("这局已经开打了");
        if (this.lobby.seats.length >= SEATS) throw new Error("这桌满了");
        this.lobby.seats.push({ token: m.token, nick: (m.nick || "无名").slice(0, 10), connected: true });
        i = this.lobby.seats.length - 1;
      }
      this.lobby.seats[i].connected = true;
      ws.serializeAttachment({ token: m.token });
      this.send(ws, { t: "joined", seat: i, code: this.lobby.code, host: m.token === this.lobby.hostToken });
      await this.save();
      this.broadcast();
      return;
    }

    const seat = this.seatOf(ws);
    if (seat < 0) throw new Error("你还没入座");
    const isHost = this.lobby.seats[seat].token === this.lobby.hostToken;

    if (m.t === "add_bot") {
      if (!isHost) throw new Error("只有房主能加机器人");
      if (this.lobby.started || this.lobby.seats.length >= SEATS) return;
      const used = new Set(this.lobby.seats.map((s) => s.nick));
      const nick = BOT_NICKS.find((n) => !used.has(n)) ?? "雀友";
      this.lobby.seats.push({ token: "bot:" + crypto.randomUUID(), nick, bot: true, connected: true });
      await this.save(); this.broadcast();
      return;
    }
    if (m.t === "start") {
      if (!isHost) throw new Error("只有房主能开局");
      if (this.lobby.seats.length !== SEATS) throw new Error("要四个人才能开");
      this.lobby.started = true;
      this.g = createGame((Math.random() * 1e9) | 0, 0);
      for (let i = 0; i < SEATS; i++) {
        this.g.seats[i].nick = this.lobby.seats[i].nick;
        this.g.seats[i].bot = !!this.lobby.seats[i].bot;
      }
      await this.save(); this.broadcast(); this.pump();
      return;
    }

    if (!this.g) throw new Error("还没开局");
    this.act(seat, m);
    await this.save();
    this.broadcast();
    this.pump();
  }

  /** 把一条客户端动作落到牌局上 */
  act(seat, m) {
    const g = this.g;
    switch (m.t) {
      case "lack":    return setLack(g, seat, m.suit);
      case "swap":    return setSwap(g, seat, m.tiles);
      case "discard": return discard(g, seat, m.tile);
      case "respond": return respond(g, seat, m.act);
      case "angang":  return angang(g, seat, m.tile);
      case "bugang":  return bugang(g, seat, m.tile);
      case "zimo":    return zimo(g, seat);
      case "again":
        if (g.phase !== "over") throw new Error("这局还没完");
        if (this.lobby.seats[seat].token !== this.lobby.hostToken) throw new Error("等房主开下一局");
        this.g = createGame((Math.random() * 1e9) | 0, (g.dealer + 1) % SEATS);
        for (let i = 0; i < SEATS; i++) {
          this.g.seats[i].nick = this.lobby.seats[i].nick;
          this.g.seats[i].bot = !!this.lobby.seats[i].bot;
          this.g.seats[i].score = g.seats[i].score;    // 分数累计到下一局
        }
        return;
      default: throw new Error("不认识的动作");
    }
  }

  // ---------- 机器人 ----------

  /** 看看现在该不该让某个机器人动;该就排个定时器 */
  pump() {
    clearTimeout(this.botTimer);
    const who = this.botToAct();
    if (who < 0) return;
    const [lo, hi] = BOT_DELAY;
    this.botTimer = setTimeout(() => this.botStep(), lo + Math.random() * (hi - lo));
  }

  botToAct() {
    const g = this.g;
    if (!g || g.phase === "over") return -1;
    const isBot = (i) => !!this.lobby?.seats[i]?.bot;

    if (g.phase === "lack") return g.seats.findIndex((s, i) => isBot(i) && s.lack < 0);
    if (g.phase === "swap") return g.seats.findIndex((s, i) => isBot(i) && !s.swap);
    if (g.phase !== "play") return -1;
    if (g.pending) {
      const w = g.pending.waits.find((i) => isBot(i) && !g.pending.acted[i]);
      return w === undefined ? -1 : w;
    }
    return isBot(g.turn) && !g.seats[g.turn].won ? g.turn : -1;
  }

  botStep() {
    const g = this.g;
    const i = this.botToAct();
    if (i < 0) return;
    try {
      if (g.phase === "lack") setLack(g, i, pickLack(g, i));
      else if (g.phase === "swap") setSwap(g, i, pickSwap(g, i));
      else if (g.pending) respond(g, i, pickResponse(g, i, legalActions(g, i)));
      else {
        const a = pickTurn(g, i);
        if (a.t === "zimo") zimo(g, i);
        else if (a.t === "angang") angang(g, i, a.tile);
        else if (a.t === "bugang") bugang(g, i, a.tile);
        else discard(g, i, a.tile);
      }
    } catch (e) {
      // 机器人给了个非法动作:退而求其次打一张,总之不能让牌局卡死
      console.error("机器人出错", e?.message);
      try {
        if (g.phase === "play" && !g.pending && g.turn === i) {
          const t = g.seats[i].hand.findIndex((n) => n > 0);
          if (t >= 0) discard(g, i, t);
        } else if (g.pending) respond(g, i, "pass");
      } catch { /* 实在不行就算了,等玩家动 */ }
    }
    this.ctx.storage.put("game", this.g).catch(() => {});
    this.broadcast();
    this.pump();
  }

  async webSocketClose(ws) {
    const i = this.seatOf(ws);
    if (i < 0 || !this.lobby) return;
    this.lobby.seats[i].connected = this.ctx.getWebSockets()
      .some((w) => w !== ws && w.deserializeAttachment()?.token === this.lobby.seats[i].token);
    await this.save();
    this.broadcast();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}
