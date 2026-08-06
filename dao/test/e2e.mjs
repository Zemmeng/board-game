// 端到端测试:走真实 HTTP + WebSocket 打通 worker → DO 全链路
// 需要先起本地服务:npx wrangler dev --port 8787
// 用法:node test/e2e.mjs [BASE_URL]
import {
  RES_KEYS, COSTS, PIECE_LIMIT, TILE_VERTICES,
  legalVillages, legalRoads, canPay, buildingAt,
} from "../public/js/shared/rules.js";

const BASE = process.argv[2] ?? "http://localhost:8787";
const WSBASE = BASE.replace(/^http/, "ws");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败:" + msg);
}

async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error("等待超时:" + what);
    await sleep(15);
  }
}

async function connect(code, token, nick) {
  const c = { token, nick, state: null, errs: [], sends: 0 };
  c.ws = new WebSocket(`${WSBASE}/ws?room=${code}`);
  c.ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "state") c.state = m.g;
    else if (m.t === "err") c.errs.push(m.msg);
  });
  await new Promise((res, rej) => {
    c.ws.addEventListener("open", res, { once: true });
    c.ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
  });
  c.send = (obj) => { c.sends++; c.ws.send(JSON.stringify(obj)); };
  c.send({ t: "join", token, nick });
  await waitFor(() => c.state, `${nick} 收到状态`);
  return c;
}

// ---------- 建房加房 ----------
const hostToken = "e2e-host-" + Date.now();
const createRes = await fetch(`${BASE}/api/create`, {
  method: "POST",
  body: JSON.stringify({ hostToken }),
});
assert(createRes.ok, "建房接口失败");
const { code } = await createRes.json();
console.log("房间码:", code);

const clients = [
  await connect(code, hostToken, "端仄"),
  await connect(code, "e2e-b-" + Date.now(), "端梦"),
  await connect(code, "e2e-c-" + Date.now(), "端岛"),
];
assert(clients[0].state.seats.length === 3, "大厅应有 3 人");

// 非房主开局应被拒
clients[1].send({ t: "start", winVP: 8 });
await waitFor(() => clients[1].errs.length > 0, "非房主开局被拒");
console.log("非房主开局被拒 ✓ :", clients[1].errs[0]);
clients[1].errs.length = 0;

clients[0].send({ t: "start", winVP: 8 });
await waitFor(() => clients[0].state.phase === "setup", "进入 setup");
console.log("对局开始,顺序:", clients[0].state.seats.map((s) => s.nick).join(" → "));

const bySeat = (i) => clients.find((c) => c.state.you === i);

// ---------- 开局放置 ----------
while (clients[0].state.phase === "setup") {
  const g0 = clients[0].state;
  const cur = g0.setup.seq[g0.setup.idx];
  const c = bySeat(cur);
  const g = c.state;
  const before = g0.setup.idx * 2 + (g0.setup.need === "road" ? 1 : 0);
  if (g.setup.need === "village") {
    c.send({ t: "place", id: pick(legalVillages(g, cur)) });
  } else {
    c.send({ t: "place", id: pick(legalRoads(g, cur)) });
  }
  await waitFor(() => {
    const s = clients[0].state;
    if (s.phase !== "setup") return true;
    return s.setup.idx * 2 + (s.setup.need === "road" ? 1 : 0) > before;
  }, "放置生效");
}
assert(clients[0].state.phase === "play", "应进入 play");
console.log("开局放置完成 ✓");

// ---------- 断线重连 ----------
{
  const c = clients[1];
  const oldYou = c.state.you;
  c.ws.close();
  await sleep(150);
  await waitFor(() => clients[0].state.seats[oldYou].connected === false, "对手看到掉线");
  const c2 = await connect(code, c.token, c.nick);
  assert(c2.state.you === oldYou, "重连后座位不变");
  assert(c2.state.phase === "play", "重连后仍在对局中");
  clients[1] = c2;
  await waitFor(() => clients[0].state.seats[oldYou].connected === true, "对手看到重连");
  console.log("断线重连找回座位 ✓");
}

// ---------- 随机 AI 打完整局 ----------
// 每个状态版本只行动一次,等广播推进后再走下一步(公网延迟下才不会拿旧状态重复发动作)
let actedSig = null, stuck = 0;
for (let step = 0; step < 30000; step++) {
  const g0 = clients[0].state;
  if (g0.phase === "ended") break;
  const sig = g0.v;
  if (sig === actedSig) {
    if (++stuck > 600) throw new Error("对局卡住:" + JSON.stringify(g0.turn));
    if (stuck % 300 !== 0) { await sleep(10); continue; } // 偶发丢失时 3 秒后允许重发
  } else {
    stuck = 0;
    actedSig = sig;
    // 等三条连接都收到同一版广播,行动者才不会拿旧手牌做决策
    try {
      await waitFor(() => clients.every((c) => c.state.v >= g0.v), "广播收齐", 3000);
    } catch { /* 容忍超时,按当前状态继续 */ }
  }

  const t = g0.turn;
  if (t.pending?.t === "discard") {
    const seat = +Object.keys(t.pending.need)[0];
    const c = bySeat(seat);
    const s = c.state.seats[seat];
    let left = t.pending.need[seat];
    const give = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
    for (const k of RES_KEYS) { const n = Math.min(left, s.res[k]); give[k] = n; left -= n; }
    c.send({ t: "discard", give });
    await sleep(25);
    continue;
  }
  if (t.pending?.t === "robber") {
    const c = bySeat(t.seat);
    const g = c.state;
    const tile = pick(g.board.tiles.filter((x) => x.k !== g.board.robber)).k;
    const victims = [];
    for (const vid of TILE_VERTICES.get(tile)) {
      const b = buildingAt(g, vid);
      if (b && b.seat !== t.seat && !victims.includes(b.seat) && g.seats[b.seat].resCount > 0) victims.push(b.seat);
    }
    c.send({ t: "robber", tile, victim: victims.length ? pick(victims) : null });
    await sleep(25);
    continue;
  }
  const c = bySeat(t.seat);
  const g = c.state;
  const s = g.seats[t.seat];
  if (!t.rolled) {
    c.send({ t: "roll" });
  } else if (t.freeRoads > 0) {
    const spots = legalRoads(g, t.seat);
    if (spots.length && s.roads.length < PIECE_LIMIT.road) c.send({ t: "build", kind: "road", id: pick(spots) });
    else c.send({ t: "end" });
  } else if (s.villages.length && s.cities.length < PIECE_LIMIT.city && canPay(s.res, COSTS.city)) {
    c.send({ t: "build", kind: "city", id: pick(s.villages) });
  } else if (s.villages.length < PIECE_LIMIT.village && canPay(s.res, COSTS.village) && legalVillages(g, t.seat).length) {
    c.send({ t: "build", kind: "village", id: pick(legalVillages(g, t.seat)) });
  } else if (s.roads.length < PIECE_LIMIT.road && canPay(s.res, COSTS.road) && legalRoads(g, t.seat).length && Math.random() < 0.7) {
    c.send({ t: "build", kind: "road", id: pick(legalRoads(g, t.seat)) });
  } else if (!t.devPlayed && s.devs?.some((d) => d.c === "knight" && d.t < t.n) && Math.random() < 0.6) {
    c.send({ t: "play_dev", card: "knight" });
  } else if (g.deckCount > 0 && canPay(s.res, COSTS.dev) && Math.random() < 0.5) {
    c.send({ t: "buy_dev" });
  } else if (RES_KEYS.some((k) => s.res[k] >= 4) && Math.random() < 0.7) {
    const give = pick(RES_KEYS.filter((k) => s.res[k] >= 4));
    const want = RES_KEYS.filter((k) => k !== give && g.bank[k] > 0);
    if (want.length) c.send({ t: "bank_trade", give, get: pick(want) });
    else c.send({ t: "end" });
  } else {
    c.send({ t: "end" });
  }
  await sleep(25);
}

const final = clients[0].state;
assert(final.phase === "ended", "对局未终止");
await waitFor(() => clients.every((c) => c.state.phase === "ended"), "所有客户端收到终局");
const win = final.result.find((r) => r.vp >= final.winVP);
assert(win, "无人达标却终局了");
for (const c of clients) {
  const bad = c.errs.filter((e) => !e.includes("只有房主"));
  assert(bad.length === 0, `${c.nick} 收到意外错误:${bad.join(" | ")}`);
}
console.log(`完整对局 ✓ 胜者 ${final.seats[final.winner].nick},${final.turn.n} 回合,比分:`,
  final.result.map((r) => `${r.nick}${r.vp}`).join(" / "));
console.log("\n✅ 端到端全链路(HTTP 建房 + WebSocket 三人完整对局 + 断线重连)通过");
for (const c of clients) c.ws.close();
