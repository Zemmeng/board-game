// 无头模拟:假 WebSocket/存储直接驱动 UnoRoom,随机策略打完整对局
// 校验:108 张牌守恒、动作全部被接受、对局必然终止、胜者达标
// 用法:node test/sim.mjs [局数]
import { UnoRoom, playable, colorOf, isWild } from "../src/room.js";

const GAMES = Number(process.argv[2] ?? 30);
const COLORS = ["r", "y", "g", "b"];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

function makeRoom() {
  const sockets = [];
  const ctx = {
    storage: {
      data: new Map(),
      async get(k) { return this.data.get(k); },
      async put(k, v) { this.data.set(k, v); },
      async setAlarm() {},
      async deleteAll() { this.data.clear(); },
    },
    blockConcurrencyWhile: (f) => f(),
    getWebSockets: () => sockets,
  };
  return { room: new UnoRoom(ctx), sockets };
}

function fakeWs(sockets) {
  const ws = {
    att: null, sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
    close() {},
  };
  sockets.push(ws);
  return ws;
}

async function act(room, ws, msg) {
  const before = ws.sent.length;
  await room.webSocketMessage(ws, JSON.stringify(msg));
  const errs = ws.sent.slice(before).filter((m) => m.t === "err");
  if (errs.length) throw new Error(`动作被拒绝 ${JSON.stringify(msg)} → ${errs[0].msg}`);
}

function checkConservation(g) {
  if (g.phase !== "play") return;
  const total = g.deck.length + g.pile.length +
    g.seats.reduce((a, s) => a + s.hand.length, 0);
  assert(total === 108, `牌总数 ${total} ≠ 108`);
  g.seats.forEach((s) => assert(s.score >= 0, "分数为负"));
}

async function playOneGame(no) {
  const { room, sockets } = makeRoom();
  await new Promise((r) => setTimeout(r, 0));

  const n = 2 + Math.floor(Math.random() * 3); // 2~4 人
  const target = Math.random() < 0.7 ? 0 : 200; // 多数单局,少数打到 200 分
  const hostToken = "host-" + no;
  const res = await room.fetch(new Request("https://room/claim?code=TESTX", {
    method: "POST", body: JSON.stringify({ hostToken }),
  }));
  assert(res.ok, "claim 失败");

  const wss = [];
  for (let i = 0; i < n; i++) {
    const ws = fakeWs(sockets);
    wss.push(ws);
    await act(room, ws, { t: "join", token: i === 0 ? hostToken : `p${no}-${i}`, nick: "玩家" + i });
  }
  const wsOf = (seat) => wss.find((w) => w.att.token === room.g.seats[seat].token);
  const hostWs = () => wss.find((w) => w.att.token === hostToken);

  await act(room, wss[0], { t: "start", target });
  assert(room.g.phase === "play", "未进入对局");

  let rounds = 0;
  for (let step = 0; step < 60000; step++) {
    const g = room.g;
    if (g.phase === "ended") break;
    checkConservation(g);

    if (g.vulnerable && Math.random() < 0.4) {
      const catcher = g.seats.findIndex((_, i) => i !== g.vulnerable.seat);
      await act(room, wsOf(catcher), { t: "catch" });
      continue;
    }
    if (g.vulnerable && Math.random() < 0.2) {
      await act(room, wsOf(g.vulnerable.seat), { t: "uno_late" });
      continue;
    }

    const p = g.pending;
    if (p?.t === "drawn") {
      await act(room, wsOf(p.seat), {
        t: "play_drawn", play: Math.random() < 0.7,
        color: pick(COLORS), uno: Math.random() < 0.6,
      });
      continue;
    }
    if (p?.t === "challenge") {
      await act(room, wsOf(p.victim), { t: "challenge", accept: Math.random() < 0.6 });
      continue;
    }
    if (p?.t === "firstcolor") {
      await act(room, wsOf(p.seat), { t: "color", c: pick(COLORS) });
      continue;
    }
    if (p?.t === "round") {
      rounds++;
      await act(room, hostWs(), { t: "next_round" });
      continue;
    }

    const seat = g.turn.seat;
    const s = g.seats[seat];
    const cands = s.hand.filter((c) => playable(c, g.pile.at(-1), g.color));
    if (cands.length && Math.random() < 0.9) {
      const card = pick(cands);
      await act(room, wsOf(seat), {
        t: "play", card,
        color: isWild(card) ? pick(COLORS) : undefined,
        uno: Math.random() < 0.6,
      });
    } else {
      await act(room, wsOf(seat), { t: "draw" });
    }
  }

  const g = room.g;
  assert(g.phase === "ended", "对局未终止");
  if (target > 0) assert(g.seats[g.winner].score >= target, "胜者分数未达标");
  assert(g.result?.length === n, "缺少终局结算");
  return { n, target, rounds: g.round, score: g.seats[g.winner].score };
}

for (let i = 0; i < GAMES; i++) {
  const r = await playOneGame(i);
  console.log(`第 ${i + 1} 局:${r.n} 人,${r.target === 0 ? "单局" : "目标 " + r.target},打了 ${r.rounds} 轮,胜者 ${r.score} 分`);
}
console.log(`\n✅ ${GAMES} 局全部通过:108 张守恒、规则校验与终局判定无一失败`);
