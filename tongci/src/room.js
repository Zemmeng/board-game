// WordRoom:「同词相遇」房间 Durable Object,一房一个,最多 2 人
// 每轮两人各交一个词,都交齐了才在这里比对并广播——揭晓前对方的词只存在服务端,
// 下发给客户端的只有自己的词和对方「已写好」与否,看 Network 也看不到
const IDLE_MS = 30 * 60 * 1000;
const WORD_MAX = 20;
const NICK_MAX = 10;

// 判定相同时忽略空格、标点、符号和大小写;NFKC 顺手把全角字母数字归成半角
export const norm = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

class Oops extends Error {}

export class WordRoom {
  constructor(ctx) {
    this.ctx = ctx;
    // 心跳由运行时直接回,不唤醒 DO
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.g = (await ctx.storage.get("g")) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/claim") {
      if (this.g) return new Response("taken", { status: 409 });
      this.g = { code: url.searchParams.get("code"), players: [], played: 0, best: null };
      this.newGame();
      await this.ctx.storage.put("g", this.g);
      // 建了房没人进,也按无人处理
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return new Response("ok");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  newGame() {
    Object.assign(this.g, { round: 1, subs: {}, history: [], won: false });
  }

  // 最后一人断开时定的闹钟;到点还没人回来就清空房间
  async alarm() {
    if (this.ctx.getWebSockets().length) return;
    this.g = null;
    await this.ctx.storage.deleteAll();
  }

  // ---------- 连接 ----------

  playerOf(ws) {
    const token = ws.deserializeAttachment()?.token;
    return token && this.g ? this.g.players.find((p) => p.token === token) ?? null : null;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!this.g) return this.send(ws, { t: "gone" });
    try {
      if (msg.t === "join") return await this.onJoin(ws, msg);
      const me = this.playerOf(ws);
      if (!me) return;
      const g = this.g;
      switch (msg.t) {
        case "submit": this.onSubmit(me, msg.word); break;
        case "withdraw":
          if (!(me.id in g.subs)) throw new Oops("已经揭晓了,撤不回啦");
          delete g.subs[me.id];
          break;
        case "again": this.newGame(); break;
        case "leave":
          g.players = g.players.filter((p) => p !== me);
          this.newGame();
          for (const w of this.ctx.getWebSockets()) {
            if (w.deserializeAttachment()?.token === me.token) {
              w.serializeAttachment(null);
              this.send(w, { t: "left" });
            }
          }
          break;
        default: return;
      }
      await this.save();
    } catch (e) {
      this.send(ws, { t: "err", msg: e instanceof Oops ? e.message : "服务器开小差了,再试一次" });
      if (!(e instanceof Oops)) console.error(e);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    if (!this.g) return;
    this.broadcast(ws);
    if (!this.ctx.getWebSockets().some((w) => w !== ws)) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    }
  }

  webSocketError(ws) { return this.webSocketClose(ws); }

  // ---------- 玩法 ----------

  async onJoin(ws, msg) {
    const g = this.g;
    const token = String(msg.token ?? "").slice(0, 64);
    if (!token) return;
    let p = g.players.find((x) => x.token === token);
    if (!p) {
      if (g.players.length >= 2) {
        this.send(ws, { t: "full" });
        ws.close(4001, "room full");
        return;
      }
      const nick = String(msg.nick ?? "").trim().slice(0, NICK_MAX);
      if (!nick) return this.send(ws, { t: "need-nick", other: g.players[0]?.nick ?? null });
      if (g.players.some((x) => x.nick === nick)) {
        return this.send(ws, { t: "err", msg: "和对方重名了,换个昵称吧", nick: true });
      }
      p = { id: crypto.randomUUID().slice(0, 8), token, nick };
      g.players.push(p);
      if (g.players.length === 2) this.newGame();
    }
    ws.serializeAttachment({ token });
    this.send(ws, { t: "joined", id: p.id });
    await this.save();
  }

  onSubmit(me, raw) {
    const g = this.g;
    if (g.players.length < 2) throw new Oops("等对方进了房间再写");
    if (g.won) throw new Oops("这局已经相遇了,点「再来一局」");
    const word = [...String(raw ?? "").trim().replace(/\s+/g, " ")].slice(0, WORD_MAX).join("");
    const key = norm(word);
    if (!key) throw new Oops("写个词再提交");
    if (g.history.some((h) => Object.values(h.words).some((w) => norm(w) === key))) {
      throw new Oops(`「${word}」这局已经出现过了,换一个`);
    }
    g.subs[me.id] = word;

    const [a, b] = g.players;
    if (!(a.id in g.subs && b.id in g.subs)) return;
    // 两人都交了:比对、揭晓
    const hit = norm(g.subs[a.id]) === norm(g.subs[b.id]);
    g.history.push({ words: { ...g.subs }, hit });
    g.subs = {};
    if (hit) {
      g.won = true;
      g.played++;
      g.best = Math.min(g.best ?? Infinity, g.round);
    } else {
      g.round++;
    }
  }

  // ---------- 存档与广播 ----------

  async save() {
    await this.ctx.storage.put("g", this.g);
    this.broadcast();
  }

  broadcast(except) {
    const socks = this.ctx.getWebSockets().filter((w) => w !== except);
    const online = new Set(socks.map((w) => w.deserializeAttachment()?.token).filter(Boolean));
    for (const w of socks) {
      const me = this.playerOf(w);
      if (me) this.send(w, this.view(me, online));
    }
  }

  view(me, online) {
    const g = this.g;
    return {
      t: "state",
      code: g.code,
      me: me.id,
      phase: g.players.length < 2 ? "wait" : g.won ? "won" : "play",
      round: g.round,
      players: g.players.map((p) => ({
        id: p.id, nick: p.nick, online: online.has(p.token), ready: p.id in g.subs,
      })),
      mine: g.subs[me.id] ?? null, // 对方的词绝不下发,只给「已写好」
      history: g.history,
      played: g.played,
      best: g.best,
    };
  }
}
