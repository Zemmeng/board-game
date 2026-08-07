// 整局无头回归:四个机器人从定缺打到收场,每一步都查不变量。
// 最硬的一条是**牌数守恒** —— 108 张牌任何时刻都必须能在
// 手牌 + 亮出的面子 + 打出去的牌 + 牌墙 里找齐,一张不多一张不少。
import {
  createGame, setLack, setSwap, discard, respond, legalActions,
  angang, bugang, zimo, wallLeft, handSize, SEATS, swappableSuits,
} from "../public/js/shared/game.js";
import { pickLack, pickSwap, pickDiscard, pickResponse, pickTurn } from "../public/js/shared/ai.js";
import { TILE_KINDS, COPIES, hasSuit, canWin, suitOf, tileName } from "../public/js/shared/tiles.js";

const GAMES = 400;
let fail = 0;
const bad = (m) => { if (fail < 12) console.error("❌ " + m); fail++; };

const MELD_TILES = { peng: 3, ming: 4, an: 4, bu: 4 };

function tileCensus(g) {
  const c = new Array(TILE_KINDS).fill(0);
  for (const s of g.seats) {
    for (let t = 0; t < TILE_KINDS; t++) c[t] += s.hand[t];
    for (const m of s.melds) c[m.tile] += MELD_TILES[m.kind];
    for (const t of s.discards) c[t]++;
  }
  for (let i = g.wallAt; i < g.wall.length; i++) c[g.wall[i]]++;
  return c;
}

function checkInvariants(g, tag) {
  const c = tileCensus(g);
  for (let t = 0; t < TILE_KINDS; t++) {
    if (c[t] !== COPIES) {
      bad(`${tag} 牌数不守恒:${tileName(t)} 有 ${c[t]} 张(该 ${COPIES})`);
      return false;
    }
  }
  for (let i = 0; i < SEATS; i++) {
    const s = g.seats[i];
    const n = handSize(s) + s.melds.reduce((a, m) => a + (m.kind === "peng" ? 3 : 4), 0);
    // 一个座位手上 + 亮出的,应该是 13 或 14(摸牌后)张。杠会多摸一张,所以杠一次多算一张
    const gangs = s.melds.filter((m) => m.kind !== "peng").length;
    if (n - gangs !== 13 && n - gangs !== 14) {
      bad(`${tag} ${i} 号牌张数不对:手 ${handSize(s)} + 面子 ${s.melds.length} 副(杠 ${gangs})= ${n}`);
      return false;
    }
    if (s.won && s.lack >= 0 && hasSuit(s.hand, s.lack)) {
      bad(`${tag} ${i} 号胡了却还留着缺门牌`);
      return false;
    }
  }
  return true;
}

let stat = { hu: 0, zimo: 0, draw: 0, gang: 0, peng: 0, rounds: 0, capped: 0 };

for (let n = 0; n < GAMES; n++) {
  const g = createGame(n * 2654435761 + 7, n % SEATS);

  // 定缺
  for (let i = 0; i < SEATS; i++) setLack(g, i, pickLack(g, i));
  if (g.phase !== "swap") { bad(`第 ${n} 局定缺后没进换牌阶段`); break; }
  checkInvariants(g, `局${n} 定缺后`);

  // 换三张
  for (let i = 0; i < SEATS; i++) {
    if (!swappableSuits(g.seats[i]).length) { bad(`局${n} ${i} 号没有任何一门够三张`); break; }
    setSwap(g, i, pickSwap(g, i));
  }
  if (g.phase !== "play") { bad(`第 ${n} 局换牌后没进打牌阶段`); break; }
  if (!checkInvariants(g, `局${n} 换牌后`)) break;

  // 打牌
  let steps = 0;
  while (g.phase === "play") {
    if (++steps > 4000) { bad(`第 ${n} 局打不完(${steps} 步)`); break; }

    if (g.pending) {
      // 所有等着表态的人依次响应
      const waiting = g.pending.waits.filter((i) => !g.pending.acted[i]);
      if (!waiting.length) { bad(`局${n} pending 卡住了`); break; }
      const i = waiting[0];
      const legal = legalActions(g, i);
      if (!legal.length) { bad(`局${n} ${i} 号在 pending 里却没有合法动作`); break; }
      const act = pickResponse(g, i, legal);
      if (act === "hu") stat.hu++;
      if (act === "peng") stat.peng++;
      if (act === "gang") stat.gang++;
      respond(g, i, act);
    } else {
      const seat = g.turn;
      if (g.seats[seat].won) { bad(`局${n} 轮到已经胡了的 ${seat} 号`); break; }
      const act = pickTurn(g, seat);
      if (act.t === "zimo") { stat.zimo++; zimo(g, seat); }
      else if (act.t === "angang") { stat.gang++; angang(g, seat, act.tile); }
      else if (act.t === "bugang") { stat.gang++; bugang(g, seat, act.tile); }
      else {
        if (act.tile < 0 || !g.seats[seat].hand[act.tile]) {
          bad(`局${n} ${seat} 号想打一张自己没有的牌 ${act.tile}`);
          break;
        }
        discard(g, seat, act.tile);
      }
    }
    if (!checkInvariants(g, `局${n} 第${steps}步`)) break;
  }

  if (g.phase !== "over") { bad(`第 ${n} 局没有正常收场(phase=${g.phase})`); break; }

  // 收场检查
  const sum = g.seats.reduce((a, s) => a + s.score, 0);
  if (sum !== 0) bad(`第 ${n} 局分数不守恒,合计 ${sum}(该是 0)`);
  if (g.result.how === "流局") stat.draw++;
  stat.rounds += steps;
  for (const s of g.seats) if (s.winFan && s.winFan.mult >= 32) stat.capped++;

  process.stdout.write(`\r跑完 ${n + 1}/${GAMES} 局…`);
  if (fail > 10) break;
}
console.log();

if (fail) { console.error(`\n❌ ${fail} 项不通过`); process.exit(1); }
const per = (x) => (x / GAMES).toFixed(2);
console.log(`✅ ${GAMES} 局全部打完,牌数与分数始终守恒`);
console.log(`   平均每局 ${per(stat.rounds)} 步 · 胡 ${per(stat.hu + stat.zimo)} 次(自摸 ${per(stat.zimo)})`
          + ` · 碰 ${per(stat.peng)} · 杠 ${per(stat.gang)} · 流局 ${stat.draw}/${GAMES}`);
