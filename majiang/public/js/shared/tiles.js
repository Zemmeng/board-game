// 川麻(血战到底)牌理核心 —— 前后端共用,纯函数,不碰随机数也不碰时间。
//
// 牌只有万/条/筒三门、各 1~9、每种 4 张,共 108 张。没有字牌、没有花牌。
// 内部一律用 0~26 的索引表示:0~8 万、9~17 条、18~26 筒。
// 手牌统一用长度 27 的计数数组(counts[i] = 这张牌有几张)来算,比数组好判重也好递归。

export const SUITS = ["万", "条", "筒"];
export const TILE_KINDS = 27;
export const COPIES = 4;

export const suitOf = (t) => (t / 9) | 0;          // 0 万 1 条 2 筒
export const rankOf = (t) => (t % 9) + 1;          // 1~9
export const tileName = (t) => `${rankOf(t)}${SUITS[suitOf(t)]}`;

/** 一副完整的牌:108 张的索引数组(未洗) */
export function fullWall() {
  const w = [];
  for (let t = 0; t < TILE_KINDS; t++) for (let c = 0; c < COPIES; c++) w.push(t);
  return w;
}

export const emptyCounts = () => new Array(TILE_KINDS).fill(0);

export function toCounts(tiles) {
  const c = emptyCounts();
  for (const t of tiles) c[t]++;
  return c;
}

export function countsToTiles(c) {
  const out = [];
  for (let t = 0; t < TILE_KINDS; t++) for (let i = 0; i < c[t]; i++) out.push(t);
  return out;
}

/** 手上有哪几门(用于定缺判断) */
export function suitsPresent(c) {
  const s = [false, false, false];
  for (let t = 0; t < TILE_KINDS; t++) if (c[t]) s[suitOf(t)] = true;
  return s;
}

export const hasSuit = (c, suit) => {
  for (let t = suit * 9; t < suit * 9 + 9; t++) if (c[t]) return true;
  return false;
};

// ---------- 胡牌判定 ----------

/**
 * 能否拆成 n 个面子(刻子或顺子)。counts 会被就地修改后还原。
 * 顺子不能跨门:8万9万1条 不是顺子,所以下标推进时要卡在每门的 9 张之内。
 */
function canFormMelds(c, need) {
  if (need === 0) return c.every((x) => x === 0);

  let t = 0;
  while (t < TILE_KINDS && c[t] === 0) t++;
  if (t === TILE_KINDS) return false;

  // 当作刻子
  if (c[t] >= 3) {
    c[t] -= 3;
    if (canFormMelds(c, need - 1)) { c[t] += 3; return true; }
    c[t] += 3;
  }
  // 当作顺子(t, t+1, t+2 必须同门)
  const r = rankOf(t);
  if (r <= 7 && c[t + 1] > 0 && c[t + 2] > 0) {
    c[t]--; c[t + 1]--; c[t + 2]--;
    const ok = canFormMelds(c, need - 1);
    c[t]++; c[t + 1]++; c[t + 2]++;
    if (ok) return true;
  }
  return false;
}

/** 标准型:melded 是已经碰/杠出去的面子数,手上还需要凑 (4 - melded) 个面子 + 1 将 */
export function isStandardWin(counts, melded = 0) {
  const need = 4 - melded;
  const c = counts.slice();
  for (let t = 0; t < TILE_KINDS; t++) {
    if (c[t] < 2) continue;
    c[t] -= 2;                       // 挑一对当将
    const ok = canFormMelds(c, need);
    c[t] += 2;
    if (ok) return true;
  }
  return false;
}

/** 七对:手上正好 14 张、七个对子。杠过就不能算七对(牌不在手上了) */
export function isSevenPairs(counts) {
  let total = 0, pairs = 0;
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] % 2 !== 0) return false;
    total += counts[t];
    pairs += counts[t] / 2;
  }
  return total === 14 && pairs === 7;
}

/** 龙七对:七对里有几个「四张」(每个四张算一根) */
export function dragonPairs(counts) {
  let n = 0;
  for (let t = 0; t < TILE_KINDS; t++) if (counts[t] === 4) n++;
  return n;
}

/**
 * 能不能胡。melds 是已亮出的面子(碰/杠),lackSuit 是定缺的那门。
 * 川麻硬规矩:手里还留着缺门的牌就绝对不能胡。
 */
export function canWin(counts, melds = [], lackSuit = -1) {
  if (lackSuit >= 0 && hasSuit(counts, lackSuit)) return false;
  const melded = melds.length;
  if (melded === 0 && isSevenPairs(counts)) return true;
  return isStandardWin(counts, melded);
}

/** 听哪些牌:逐张试着摸进来能不能胡 */
export function tingTiles(counts, melds = [], lackSuit = -1) {
  const out = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] >= COPIES) continue;
    if (lackSuit >= 0 && suitOf(t) === lackSuit) continue;
    counts[t]++;
    if (canWin(counts, melds, lackSuit)) out.push(t);
    counts[t]--;
  }
  return out;
}

/** 打哪张之后还能听牌 —— 机器人和「查大叫」都要用 */
export function discardsKeepingTing(counts, melds = [], lackSuit = -1) {
  const out = [];
  for (let t = 0; t < TILE_KINDS; t++) {
    if (!counts[t]) continue;
    counts[t]--;
    const ting = tingTiles(counts, melds, lackSuit);
    counts[t]++;
    if (ting.length) out.push({ discard: t, ting });
  }
  return out;
}

export const isTing = (counts, melds = [], lackSuit = -1) =>
  tingTiles(counts, melds, lackSuit).length > 0;

// ---------- 番种 ----------
// 川麻按「番」翻倍算钱:最终倍数 = 2^番。这里返回番数和中文名,计分在 score.js 里做。

export const MELD_KIND = { PENG: "peng", MING_GANG: "ming", AN_GANG: "an", BU_GANG: "bu" };
const isGang = (m) => m.kind !== MELD_KIND.PENG;

/**
 * 算番。
 * @param counts   手牌(含刚摸/刚点的那张)
 * @param melds    已亮出的面子 [{kind, tile}]
 * @param opt      { zimo自摸, gangKai杠上花, qiangGang抢杠, haidi海底, tianHu天胡, diHu地胡 }
 */
export function fanOf(counts, melds = [], opt = {}) {
  const names = [];
  let fan = 0;

  const all = counts.slice();
  for (const m of melds) all[m.tile] += isGang(m) ? 4 : 3;

  // 清一色:全部来自同一门
  const suits = suitsPresent(all);
  const qing = suits.filter(Boolean).length === 1;

  // 七对只在门清(没碰没杠)时成立
  const qiDui = melds.length === 0 && isSevenPairs(counts);
  const longs = qiDui ? dragonPairs(counts) : 0;

  // 对对胡:把将牌拿掉之后,手上剩的必须全是刻子。
  // **每一个可能的将都要试**,不能只试第一个 —— 比如 222 333 444 555 66,
  // 只试最小的那对(从 2 里拿)会剩下一张 2,直接误判成不是对对胡,将其实是 66。
  // 另外川麻没有吃,亮出去的必然是刻子或杠,所以 melds 不用再检查。
  let duiDui = false;
  if (!qiDui) {
    for (let t = 0; t < TILE_KINDS && !duiDui; t++) {
      if (counts[t] < 2) continue;
      const c = counts.slice();
      c[t] -= 2;
      duiDui = c.every((x) => x === 0 || x === 3);
    }
  }

  // 牌型主番(取最大的那一档,不叠加)
  if (qiDui) {
    if (qing && longs > 0) { fan += 5; names.push("清龙七对"); }
    else if (qing) { fan += 4; names.push("清七对"); }
    else if (longs > 0) { fan += 3; names.push("龙七对"); }
    else { fan += 2; names.push("七对"); }
    if (longs > 1) { fan += longs - 1; names.push(`双龙×${longs}`); }
  } else if (qing && duiDui) {
    fan += 3; names.push("清对");
  } else if (qing) {
    fan += 2; names.push("清一色");
  } else if (duiDui) {
    fan += 1; names.push("对对胡");
  } else {
    names.push("平胡");
  }

  // 金钩钓:手上只剩胡的那一张,其余全碰杠出去了
  const inHand = counts.reduce((a, b) => a + b, 0);
  if (!qiDui && inHand === 1 && melds.length === 4) { fan += 1; names.push("金钩钓"); }

  // 根:任意四张相同(含杠)。七对里的四张已经按龙算过,不再重复计根
  if (!qiDui) {
    let gen = 0;
    for (let t = 0; t < TILE_KINDS; t++) if (all[t] === 4) gen++;
    if (gen) { fan += gen; names.push(`${gen} 根`); }
  }

  if (opt.zimo)      { fan += 1; names.push("自摸"); }
  if (opt.gangKai)   { fan += 1; names.push("杠上花"); }
  if (opt.qiangGang) { fan += 1; names.push("抢杠胡"); }
  if (opt.haidi)     { fan += 1; names.push("海底捞月"); }
  if (opt.tianHu)    { fan += 3; names.push("天胡"); }
  if (opt.diHu)      { fan += 2; names.push("地胡"); }

  return { fan, names };
}

/** 封顶后的倍数 */
export const multiplierOf = (fan, cap = 5) => 2 ** Math.min(fan, cap);
