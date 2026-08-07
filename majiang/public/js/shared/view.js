// 按座位裁剪牌局状态。
//
// ⚠️ 这是麻将跟这个仓库里另外几款游戏最要命的区别:岛屿开拓、余一、长安坊市的信息
// 基本全公开,服务端把整个 g 广播出去就行;麻将有暗牌,**整份广播等于开挂**——
// 谁打开控制台看一眼 WebSocket 就知道所有人手里是什么。
// 所以服务端只能下发这个函数的结果,绝不能下发 g 本身。

import { TILE_KINDS, tingTiles, canWin, hasSuit } from "./tiles.js";
import { legalActions, wallLeft, handSize, SEATS } from "./game.js";

export function viewFor(g, seat) {
  const me = g.seats[seat];

  const v = {
    phase: g.phase,
    turn: g.turn,
    dealer: g.dealer,
    swapDir: g.swapDir,
    wallLeft: wallLeft(g),
    me: seat,
    lastDrawn: g.turn === seat ? g.lastDrawn : -1,   // 别人摸了什么不告诉你
    log: g.log.slice(-40),
    result: g.result,

    // 自己的牌:全部给
    hand: me ? me.hand.slice() : [],
    lack: me ? me.lack : -1,
    swapPicked: me?.swap ? me.swap.slice() : null,

    // 别人:只给张数和亮出来的东西
    seats: g.seats.map((s, i) => ({
      seat: i,
      nick: s.nick ?? null,
      bot: !!s.bot,
      connected: s.connected !== false,
      // 定缺在定缺阶段是暗的,开打之后才亮出来
      lack: g.phase === "lack" ? (i === seat ? s.lack : -1) : s.lack,
      handCount: handSize(s),
      melds: s.melds.map((m) => ({ ...m })),
      discards: s.discards.slice(),
      won: s.won,
      winFan: s.winFan,
      score: s.score,
      picked: g.phase === "swap" ? !!s.swap : undefined,   // 只说他选没选,不说选了什么
    })),
  };

  // 等着表态的那张牌:只有轮到你表态时才把可选动作给你
  if (g.pending) {
    const p = g.pending;
    v.pending = {
      tile: p.tile,
      from: p.from,
      mine: p.waits.includes(seat) && !p.acted[seat],
      waiting: p.waits.filter((i) => !p.acted[i]).length,
    };
  }

  v.actions = legalActions(g, seat);

  // ---- 手感辅助:听什么、打哪张能听 ----
  // 这些都能由客户端自己算(手牌是自己的),放服务端算只是省事且保证一致。
  if (me && g.phase === "play" && !me.won) {
    v.ting = tingTiles(me.hand, me.melds, me.lack);
    // 摸了牌之后,提示每张打出去还能不能听
    if (v.actions.includes("discard")) {
      v.discardHints = {};
      for (let t = 0; t < TILE_KINDS; t++) {
        if (!me.hand[t]) continue;
        me.hand[t]--;
        const ting = tingTiles(me.hand, me.melds, me.lack);
        me.hand[t]++;
        if (ting.length) v.discardHints[t] = ting;
      }
    }
    v.mustDiscardLack = hasSuit(me.hand, me.lack);
  }
  return v;
}

/** 观战/结算时才用:把所有人的手牌摊开 */
export function fullView(g) {
  return {
    ...viewFor(g, 0),
    me: -1,
    reveal: g.seats.map((s) => s.hand.slice()),
  };
}
