// 机器人 / 测试用的决策策略。纯函数:看一眼状态,吐出一个「此刻该发什么动作」。
// 无头回归测试(test/sim.mjs)和房间里的机器人陪练共用同一份,免得两套逻辑跑偏。
import {
  BOARD, GROUPS, groupTiles, hasMonopoly, mortgageValue, redeemCost,
} from "../public/js/shared/board.js";

const RESERVE = 250;      // 手里至少留这么多现银
const BUILD_CASH = 450;   // 现银高于此才考虑营造
const REDEEM_CASH = 700;  // 现银高于此才考虑赎回抵押

/** 此刻轮到谁动作(可能不是当前回合玩家 —— 拍卖和交易会把球踢给别人) */
export function actorOf(g) {
  const p = g.pending;
  if (p?.t === "buy") return p.seat;
  if (p?.t === "auction") return p.alive[p.at];
  if (p?.t === "trade") return p.to;
  return g.turn?.seat ?? -1;
}

/** 这块地对 seat 值多少钱(用于买地和拍卖出价) */
function worth(g, seat, i) {
  const c = BOARD[i];
  if (!c.price) return 0;
  let v = c.price;
  if (c.t === "gate") v *= 1.25;
  if (c.t === "canal") v *= 1.1;
  if (c.t === "ward") {
    const ts = groupTiles(c.g);
    const mine = ts.filter((j) => g.tiles[j].owner === seat).length;
    // 差这一块就凑齐整组 → 志在必得
    if (mine === ts.length - 1) v *= 2.0;
    else if (mine > 0) v *= 1.3;
    // 别人差这一块就凑齐 → 抢下来卡住他
    for (const [s] of g.seats.entries()) {
      if (s === seat) continue;
      const his = ts.filter((j) => g.tiles[j].owner === s).length;
      if (his === ts.length - 1) { v *= 1.4; break; }
    }
  }
  return Math.round(v);
}

/** 组内下一块该营造的地(保持均衡,挑最便宜的先盖) */
function buildTarget(g, seat) {
  let best = null;
  for (let i = 0; i < BOARD.length; i++) {
    const c = BOARD[i], t = g.tiles[i];
    if (c.t !== "ward" || t.owner !== seat || t.mortgaged || t.level >= 5) continue;
    if (!hasMonopoly(g, seat, c.g)) continue;
    if (groupTiles(c.g).some((j) => g.tiles[j].level < t.level)) continue;
    const cost = GROUPS[c.g].houseCost;
    if (g.seats[seat].cash - cost < RESERVE) continue;
    if (t.level === 4 ? g.hotels <= 0 : g.houses <= 0) continue;
    if (!best || cost < best.cost) best = { tile: i, cost };
  }
  return best;
}

/**
 * seat 名下地产的整体价值:地价照收,凑齐整组另给一大笔垄断溢价
 * (垄断才能盖房,是这游戏真正的赚钱手段,所以溢价必须显著大于单块地面值)。
 * swap 是「格号 → 新主人」的假设改动,用来预演一笔交易成交后的样子。
 */
function portfolio(g, seat, swap) {
  const ownerAt = (i) => (swap?.has(i) ? swap.get(i) : g.tiles[i].owner);
  let v = 0;
  for (let i = 0; i < BOARD.length; i++) {
    if (BOARD[i].price && ownerAt(i) === seat) v += BOARD[i].price;
  }
  for (const gr of Object.keys(GROUPS)) {
    const ts = groupTiles(gr);
    if (ts.every((i) => ownerAt(i) === seat)) {
      v += ts.reduce((a, i) => a + BOARD[i].price, 0) * 2.5;
    }
  }
  // 城门/渠也有规模效应,持有越多越值钱
  for (const type of ["gate", "canal"]) {
    const n = BOARD.reduce((a, c, i) => a + (c.t === type && ownerAt(i) === seat ? 1 : 0), 0);
    if (n > 1) v += n * n * 40;
  }
  return v;
}

/** 某人差一块就凑齐的组里,那块「缺口」地在谁手上 */
function gapsFor(g, seat) {
  const out = [];
  for (const gr of Object.keys(GROUPS)) {
    const ts = groupTiles(gr);
    const mine = ts.filter((i) => g.tiles[i].owner === seat);
    if (mine.length !== ts.length - 1) continue;
    const missing = ts.find((i) => g.tiles[i].owner !== seat);
    if (g.tiles[missing].owner < 0) continue;      // 还没卖出去,买就是了
    if (g.tiles[missing].level > 0) continue;      // 有建筑的地不能交易
    out.push({ group: gr, tile: missing, holder: g.tiles[missing].owner });
  }
  return out;
}

/**
 * 换地:优先「我缺的换他缺的」双赢互换,其次直接出高价买。
 * 没有这一步,四个人把地随机瓜分完就再没人能垄断,局面会僵到天荒地老。
 */
function proposeTrade(g, seat) {
  const myGaps = gapsFor(g, seat);
  if (!myGaps.length) return null;

  for (const gap of myGaps) {
    const holder = gap.holder;
    if (g.seats[holder].bankrupt) continue;
    const hisGaps = gapsFor(g, holder).filter((x) => g.tiles[x.tile].owner === seat);

    // 双赢互换:各自把对方缺的那块让出来
    if (hisGaps.length) {
      return {
        t: "trade_offer", to: holder,
        giveTiles: [hisGaps[0].tile], wantTiles: [gap.tile],
        giveCash: 0, wantCash: 0, givePardon: 0, wantPardon: 0,
      };
    }
    // 换不成就加钱买:出到三倍地价才盖得过对方「卡住你」的溢价
    const price = BOARD[gap.tile].price * 3;
    if (g.seats[seat].cash - price >= RESERVE) {
      return {
        t: "trade_offer", to: holder,
        giveTiles: [], wantTiles: [gap.tile],
        giveCash: price, wantCash: 0, givePardon: 0, wantPardon: 0,
      };
    }
  }
  return null;
}

/**
 * 给出 seat 此刻应发的动作;返回 null 表示「没我的事」。
 * 只会给出规则上合法的动作,避免测试里刷一屏拒绝。
 */
export function decide(g, seat) {
  if (!g || g.phase !== "play") return null;
  if (g.seats[seat]?.bankrupt) return null;
  if (actorOf(g) !== seat) return null;

  const p = g.pending;
  const s = g.seats[seat];

  // 买地:值不值 + 留不留得住底
  if (p?.t === "buy") {
    const price = BOARD[p.tile].price;
    const v = worth(g, seat, p.tile);
    const affordable = s.cash - price >= RESERVE * 0.6;
    return { t: (v >= price && affordable) || s.cash > price * 4 ? "buy" : "decline" };
  }

  // 拍卖:出到心理价位为止
  if (p?.t === "auction") {
    const cap = Math.min(worth(g, seat, p.tile), Math.max(0, s.cash - RESERVE * 0.5));
    const next = (p.high || 9) + 1;
    if (next > cap) return { t: "bid_pass" };
    return { t: "bid", amount: next };
  }

  // 交易:比较成交前后「整个资产组合」的价值,而不是给单块地估价。
  // 按单块估价会两头都套上「凑齐我的组 ×2」和「卡住对手 ×1.4」,
  // 结果双方都觉得自己吃亏,互换永远谈不拢 —— 实测 99.8% 的提议被回绝、一间房盖不起来。
  if (p?.t === "trade") {
    const before = portfolio(g, seat, null);
    const swap = new Map();
    for (const i of p.give) swap.set(i, seat);       // 对方给我的
    for (const i of p.want) swap.set(i, p.from);     // 我让出去的
    const after = portfolio(g, seat, swap) + p.giveCash - p.wantCash
      + (p.givePardon - p.wantPardon) * 50;
    return { t: after > before ? "trade_accept" : "trade_reject" };
  }

  // 自己的回合
  if (s.jailed && !g.turn.rolled) {
    if (s.pardons > 0) return { t: "jail_card" };
    // 前期地多没卖完,早点出来划算;后期蹲着躲租
    if (s.cash > 400) return { t: "jail_pay" };
    return { t: "roll" };
  }
  if (!g.turn.rolled || g.turn.canRollAgain) return { t: "roll" };

  // 掷完了:先试着换地凑组(不换就永远没人垄断,局面会一直僵着),再营造、赎押、收工
  if (!(g.turn.offered > 0)) {
    const t = proposeTrade(g, seat);
    if (t) return t;
  }
  if (s.cash >= BUILD_CASH) {
    const b = buildTarget(g, seat);
    if (b) return { t: "build", tile: b.tile };
  }
  if (s.cash >= REDEEM_CASH) {
    for (let i = 0; i < BOARD.length; i++) {
      const t = g.tiles[i];
      if (t.owner === seat && t.mortgaged && s.cash - redeemCost(i) >= RESERVE) {
        return { t: "redeem", tile: i };
      }
    }
  }
  return { t: "end_turn" };
}
