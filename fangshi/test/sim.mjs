// 无头模拟:用假 WebSocket/存储直接驱动 FangshiRoom,让策略 AI 打完整对局。
// 校验:动作全部被规则接受、建筑存量守恒、地契不重不漏、对局必然终止、破产清算正确。
// 用法:node test/sim.mjs [局数] [人数]
import { FangshiRoom } from "../src/room.js";
import { decide, actorOf } from "../src/ai.js";
import {
  BOARD, GROUPS, HOUSE_STOCK, HOTEL_STOCK, START_CASH, groupTiles,
} from "../public/js/shared/board.js";

const GAMES = Number(process.argv[2] ?? 30);
const PLAYERS = Number(process.argv[3] ?? 4);
const MAX_STEPS = 40000;

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

// 棋盘自检
assert(BOARD.length === 40, `格数 ${BOARD.length} ≠ 40`);
assert(BOARD.filter((c) => c.t === "ward").length === 22, "坊应有 22 个");
assert(BOARD.filter((c) => c.t === "gate").length === 4, "城门应有 4 座");
assert(BOARD.filter((c) => c.t === "canal").length === 2, "渠应有 2 条");
for (const g of Object.keys(GROUPS)) {
  const n = groupTiles(g).length;
  assert(n === 2 || n === 3, `色组 ${g} 有 ${n} 块,应为 2 或 3`);
}
{
  // 诏令/市井传闻本来就各占 3 格,只有坊名要求唯一
  const wards = BOARD.filter((c) => c.t === "ward").map((c) => c.name);
  assert(new Set(wards).size === wards.length, "坊名不应重复");
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
    acceptWebSocket: () => {},
  };
  const room = new FangshiRoom(ctx);
  room.scheduleBot = () => {}; // 测试里由主循环驱动,不用房间自己的定时器
  return room;
}

function fakeWs(token) {
  return {
    att: { token },
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
    send() {},
    close() {},
  };
}

/** 全局不变量:建筑存量守恒、地契归属合法、现金非负 */
function checkInvariants(g, tag) {
  let houses = 0, hotels = 0;
  for (let i = 0; i < BOARD.length; i++) {
    const t = g.tiles[i];
    assert(t.level >= 0 && t.level <= 5, `${tag}:${BOARD[i].name} 等级 ${t.level} 越界`);
    if (t.level === 5) hotels++;
    else houses += t.level;
    if (t.level > 0) {
      assert(BOARD[i].t === "ward", `${tag}:${BOARD[i].name} 不是坊却有建筑`);
      assert(t.owner >= 0, `${tag}:${BOARD[i].name} 有建筑却无主`);
      assert(!t.mortgaged, `${tag}:${BOARD[i].name} 已抵押却还有建筑`);
      // 均衡营造:同组等级差不超过 1
      const lv = groupTiles(BOARD[i].g).map((j) => g.tiles[j].level);
      assert(Math.max(...lv) - Math.min(...lv) <= 1, `${tag}:${BOARD[i].name} 所在组营造不均衡 ${lv}`);
    }
    if (t.owner >= 0) {
      assert(g.tiles[i].owner < g.seats.length, `${tag}:地契归属越界`);
      assert(!g.seats[t.owner].bankrupt, `${tag}:${BOARD[i].name} 归属已破产的 ${g.seats[t.owner].nick}`);
    }
  }
  assert(houses + g.houses === HOUSE_STOCK, `${tag}:店铺存量不守恒 ${houses}+${g.houses}≠${HOUSE_STOCK}`);
  assert(hotels + g.hotels === HOTEL_STOCK, `${tag}:商号存量不守恒 ${hotels}+${g.hotels}≠${HOTEL_STOCK}`);
  for (const s of g.seats) {
    assert(s.cash >= 0, `${tag}:${s.nick} 现银为负 ${s.cash}`);
    assert(s.pardons >= 0, `${tag}:${s.nick} 免罪金牌为负`);
    if (s.bankrupt) assert(s.cash === 0, `${tag}:破产的 ${s.nick} 还留着现银`);
  }
}

async function playOne(seed) {
  const room = makeRoom();
  await room.fetch(new Request("https://room/claim?code=TEST1", {
    method: "POST", body: JSON.stringify({ hostToken: "t0" }),
  }));

  const wss = [];
  for (let i = 0; i < PLAYERS; i++) {
    const ws = fakeWs("t" + i);
    wss.push(ws);
    await room.handle(ws, { t: "join", token: "t" + i, nick: "坊客" + i });
  }
  await room.handle(wss[0], { t: "start" });

  const stats = { steps: 0, buys: 0, auctions: 0, builds: 0, bankrupts: 0, jail: 0, timeouts: 0 };
  let lastPending = null;

  for (; stats.steps < MAX_STEPS; stats.steps++) {
    const g = room.g;
    if (g.phase === "ended") break;
    const seat = actorOf(g);
    assert(seat >= 0 && seat < PLAYERS, `第 ${seed} 局:轮空,pending=${JSON.stringify(g.pending)}`);
    const act = decide(g, seat);
    assert(act, `第 ${seed} 局:AI 无动作可出,seat=${seat} pending=${JSON.stringify(g.pending)}`);

    if (act.t === "buy") stats.buys++;
    if (act.t === "build") stats.builds++;
    if (g.pending?.t === "auction" && g.pending !== lastPending) { stats.auctions++; lastPending = g.pending; }
    if (g.seats[seat].jailed) stats.jail++;

    const before = g.seats.filter((s) => s.bankrupt).length;
    await room.handle(wss[seat], act); // 规则拒绝会抛异常 —— 等于 AI 出了非法手
    stats.bankrupts += room.g.seats.filter((s) => s.bankrupt).length - before;

    checkInvariants(room.g, `第 ${seed} 局第 ${stats.steps} 步(${act.t})`);
  }

  const g = room.g;
  assert(g.phase === "ended", `第 ${seed} 局:${MAX_STEPS} 步还没打完`);
  const alive = g.seats.filter((s) => !s.bankrupt);
  if (g.byTimeout) stats.timeouts = 1;
  else assert(alive.length === 1, `第 ${seed} 局:正常结束时应只剩 1 人,实际 ${alive.length}`);
  assert(g.winner >= 0 && !g.seats[g.winner].bankrupt, `第 ${seed} 局:胜者不对`);
  return stats;
}

const t0 = Date.now();
const totals = { steps: 0, buys: 0, auctions: 0, builds: 0, bankrupts: 0, jail: 0, timeouts: 0 };
for (let i = 1; i <= GAMES; i++) {
  const st = await playOne(i);
  for (const k of Object.keys(totals)) totals[k] += st[k];
  process.stdout.write(`\r跑完 ${i}/${GAMES} 局…`);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✅ ${GAMES} 局 ${PLAYERS} 人局全部打完,用时 ${secs}s`);
console.log(`   平均每局 ${(totals.steps / GAMES).toFixed(0)} 步,` +
  ` 买地 ${(totals.buys / GAMES).toFixed(1)}, 拍卖 ${(totals.auctions / GAMES).toFixed(1)},` +
  ` 营造 ${(totals.builds / GAMES).toFixed(1)}, 破产 ${(totals.bankrupts / GAMES).toFixed(1)},` +
  ` 蹲牢 ${(totals.jail / GAMES).toFixed(1)}` + `, 触发保险闸 ${totals.timeouts}/${GAMES} 局`);
