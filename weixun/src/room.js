// TableRoom:微醺局的「房间备忘录」Durable Object
// 发词本身不靠服务端(各手机按 房间码+轮数 自己算),这里只存几样需要大家共享的东西:
//   - 房主身份(认领即得,令牌存在房主手机上)
//   - 房主的自定义词库(我是谁 / 禁忌 / 卧底)
//   - 每轮:房主给某个座位换的词、谁已出局/猜错几次/指定谁喝、禁忌倒计时
//   - 座位昵称
// 连不上它时,前端退回纯本地模式照样能玩

const IDLE_WIPE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SEAT = 10;
const MAX_ROUNDS_KEPT = 30;
const BANK_KEYS = ["who", "taboo", "spy"];
const BANK_MAX_CHARS = 40000;
const KEY_RE = /^(who|taboo|spy):\d{1,4}$/;

const bad = (msg, status = 400) => Response.json({ error: msg }, { status });
const seatOk = (s) => Number.isInteger(s) && s >= 0 && s <= MAX_SEAT;
const clip = (s, n) => String(s ?? "").trim().slice(0, n);

export class TableRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("g")) ?? fresh();
    });
  }

  async commit() {
    this.g.v++;
    await this.ctx.storage.put("g", this.g);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
  }

  async alarm() {
    this.g = fresh();
    await this.ctx.storage.deleteAll();
  }

  round(key) {
    const g = this.g;
    if (!g.rounds[key]) {
      g.rounds[key] = { fix: {}, st: {}, timer: null };
      g.order.push(key);
      while (g.order.length > MAX_ROUNDS_KEPT) delete g.rounds[g.order.shift()];
    }
    return g.rounds[key];
  }

  view(key, token) {
    const g = this.g;
    return {
      now: Date.now(),
      v: g.v,
      host: g.host ? { seat: g.host.seat, mine: !!token && token === g.host.token } : null,
      names: g.names,
      bankVer: g.bankVer,
      r: (key && g.rounds[key]) || { fix: {}, st: {}, timer: null },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const token = request.headers.get("x-token") || "";
    const key = url.searchParams.get("k") || "";

    if (request.method === "GET" && url.pathname.endsWith("/bank")) {
      return Response.json({ bankVer: this.g.bankVer, bank: this.g.bank });
    }
    if (request.method === "GET") {
      if (key && !KEY_RE.test(key)) return bad("bad key");
      return Response.json(this.view(key, token));
    }
    if (request.method !== "POST") return bad("method", 405);

    let m;
    try { m = await request.json(); } catch { return bad("bad json"); }
    const g = this.g;
    const isHost = !!g.host && !!token && g.host.token === token;
    const needHost = () => (isHost ? null : bad("只有房主能这么做", 403));
    if (m.k !== undefined && !KEY_RE.test(m.k)) return bad("bad key");

    switch (m.op) {
      case "name": {
        if (!seatOk(m.seat) || m.seat === 0) return bad("bad seat");
        const name = clip(m.name, 8);
        if (name) g.names[m.seat] = name; else delete g.names[m.seat];
        break;
      }
      case "claim": {
        if (g.host && !isHost) return bad("房间已经有房主了", 409);
        if (!token || token.length < 16) return bad("bad token");
        g.host = { token, seat: seatOk(m.seat) ? m.seat : 0 };
        break;
      }
      case "unhost": {
        const e = needHost(); if (e) return e;
        g.host = null;
        break;
      }
      case "bank": {
        const e = needHost(); if (e) return e;
        const next = {};
        for (const k of BANK_KEYS) {
          const t = m.bank?.[k];
          if (typeof t === "string" && t.trim()) {
            if (t.length > BANK_MAX_CHARS) return bad("词库太长了");
            next[k] = t;
          }
        }
        g.bank = Object.keys(next).length ? next : null;
        g.bankVer++;
        break;
      }
      case "fix": {
        const e = needHost(); if (e) return e;
        if (!seatOk(m.seat)) return bad("bad seat");
        const r = this.round(m.k);
        if (m.clear) delete r.fix[m.seat];
        else if (m.word) r.fix[m.seat] = { n: (r.fix[m.seat]?.n || 0), word: clip(m.word, 61) };
        else r.fix[m.seat] = { n: (r.fix[m.seat]?.n || 0) + 1 };
        break;
      }
      case "st": {
        if (!seatOk(m.seat) || m.seat === 0) return bad("bad seat");
        const r = this.round(m.k);
        const cur = r.st[m.seat] || {};
        if ("out" in m) cur.out = !!m.out;
        if ("wrong" in m) cur.wrong = Math.max(0, Math.min(9, m.wrong | 0));
        if ("pick" in m) cur.pick = seatOk(m.pick) && m.pick > 0 ? m.pick : 0;
        r.st[m.seat] = cur;
        break;
      }
      case "timer": {
        const r = this.round(m.k);
        if (m.dur) {
          const dur = Math.max(10, Math.min(3600, m.dur | 0));
          r.timer = { end: Date.now() + dur * 1000, dur };
        } else r.timer = null;
        break;
      }
      case "reset": {
        const r = this.round(m.k);
        r.st = {}; r.timer = null;
        break;
      }
      default:
        return bad("unknown op");
    }
    await this.commit();
    return Response.json(this.view(m.k, token));
  }
}

function fresh() {
  return { v: 0, host: null, names: {}, bank: null, bankVer: 0, rounds: {}, order: [] };
}
