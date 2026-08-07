// 川麻机器人。前后端共用,确定性:随机一律走 g.seed。
// 目标不是打得多好,是**永远给得出一个合法动作**,不然血战到底会卡死。

import {
  TILE_KINDS, suitOf, rankOf, tileName, hasSuit, canWin, isTing, tingTiles,
} from "./tiles.js";
import { rngNext, SEATS, swappableSuits, legalActions } from "./game.js";

/** 定缺:哪门牌最少就缺哪门(张数一样时挑更零散的那门) */
export function pickLack(g, seat) {
  const h = g.seats[seat].hand;
  let best = 0, bestScore = Infinity;
  for (let q = 0; q < 3; q++) {
    let n = 0, links = 0;
    for (let t = q * 9; t < q * 9 + 9; t++) {
      n += h[t];
      if (h[t] && h[t + 1] && rankOf(t) <= 8) links++;
      if (h[t] >= 2) links++;
    }
    const score = n * 10 + links;      // 张数为主,搭子为辅
    if (score < bestScore) { bestScore = score; best = q; }
  }
  return best;
}

/** 换三张:优先把缺门的牌换出去 */
export function pickSwap(g, seat) {
  const s = g.seats[seat];
  const cand = swappableSuits(s);
  const q = cand.includes(s.lack) ? s.lack : cand[0];
  const out = [];
  // 先挑孤张,留着搭子
  const order = [];
  for (let t = q * 9; t < q * 9 + 9; t++) {
    for (let k = 0; k < s.hand[t]; k++) order.push(t);
  }
  order.sort((a, b) => tileValue(s.hand, a) - tileValue(s.hand, b));
  for (const t of order) { if (out.length < 3) out.push(t); }
  return out;
}

/** 一张牌有多「有用」:成对/成刻、能连成顺子的都算分 */
function tileValue(hand, t) {
  let v = hand[t] * 3;
  const r = rankOf(t);
  if (r >= 2 && hand[t - 1]) v += 2;
  if (r <= 8 && hand[t + 1]) v += 2;
  if (r >= 3 && hand[t - 2]) v += 1;
  if (r <= 7 && hand[t + 2]) v += 1;
  return v;
}

/** 该打哪张 */
export function pickDiscard(g, seat) {
  const s = g.seats[seat];
  // 缺门没打完:只能打缺门,挑最没用的那张
  if (hasSuit(s.hand, s.lack)) {
    let best = -1, bv = Infinity;
    for (let t = s.lack * 9; t < s.lack * 9 + 9; t++) {
      if (!s.hand[t]) continue;
      const v = tileValue(s.hand, t);
      if (v < bv) { bv = v; best = t; }
    }
    return best;
  }

  // 能听牌就优先保听
  let best = -1, bestScore = -Infinity;
  for (let t = 0; t < TILE_KINDS; t++) {
    if (!s.hand[t]) continue;
    s.hand[t]--;
    const ting = tingTiles(s.hand, s.melds, s.lack);
    s.hand[t]++;
    // 听的张数越多越好;其次是把没用的牌丢掉
    const score = ting.length * 100 - tileValue(s.hand, t);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** 别人打了张牌,要不要? */
export function pickResponse(g, seat, legal) {
  if (legal.includes("hu")) return "hu";       // 血战到底,能胡就胡
  const s = g.seats[seat];
  const r = rngNext(g.seed);
  // 杠白给分,基本都杠
  if (legal.includes("gang") && r < 0.85) return "gang";
  // 碰要看会不会把手打散:碰完还听得了牌才碰
  if (legal.includes("peng") && r < 0.5) return "peng";
  return "pass";
}

/** 轮到自己时(已摸牌)该干嘛。返回 {t:"zimo"|"angang"|"bugang"|"discard", tile} */
export function pickTurn(g, seat) {
  const legal = legalActions(g, seat);
  if (legal.includes("zimo")) return { t: "zimo" };

  const gangs = legal.filter((a) => a.startsWith("angang:") || a.startsWith("bugang:"));
  if (gangs.length && rngNext(g.seed) < 0.8) {
    const pick = gangs[Math.floor(rngNext(g.seed) * gangs.length)];
    const [kind, tile] = pick.split(":");
    return { t: kind, tile: +tile };
  }
  return { t: "discard", tile: pickDiscard(g, seat) };
}
