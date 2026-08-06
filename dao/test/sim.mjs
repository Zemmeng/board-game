// 无头模拟:用假 WebSocket/存储直接驱动 GameRoom,随机 AI 打完整对局
// 校验:资源守恒、动作全部被规则接受、对局必然终止、胜者达标
// 用法:node test/sim.mjs [局数]
import { GameRoom } from "../src/room.js";
import {
  RES_KEYS, COSTS, PIECE_LIMIT, VERTICES, EDGES, TILE_VERTICES,
  legalVillages, legalRoads, canPay, buildingAt, totalVP,
} from "../public/js/shared/rules.js";

const GAMES = Number(process.argv[2] ?? 40);

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

// 几何自检:标准卡坦棋盘 19 格 / 54 顶点 / 72 棱
assert(TILE_VERTICES.size === 19, `地格数 ${TILE_VERTICES.size} ≠ 19`);
assert(VERTICES.size === 54, `顶点数 ${VERTICES.size} ≠ 54`);
assert(EDGES.size === 72, `棱数 ${EDGES.size} ≠ 72`);

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
  return { room: new GameRoom(ctx), sockets };
}

function fakeWs(sockets) {
  const ws = {
    att: null,
    sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
    close() {},
  };
  sockets.push(ws);
  return ws;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function act(room, ws, msg, mustSucceed = true) {
  const before = ws.sent.length;
  await room.webSocketMessage(ws, JSON.stringify(msg));
  const errs = ws.sent.slice(before).filter((m) => m.t === "err");
  if (mustSucceed && errs.length) {
    throw new Error(`动作被拒绝 ${JSON.stringify(msg)} → ${errs[0].msg}`);
  }
  return errs.length === 0;
}

function checkConservation(g) {
  for (const k of RES_KEYS) {
    const total = g.bank[k] + g.seats.reduce((a, s) => a + s.res[k], 0);
    assert(total === 19, `${k} 总量 ${total} ≠ 19`);
    assert(g.bank[k] >= 0, `${k} 银行为负`);
    g.seats.forEach((s) => assert(s.res[k] >= 0, `${s.nick} 的 ${k} 为负`));
  }
  g.seats.forEach((s) => {
    assert(s.roads.length <= PIECE_LIMIT.road, "道路超上限");
    assert(s.villages.length <= PIECE_LIMIT.village, "村庄超上限");
    assert(s.cities.length <= PIECE_LIMIT.city, "城邑超上限");
  });
}

async function playOneGame(gameNo) {
  const { room, sockets } = makeRoom();
  await new Promise((r) => setTimeout(r, 0)); // 等 blockConcurrencyWhile 完成

  const nPlayers = 2 + Math.floor(Math.random() * 3); // 2~4 人
  const hostToken = "host-" + gameNo;
  const res = await room.fetch(new Request("https://room/claim?code=TESTX", {
    method: "POST",
    body: JSON.stringify({ hostToken }),
  }));
  assert(res.ok, "claim 失败");

  const wss = [];
  for (let i = 0; i < nPlayers; i++) {
    const ws = fakeWs(sockets);
    wss.push(ws);
    await act(room, ws, { t: "join", token: i === 0 ? hostToken : `p${gameNo}-${i}`, nick: "玩家" + i });
  }
  const wsOf = (seat) => wss.find((w) => w.att.token === room.g.seats[seat].token);

  await act(room, wss[0], { t: "start", winVP: Math.random() < 0.5 ? 8 : 10 });
  assert(room.g.phase === "setup", "未进入 setup");

  // 开局蛇形放置
  while (room.g.phase === "setup") {
    const g = room.g;
    const seat = g.setup.seq[g.setup.idx];
    if (g.setup.need === "village") {
      await act(room, wsOf(seat), { t: "place", id: pick(legalVillages(g, seat)) });
    } else {
      await act(room, wsOf(seat), { t: "place", id: pick(legalRoads(g, seat)) });
    }
    checkConservation(room.g);
  }
  assert(room.g.phase === "play", "未进入 play");

  // 随机 AI 回合循环
  for (let step = 0; step < 6000; step++) {
    const g = room.g;
    if (g.phase === "ended") break;
    const t = g.turn;

    if (t.pending?.t === "discard") {
      const seat = +Object.keys(t.pending.need)[0];
      const s = g.seats[seat];
      let left = t.pending.need[seat];
      const give = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
      for (const k of RES_KEYS) {
        const n = Math.min(left, s.res[k]);
        give[k] = n;
        left -= n;
      }
      await act(room, wsOf(seat), { t: "discard", give });
    } else if (t.pending?.t === "robber") {
      const seat = t.seat;
      const tile = pick(g.board.tiles.filter((x) => x.k !== g.board.robber)).k;
      const victims = [];
      for (const vid of TILE_VERTICES.get(tile)) {
        const b = buildingAt(g, vid);
        if (b && b.seat !== seat && !victims.includes(b.seat) &&
            RES_KEYS.some((k) => g.seats[b.seat].res[k] > 0)) victims.push(b.seat);
      }
      await act(room, wsOf(seat), { t: "robber", tile, victim: victims.length ? pick(victims) : null });
    } else if (!t.rolled) {
      // 掷骰前:偶尔先打一张发展卡
      await maybePlayDev(room, t.seat, 0.15);
      if (room.g.phase === "ended" || room.g.turn.pending) { checkConservation(room.g); continue; }
      await act(room, wsOf(t.seat), { t: "roll" });
    } else {
      const seat = t.seat;
      const s = g.seats[seat];
      if (t.freeRoads > 0) {
        const spots = legalRoads(g, seat);
        if (spots.length && s.roads.length < PIECE_LIMIT.road) {
          await act(room, wsOf(seat), { t: "build", kind: "road", id: pick(spots) });
        } else {
          await act(room, wsOf(seat), { t: "end" });
        }
      } else if (s.villages.length && s.cities.length < PIECE_LIMIT.city && canPay(s.res, COSTS.city)) {
        await act(room, wsOf(seat), { t: "build", kind: "city", id: pick(s.villages) });
      } else if (s.villages.length < PIECE_LIMIT.village && canPay(s.res, COSTS.village) && legalVillages(g, seat).length) {
        await act(room, wsOf(seat), { t: "build", kind: "village", id: pick(legalVillages(g, seat)) });
      } else if (s.roads.length < PIECE_LIMIT.road && canPay(s.res, COSTS.road) && legalRoads(g, seat).length && Math.random() < 0.8) {
        await act(room, wsOf(seat), { t: "build", kind: "road", id: pick(legalRoads(g, seat)) });
      } else if (g.deck.length && canPay(s.res, COSTS.dev) && Math.random() < 0.6) {
        await act(room, wsOf(seat), { t: "buy_dev" });
      } else if (await tryTradeOrDev(room, seat)) {
        // 已在函数里行动
      } else {
        await act(room, wsOf(seat), { t: "end" });
      }
    }
    checkConservation(room.g);
  }

  const g = room.g;
  assert(g.phase === "ended", `对局未终止(${g.turn?.n} 回合后)`);
  assert(totalVP(g, g.winner) >= g.winVP, "胜者分数未达标");
  return { turns: g.turn.n, players: nPlayers, winVP: g.winVP, vp: totalVP(g, g.winner) };

  async function maybePlayDev(room2, seat, prob) {
    if (Math.random() > prob) return;
    await tryTradeOrDev(room2, seat, true);
  }

  async function tryTradeOrDev(room2, seat, devOnly = false) {
    const g2 = room2.g;
    const s = g2.seats[seat];
    const ws = wsOf(seat);
    // 打发展卡
    if (!g2.turn.devPlayed) {
      const playable = s.devs.filter((d) => d.t < g2.turn.n && d.c !== "vp");
      if (playable.length && Math.random() < 0.7) {
        const card = pick(playable).c;
        if (card === "knight") {
          await act(room2, ws, { t: "play_dev", card });
          return true;
        }
        if (card === "monopoly") {
          await act(room2, ws, { t: "play_dev", card, res: pick(RES_KEYS) });
          return true;
        }
        if (card === "invent") {
          const avail = RES_KEYS.filter((k) => g2.bank[k] > 0);
          if (avail.length) {
            const r1 = pick(avail);
            const avail2 = RES_KEYS.filter((k) => g2.bank[k] > (k === r1 ? 1 : 0));
            if (avail2.length) {
              await act(room2, ws, { t: "play_dev", card, res: r1, res2: pick(avail2) });
              return true;
            }
          }
        }
        if (card === "roads") {
          if (s.roads.length < PIECE_LIMIT.road && legalRoads(g2, seat).length) {
            await act(room2, ws, { t: "play_dev", card });
            return true;
          }
        }
      }
    }
    if (devOnly || !g2.turn.rolled) return false;
    // 4:1 换缺口资源
    const rich = RES_KEYS.filter((k) => s.res[k] >= 4);
    if (rich.length && Math.random() < 0.8) {
      const give = pick(rich);
      const want = RES_KEYS.filter((k) => k !== give && g2.bank[k] > 0);
      if (want.length) {
        await act(room2, ws, { t: "bank_trade", give, get: pick(want) });
        return true;
      }
    }
    return false;
  }
}

let totalTurns = 0;
for (let i = 0; i < GAMES; i++) {
  const r = await playOneGame(i);
  totalTurns += r.turns;
  console.log(`第 ${i + 1} 局:${r.players} 人,目标 ${r.winVP} 分,${r.turns} 回合后胜者 ${r.vp} 分`);
}
console.log(`\n✅ ${GAMES} 局全部通过(平均 ${(totalTurns / GAMES).toFixed(0)} 回合),资源守恒与规则校验无一失败`);
