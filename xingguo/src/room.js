// XingguoRoom:一房一实例的 Durable Object。
//
// 跟这个仓库里另外几款回合制游戏不一样 —— 格斗是实时的,所以这里有个 30Hz 的 tick 循环:
// 客户端只上报按键位掩码,模拟完全跑在服务端,每帧把快照广播下去。
//
// 对局状态**只放内存、不落 storage**:一帧存一次 storage 又慢又贵,
// 而一局也就一分钟。落盘的只有大厅信息(谁占了座、选了谁),
// 实例真被回收了,顶多是这一局作废退回大厅,不至于丢房间。
import { createMatch, step, TPS, KINDS } from "../public/js/shared/sim.js";
import { botInput } from "../public/js/shared/ai.js";

const IDLE_WIPE_MS = 2 * 60 * 60 * 1000;   // 闲置两小时清房
const MASK = { left: 1, right: 2, up: 4, down: 8, light: 16, heavy: 32, special: 64 };
const fromMask = (n) => {
  const o = {};
  for (const k in MASK) if (n & MASK[k]) o[k] = true;
  return o;
};

export class XingguoRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;      // tick 循环句柄
    this.M = null;          // 当前对局(只在内存里)
    this.inputs = [0, 0];   // 两个座位最新的按键掩码
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("lobby")) ?? null;
    });
  }

  async save() {
    await this.ctx.storage.put("lobby", this.g);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
  }

  async alarm() {
    this.stopLoop();
    this.g = null;
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "room expired");
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/claim") {
      if (this.g && this.g.seats.length > 0) return new Response("room exists", { status: 409 });
      this.g = { code: url.searchParams.get("code"), seats: [], playing: false };
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
    if (!att?.token || !this.g) return -1;
    return this.g.seats.findIndex((s) => s.token === att.token);
  }

  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch { /* 断了 */ } }

  broadcast(o) {
    const s = JSON.stringify(o);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch { /* 断了 */ }
    }
  }

  lobbyPayload() {
    return {
      t: "lobby",
      seats: this.g.seats.map((s) => ({ side: s.side, bot: !!s.bot, connected: !!s.connected })),
    };
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }

    if (m.t === "join") {
      if (!this.g) return this.send(ws, { t: "err", msg: "房间不存在或已过期" });
      let i = this.g.seats.findIndex((s) => s.token === m.token);
      if (i < 0) {
        if (this.g.seats.length >= 2) return this.send(ws, { t: "err", msg: "这间已经满了" });
        const side = ["chimp", "pot"].includes(m.side) ? m.side : "chimp";
        this.g.seats.push({ token: m.token, side, connected: true });
        i = this.g.seats.length - 1;
      }
      this.g.seats[i].connected = true;
      ws.serializeAttachment({ token: m.token });
      this.send(ws, { t: "joined", seat: i, code: this.g.code });
      await this.save();
      this.broadcast(this.lobbyPayload());
      if (this.g.seats.length === 2 && !this.g.playing) this.begin();
      return;
    }

    const seat = this.seatOf(ws);
    if (seat < 0) return;

    if (m.t === "in") {
      this.inputs[seat] = m.k | 0;
      return;
    }
    if (m.t === "add_bot") {
      if (this.g.seats.length >= 2) return;
      const other = this.g.seats[0]?.side === "chimp" ? "pot" : "chimp";
      this.g.seats.push({ token: "bot:" + crypto.randomUUID(), side: other, bot: true, connected: true });
      await this.save();
      this.broadcast(this.lobbyPayload());
      this.begin();
      return;
    }
    if (m.t === "again") {
      if (!this.g.playing) this.begin();
      return;
    }
  }

  async webSocketClose(ws) {
    const i = this.seatOf(ws);
    if (i < 0 || !this.g) return;
    // 同一个 token 可能开了多个标签页,还有别的连接就不算掉线
    this.g.seats[i].connected = this.ctx.getWebSockets()
      .some((w) => w !== ws && w.deserializeAttachment()?.token === this.g.seats[i].token);
    // 打到一半有人跑了就停手,退回大厅等他回来
    if (this.g.playing && !this.g.seats[i].connected && !this.g.seats[i].bot) {
      this.stopLoop();
      this.g.playing = false;
    }
    await this.save();
    this.broadcast(this.lobbyPayload());
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  // ---------- 对局循环 ----------

  begin() {
    if (this.g.seats.length < 2) return;
    this.stopLoop();
    const kinds = [this.g.seats[0].side, this.g.seats[1].side];
    this.M = createMatch(kinds, (Math.random() * 1e9) | 0);
    this.inputs = [0, 0];
    this.g.playing = true;
    this.broadcast({ t: "begin" });
    this.ctx.storage.put("lobby", this.g).catch(() => {});
    this.timer = setInterval(() => this.tick(), 1000 / TPS);
  }

  tick() {
    if (!this.M) return this.stopLoop();
    const ins = [0, 1].map((i) =>
      this.g.seats[i]?.bot ? botInput(this.M, i, "normal") : fromMask(this.inputs[i]));

    let ev;
    try {
      ev = step(this.M, ins);
    } catch (e) {
      console.error("模拟炸了", e);
      this.stopLoop();
      this.g.playing = false;
      this.broadcast({ t: "err", msg: "这局出岔子了,回大厅重开" });
      return;
    }

    this.broadcast({ t: "snap", m: this.M, ev });

    if (this.M.phase === "over") {
      this.stopLoop();
      this.g.playing = false;
      this.ctx.storage.put("lobby", this.g).catch(() => {});
    }
  }

  stopLoop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
