// 川麻(血战到底)牌局状态机 —— 前后端共用,确定性:随机全走 g.seed。
//
// 一局的流程:发牌 → 定缺 → 换三张 → 摸打(碰/杠/胡)→ 血战到底 → 流局查叫。
// 「血战到底」的意思是:有人胡牌后**牌局不停**,胡了的人退出摸打,剩下的接着打,
// 直到只剩一家没胡、或者牌摸完为止。所以「胡牌」不等于「结束」,这是跟别的麻将最不一样的地方。

import {
  TILE_KINDS, COPIES, fullWall, toCounts, countsToTiles, tileName, suitOf, SUITS,
  canWin, isTing, tingTiles, hasSuit, fanOf, multiplierOf, MELD_KIND,
} from "./tiles.js";

export const SEATS = 4;
export const BASE = 1;          // 底分
export const FAN_CAP = 5;       // 封顶 2^5 = 32 倍

// 杠的分数:直杠(别人打的)放杠者一人付,暗杠/补杠其他每家付
export const GANG_PAY = { ming: 3, an: 2, bu: 1 };

export function rngNext(s) {
  s.r = (s.r + 0x6D2B79F5) >>> 0;
  let t = s.r;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createGame(seed = 1, dealer = 0) {
  const g = {
    seed: { r: seed >>> 0 },
    phase: "lack",
    wall: [], wallAt: 0,
    seats: [],
    turn: dealer,
    dealer,
    pending: null,          // {tile, from, waits:[seat...], acted:[]}
    lastDrawn: -1,          // 刚摸进来的那张(判杠上花/自摸用)
    swapDir: 0,
    log: [],
    result: null,
  };

  const wall = fullWall();
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(g.seed) * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  g.wall = wall;

  for (let s = 0; s < SEATS; s++) {
    const hand = new Array(TILE_KINDS).fill(0);
    for (let k = 0; k < 13; k++) hand[g.wall[g.wallAt++]]++;
    g.seats.push({
      hand, melds: [], discards: [],
      lack: -1, swap: null,
      won: false, winFan: null,
      score: 0,
      passedHu: false,      // 过水:放弃过这张就不能再胡同一张(简化版)
    });
  }
  // 换三张的方向:0 顺时针 1 逆时针 2 对家
  g.swapDir = Math.floor(rngNext(g.seed) * 3);
  return g;
}

const note = (g, t) => { g.log.push(t); if (g.log.length > 300) g.log.splice(0, g.log.length - 300); };
const alive = (g) => g.seats.filter((s) => !s.won).length;
export const handSize = (s) => s.hand.reduce((a, b) => a + b, 0);
export const wallLeft = (g) => g.wall.length - g.wallAt;

// ---------- 定缺 ----------

export function setLack(g, seat, suit) {
  if (g.phase !== "lack") throw new Error("现在不是定缺阶段");
  if (suit < 0 || suit > 2) throw new Error("花色不对");
  g.seats[seat].lack = suit;
  if (g.seats.every((s) => s.lack >= 0)) {
    g.phase = "swap";
    note(g, "定缺完毕,开始换三张");
  }
}

/** 手上哪几门够三张,能拿来换 */
export function swappableSuits(s) {
  const out = [];
  for (let q = 0; q < 3; q++) {
    let n = 0;
    for (let t = q * 9; t < q * 9 + 9; t++) n += s.hand[t];
    if (n >= 3) out.push(q);
  }
  return out;
}

// ---------- 换三张 ----------

export function setSwap(g, seat, tiles) {
  if (g.phase !== "swap") throw new Error("现在不是换牌阶段");
  if (tiles.length !== 3) throw new Error("必须换三张");
  const q = suitOf(tiles[0]);
  if (!tiles.every((t) => suitOf(t) === q)) throw new Error("三张必须同花色");
  const c = g.seats[seat].hand.slice();
  for (const t of tiles) {
    if (--c[t] < 0) throw new Error("手上没有这张牌");
  }
  g.seats[seat].swap = tiles.slice();

  if (g.seats.every((s) => s.swap)) doSwap(g);
}

function doSwap(g) {
  const give = g.seats.map((s) => s.swap);
  for (let s = 0; s < SEATS; s++) for (const t of give[s]) g.seats[s].hand[t]--;
  const target = (s) => g.swapDir === 0 ? (s + 1) % 4 : g.swapDir === 1 ? (s + 3) % 4 : (s + 2) % 4;
  for (let s = 0; s < SEATS; s++) for (const t of give[s]) g.seats[target(s)].hand[t]++;
  for (const s of g.seats) s.swap = null;

  const dirName = ["顺时针", "逆时针", "对家"][g.swapDir];
  note(g, `换三张(${dirName})完成`);
  g.phase = "play";
  draw(g, g.turn);
}

// ---------- 摸打 ----------

function draw(g, seat) {
  if (wallLeft(g) <= 0) { settleDraw(g); return; }
  const t = g.wall[g.wallAt++];
  g.seats[seat].hand[t]++;
  g.lastDrawn = t;
  g.turn = seat;
  g.pending = null;
  // 摸到牌之后先看能不能自摸/杠,交给 legalActions 报给上层
}

/** 把一张牌从某人的弃牌堆里取走(被碰/杠吃掉时用) */
function takeFromDiscards(g, seat, tile) {
  const d = g.seats[seat].discards;
  const i = d.lastIndexOf(tile);
  if (i >= 0) d.splice(i, 1);
}

/** 轮到下一个还没胡的人 */
function nextSeat(g, from) {
  for (let k = 1; k <= SEATS; k++) {
    const s = (from + k) % SEATS;
    if (!g.seats[s].won) return s;
  }
  return -1;
}

export function discard(g, seat, tile) {
  const s = g.seats[seat];
  if (g.phase !== "play") throw new Error("牌局不在进行中");
  if (g.turn !== seat || g.pending) throw new Error("还没轮到你打牌");
  if (s.won) throw new Error("你已经胡了,不用再打");
  if (!s.hand[tile]) throw new Error("你没有这张牌");
  // 定缺没打完之前,只能打缺门的牌
  if (hasSuit(s.hand, s.lack) && suitOf(tile) !== s.lack) {
    throw new Error(`还有${SUITS[s.lack]}没打完,必须先打${SUITS[s.lack]}`);
  }

  s.hand[tile]--;
  s.discards.push(tile);
  g.lastDrawn = -1;
  g.gangFlower = false;      // 正常打过一张之后就不再算杠上花了
  note(g, `${seat} 打 ${tileName(tile)}`);

  // 谁能要这张牌
  const waits = [];
  for (let i = 0; i < SEATS; i++) {
    if (i === seat || g.seats[i].won) continue;
    if (claimsOf(g, i, tile).length) waits.push(i);
  }
  if (waits.length) {
    g.pending = { tile, from: seat, waits, acted: {} };
  } else {
    const nxt = nextSeat(g, seat);
    if (nxt < 0) settleDraw(g); else draw(g, nxt);
  }
}

/** seat 对 tile 能做什么(不含过) */
function claimsOf(g, seat, tile) {
  const s = g.seats[seat];
  const out = [];
  const c = s.hand;
  // 胡:定缺没打完不能胡,过水也不能再胡这张
  c[tile]++;
  const canH = canWin(c, s.melds, s.lack) && !s.passedHu;
  c[tile]--;
  if (canH) out.push("hu");
  // 碰/杠:缺门的牌不许碰杠(碰了就永远打不完缺)
  if (suitOf(tile) !== s.lack) {
    if (c[tile] >= 2) out.push("peng");
    if (c[tile] >= 3) out.push("gang");
  }
  return out;
}

export function legalActions(g, seat) {
  if (g.phase !== "play") return [];
  const s = g.seats[seat];
  if (s.won) return [];

  if (g.pending) {
    if (!g.pending.waits.includes(seat) || g.pending.acted[seat]) return [];
    return [...claimsOf(g, seat, g.pending.tile), "pass"];
  }
  if (g.turn !== seat) return [];

  const out = [];
  // 自摸
  if (canWin(s.hand, s.melds, s.lack)) out.push("zimo");
  // 暗杠 / 补杠
  for (let t = 0; t < TILE_KINDS; t++) {
    if (suitOf(t) === s.lack) continue;
    if (s.hand[t] === 4) out.push("angang:" + t);
    else if (s.hand[t] === 1 && s.melds.some((m) => m.kind === MELD_KIND.PENG && m.tile === t)) {
      out.push("bugang:" + t);
    }
  }
  out.push("discard");
  return out;
}

/** 对 pending 的响应。胡 > 杠 > 碰,同级按逆时针近的优先;一炮多响都算。 */
export function respond(g, seat, act, opt = {}) {
  if (!g.pending) throw new Error("现在没有牌等着要");
  const p = g.pending;
  if (!p.waits.includes(seat)) throw new Error("这张牌轮不到你要");
  if (p.acted[seat]) throw new Error("你已经表过态了");
  const legal = claimsOf(g, seat, p.tile);
  if (act !== "pass" && !legal.includes(act)) throw new Error("这个动作不合法");
  p.acted[seat] = act;

  // 等所有人表完态再一起裁决
  if (p.waits.some((i) => !p.acted[i])) return;
  resolvePending(g);
}

function resolvePending(g) {
  const p = g.pending;
  const huers = p.waits.filter((i) => p.acted[i] === "hu");

  if (huers.length) {
    // 一炮多响:每个胡的都算,放炮的对每家都赔
    for (const i of huers) doWin(g, i, p.tile, { from: p.from });
    g.pending = null;
    if (alive(g) <= 1) { settleEnd(g); return; }
    const nxt = nextSeat(g, p.from);
    if (nxt < 0) settleEnd(g); else draw(g, nxt);
    return;
  }

  const ganger = p.waits.find((i) => p.acted[i] === "gang");
  const penger = p.waits.find((i) => p.acted[i] === "peng");
  const who = ganger ?? penger;

  if (who === undefined) {
    // 都过了。放弃胡的这几家记「过水」,本轮不能再胡同一张
    for (const i of p.waits) if (claimsOf(g, i, p.tile).includes("hu")) g.seats[i].passedHu = true;
    g.pending = null;
    const nxt = nextSeat(g, p.from);
    if (nxt < 0) settleDraw(g); else draw(g, nxt);
    return;
  }

  const s = g.seats[who];
  const tile = p.tile;
  const kind = who === ganger ? MELD_KIND.MING_GANG : MELD_KIND.PENG;
  s.hand[tile] -= kind === MELD_KIND.MING_GANG ? 3 : 2;
  // 被碰/杠走的那张要从打牌人的弃牌堆里拿掉:它已经并进面子里了,
  // 留着的话这张牌在手牌和弃牌堆里各算一次。
  takeFromDiscards(g, p.from, tile);
  s.melds.push({ kind, tile, from: p.from });
  note(g, `${who} ${kind === MELD_KIND.PENG ? "碰" : "杠"} ${tileName(tile)}`);
  g.pending = null;
  g.turn = who;

  if (kind === MELD_KIND.MING_GANG) {
    payGang(g, who, "ming", p.from);
    drawAfterGang(g, who);
  }
  // 碰完由碰家出牌,不摸;上层看 legalActions 会得到 discard
}

export function angang(g, seat, tile) {
  const s = g.seats[seat];
  if (g.turn !== seat || g.pending) throw new Error("还没轮到你");
  if (s.hand[tile] !== 4) throw new Error("凑不齐四张");
  s.hand[tile] -= 4;
  s.melds.push({ kind: MELD_KIND.AN_GANG, tile });
  note(g, `${seat} 暗杠`);
  payGang(g, seat, "an");
  drawAfterGang(g, seat);
}

export function bugang(g, seat, tile) {
  const s = g.seats[seat];
  if (g.turn !== seat || g.pending) throw new Error("还没轮到你");
  const m = s.melds.find((x) => x.kind === MELD_KIND.PENG && x.tile === tile);
  if (!m || s.hand[tile] !== 1) throw new Error("不能补杠这张");

  // 抢杠:别人正好胡这张,可以截胡
  const robbers = [];
  for (let i = 0; i < SEATS; i++) {
    if (i === seat || g.seats[i].won) continue;
    const c = g.seats[i].hand;
    c[tile]++;
    const ok = canWin(c, g.seats[i].melds, g.seats[i].lack);
    c[tile]--;
    if (ok) robbers.push(i);
  }
  if (robbers.length) {
    note(g, `${seat} 补杠被抢`);
    for (const i of robbers) doWin(g, i, tile, { from: seat, qiangGang: true });
    // 这张被抢走了,杠不成。牌从补杠者手里离开,得有个去处,
    // 否则牌数会凭空少一张 —— 记到他自己的弃牌堆里最合适。
    s.hand[tile]--;
    s.discards.push(tile);
    if (alive(g) <= 1) { settleEnd(g); return; }
    const nxt = nextSeat(g, seat);
    if (nxt < 0) settleEnd(g); else draw(g, nxt);
    return;
  }

  s.hand[tile]--;
  m.kind = MELD_KIND.BU_GANG;
  note(g, `${seat} 补杠`);
  payGang(g, seat, "bu");
  drawAfterGang(g, seat);
}

function drawAfterGang(g, seat) {
  if (wallLeft(g) <= 0) { settleDraw(g); return; }
  const t = g.wall[g.wallAt++];
  g.seats[seat].hand[t]++;
  g.lastDrawn = t;
  g.turn = seat;
  g.gangFlower = true;      // 下一次胡算杠上花
}

function payGang(g, seat, kind, from = -1) {
  const amount = GANG_PAY[kind];
  if (kind === "ming") {
    if (from >= 0 && !g.seats[from].won) {
      g.seats[from].score -= amount;
      g.seats[seat].score += amount;
    }
    return;
  }
  for (let i = 0; i < SEATS; i++) {
    if (i === seat || g.seats[i].won) continue;   // 已胡的不再参与结算
    g.seats[i].score -= amount;
    g.seats[seat].score += amount;
  }
}

export function zimo(g, seat) {
  const s = g.seats[seat];
  if (g.turn !== seat || g.pending) throw new Error("还没轮到你");
  if (!canWin(s.hand, s.melds, s.lack)) throw new Error("这手胡不了");
  doWin(g, seat, g.lastDrawn, { zimo: true });
  if (alive(g) <= 1) { settleEnd(g); return; }
  const nxt = nextSeat(g, seat);
  if (nxt < 0) settleEnd(g); else draw(g, nxt);
}

function doWin(g, seat, tile, opt) {
  const s = g.seats[seat];
  // ⚠️ 算番一律用**手牌副本**,绝不把胡的那张真塞进 s.hand。
  // 点炮的那张还躺在打牌人的弃牌堆里,塞进来同一张牌就被数了两遍;
  // 一炮多响时更是每个赢家各数一遍,牌数直接崩。
  const c = s.hand.slice();
  if (!opt.zimo) c[tile]++;
  const flags = {
    zimo: !!opt.zimo,
    qiangGang: !!opt.qiangGang,
    gangKai: !!g.gangFlower && !!opt.zimo,
    haidi: wallLeft(g) === 0,
  };
  const f = fanOf(c, s.melds, flags);
  const mult = multiplierOf(f.fan, FAN_CAP);
  const amount = BASE * mult;

  if (opt.zimo) {
    for (let i = 0; i < SEATS; i++) {
      if (i === seat || g.seats[i].won) continue;
      g.seats[i].score -= amount;
      s.score += amount;
    }
  } else {
    g.seats[opt.from].score -= amount;
    s.score += amount;
  }

  s.won = true;
  s.winFan = { ...f, mult, zimo: !!opt.zimo, tile };
  g.gangFlower = false;
  note(g, `${seat} ${opt.zimo ? "自摸" : "胡"} ${tileName(tile)} —— ${f.names.join("+")} ×${mult}`);
}

// ---------- 收场 ----------

/** 牌摸完了:查花猪、查大叫 */
function settleDraw(g) {
  const notWon = [];
  for (let i = 0; i < SEATS; i++) if (!g.seats[i].won) notWon.push(i);

  const info = notWon.map((i) => {
    const s = g.seats[i];
    const pig = hasSuit(s.hand, s.lack);                     // 花猪:还留着缺门牌
    const ting = !pig && isTing(s.hand, s.melds, s.lack);
    let best = 0;
    if (ting) {
      for (const t of tingTiles(s.hand, s.melds, s.lack)) {
        s.hand[t]++;
        best = Math.max(best, multiplierOf(fanOf(s.hand, s.melds, {}).fan, FAN_CAP));
        s.hand[t]--;
      }
    }
    return { seat: i, pig, ting, best };
  });

  // 查花猪:花猪赔给每个不是花猪的人,固定按封顶算
  const cap = 2 ** FAN_CAP;
  for (const a of info) {
    if (!a.pig) continue;
    for (const b of info) {
      if (b.seat === a.seat || b.pig) continue;
      g.seats[a.seat].score -= cap;
      g.seats[b.seat].score += cap;
    }
    note(g, `${a.seat} 花猪,赔`);
  }
  // 查大叫:没听牌的赔给听牌的,按听牌者能胡的最大倍数
  for (const a of info) {
    if (a.pig || a.ting) continue;
    for (const b of info) {
      if (b.seat === a.seat || !b.ting) continue;
      g.seats[a.seat].score -= b.best;
      g.seats[b.seat].score += b.best;
    }
  }
  settleEnd(g, "流局");
}

function settleEnd(g, how = "打完") {
  if (g.phase === "over") return;
  g.phase = "over";
  g.pending = null;
  g.result = {
    how,
    scores: g.seats.map((s) => s.score),
    wins: g.seats.map((s) => s.winFan),
  };
  note(g, `${how},本局结束`);
}

export { settleDraw as _settleDraw };
