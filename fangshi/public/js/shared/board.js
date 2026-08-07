// 「长安坊市」棋盘与规则常量 —— 服务端(Durable Object)与前端共用,零构建 ES 模块。
//
// 版权红线:只借用「买地—收租—盖房—垄断」这套玩法机制。棋盘上所有名字都取自
// 真实的唐长安里坊与城门(历史地名),卡牌文案原创,不含任何现成商业桌游的
// 名称、地块名、角色形象或规则书原文。租金表按自己的公式推,不照抄任何现成数值。

export const CURRENCY = "贯";
export const START_CASH = 1500;   // 起始资金
export const PASS_GO = 200;       // 过明德门(起点)所得
export const BAIL = 50;           // 保释金
export const MAX_JAIL_TURNS = 3;  // 蹲满三回合必须付钱出狱
export const HOUSE_STOCK = 32;    // 全局店铺存量(短缺规则)
export const HOTEL_STOCK = 12;    // 全局商号存量
export const MORTGAGE_INTEREST = 0.1; // 赎回加收一成

// 色组:id -> 名称与显示色。垄断整组后空地租金翻倍,且可开始盖店。
export const GROUPS = {
  n1: { name: "城南", hex: "#8a6a4f", houseCost: 50 },
  n2: { name: "西南隅", hex: "#7fb6d9", houseCost: 50 },
  n3: { name: "西市外", hex: "#d98fb0", houseCost: 100 },
  n4: { name: "城西", hex: "#e0913f", houseCost: 100 },
  n5: { name: "城中", hex: "#c8503f", houseCost: 150 },
  n6: { name: "城东", hex: "#dfc04a", houseCost: 150 },
  n7: { name: "东北隅", hex: "#4f9e63", houseCost: 200 },
  n8: { name: "两市", hex: "#3f5fa8", houseCost: 200 },
};

// 地格类型:
//   ward 坊(可买可盖) / gate 城门(按持有数收通行税) / canal 渠(按骰点收水利钱)
//   go 起点 / jail 大牢(探监) / free 曲江池 / togo 差役拿人 / tax 税 /
//   edict 诏令 / rumor 市井传闻
//
// ward 的 rent 依次是:空地、一店、二店、三店、四店、商号
export const BOARD = [
  { t: "go", name: "明德门", sub: "起点 · 过此领 200 贯" },
  { t: "ward", name: "敦化坊", g: "n1", price: 60, rent: [2, 10, 30, 90, 160, 250] },
  { t: "rumor", name: "市井传闻" },
  { t: "ward", name: "通济坊", g: "n1", price: 60, rent: [4, 20, 60, 180, 320, 450] },
  { t: "tax", name: "市税", amount: 200 },
  { t: "gate", name: "春明门", price: 200 },
  { t: "ward", name: "宣义坊", g: "n2", price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { t: "edict", name: "诏令" },
  { t: "ward", name: "永和坊", g: "n2", price: 100, rent: [6, 30, 90, 270, 400, 550] },
  { t: "ward", name: "永平坊", g: "n2", price: 120, rent: [8, 40, 100, 300, 450, 600] },
  { t: "jail", name: "京兆府大牢", sub: "探监" },
  { t: "ward", name: "丰邑坊", g: "n3", price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { t: "canal", name: "龙首渠", price: 150 },
  { t: "ward", name: "待贤坊", g: "n3", price: 140, rent: [10, 50, 150, 450, 625, 750] },
  { t: "ward", name: "修真坊", g: "n3", price: 160, rent: [12, 60, 180, 500, 700, 900] },
  { t: "gate", name: "金光门", price: 200 },
  { t: "ward", name: "长寿坊", g: "n4", price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { t: "rumor", name: "市井传闻" },
  { t: "ward", name: "群贤坊", g: "n4", price: 180, rent: [14, 70, 200, 550, 750, 950] },
  { t: "ward", name: "怀远坊", g: "n4", price: 200, rent: [16, 80, 220, 600, 800, 1000] },
  { t: "free", name: "曲江池", sub: "游园 · 无事" },
  { t: "ward", name: "光德坊", g: "n5", price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { t: "edict", name: "诏令" },
  { t: "ward", name: "延康坊", g: "n5", price: 220, rent: [18, 90, 250, 700, 875, 1050] },
  { t: "ward", name: "兴化坊", g: "n5", price: 240, rent: [20, 100, 300, 750, 925, 1100] },
  { t: "gate", name: "延平门", price: 200 },
  { t: "ward", name: "太平坊", g: "n6", price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { t: "ward", name: "光福坊", g: "n6", price: 260, rent: [22, 110, 330, 800, 975, 1150] },
  { t: "canal", name: "清明渠", price: 150 },
  { t: "ward", name: "通义坊", g: "n6", price: 280, rent: [24, 120, 360, 850, 1025, 1200] },
  { t: "togo", name: "差役拿人", sub: "押入大牢" },
  { t: "ward", name: "崇仁坊", g: "n7", price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { t: "ward", name: "平康坊", g: "n7", price: 300, rent: [26, 130, 390, 900, 1100, 1275] },
  { t: "rumor", name: "市井传闻" },
  { t: "ward", name: "亲仁坊", g: "n7", price: 320, rent: [28, 150, 450, 1000, 1200, 1400] },
  { t: "gate", name: "通化门", price: 200 },
  { t: "edict", name: "诏令" },
  { t: "ward", name: "西市", g: "n8", price: 350, rent: [35, 175, 500, 1100, 1300, 1500] },
  { t: "tax", name: "关税", amount: 100 },
  { t: "ward", name: "东市", g: "n8", price: 400, rent: [50, 200, 600, 1400, 1700, 2000] },
];

export const GO = 0, JAIL = 10, TO_GO = 30;

// 城门:按同一人持有的城门数收通行税
export const GATE_RENT = [0, 25, 50, 100, 200];
// 渠:按骰点倍数收水利钱(持有一条 ×4,两条都持有 ×10)
export const CANAL_MULT = [0, 4, 10];

export const BUILD_NAMES = ["空地", "一店", "二店", "三店", "四店", "商号"];

// 抵押价一律是地价的一半
export const mortgageValue = (i) => Math.floor(BOARD[i].price / 2);
export const redeemCost = (i) => Math.ceil(mortgageValue(i) * (1 + MORTGAGE_INTEREST));

// 同色组的全部格号
export const groupTiles = (g) =>
  BOARD.map((c, i) => (c.t === "ward" && c.g === g ? i : -1)).filter((i) => i >= 0);

export const PLAYER_COLORS = ["#c8503f", "#dfc04a", "#4f9e63", "#3f5fa8", "#8a6a4f", "#7fb6d9"];
export const PLAYER_TOKENS = ["驼", "笔", "壶", "琴", "剑", "印"]; // 棋子:丝路驼、笔、酒壶、琴、剑、私印

// ---------- 卡牌 ----------
// act 语义:
//   move 走到指定格(过起点照领) / moveBack 后退 N 格 / goJail 直接入狱
//   nearestGate / nearestCanal 走到最近的城门或渠(有主则加倍付)
//   cash 收支 / each 与每位对手结算(正数=每人给你) / repair 按店与商号数缴修缮费
//   pardon 免罪金牌(免狱牌)
export const EDICTS = [
  { text: "圣人巡幸,速往明德门迎驾。", act: "move", to: 0 },
  { text: "敕封东市监,即刻赴任。", act: "move", to: 39 },
  { text: "京兆尹传唤,速往崇仁坊。", act: "move", to: 31 },
  { text: "驿马急递,往最近的城门;若无主可购,有主则付双倍通行税。", act: "nearestGate" },
  { text: "关牒查验,往最近的城门;若无主可购,有主则付双倍通行税。", act: "nearestGate" },
  { text: "疏浚水道,往最近的渠;若无主,可购;有主则掷骰付十倍水利钱。", act: "nearestCanal" },
  { text: "岁末分红,得 50 贯。", act: "cash", amount: 50 },
  { text: "赐免罪金牌一面,可抵一次牢狱。", act: "pardon" },
  { text: "路遇塌方,后退三格。", act: "moveBack", n: 3 },
  { text: "违禁夜行,即刻押入京兆府大牢,不得过起点。", act: "goJail" },
  { text: "坊墙修缮:每店 25 贯,每商号 100 贯。", act: "repair", house: 25, hotel: 100 },
  { text: "逾制营造,罚 15 贯。", act: "cash", amount: -15 },
  { text: "返乡祭祖,移至敦化坊。", act: "move", to: 1 },
  { text: "你被推举为坊正,须向每位坊邻各付 50 贯。", act: "each", amount: -50 },
  { text: "盐引获利,得 150 贯。", act: "cash", amount: 150 },
  { text: "行商得利,得 100 贯。", act: "cash", amount: 100 },
];

export const RUMORS = [
  { text: "听闻圣驾将临,速往明德门。", act: "move", to: 0 },
  { text: "银铺入账,得 200 贯。", act: "cash", amount: 200 },
  { text: "延医问诊,付 50 贯。", act: "cash", amount: -50 },
  { text: "典当获利,得 50 贯。", act: "cash", amount: 50 },
  { text: "旧交相助,得免罪金牌一面。", act: "pardon" },
  { text: "为人作保受累,押入京兆府大牢,不得过起点。", act: "goJail" },
  { text: "坊会分润,每位坊邻各付你 50 贯。", act: "each", amount: 50 },
  { text: "变卖旧物,得 50 贯。", act: "cash", amount: 50 },
  { text: "抓药煎汤,付 100 贯。", act: "cash", amount: -100 },
  { text: "岁贡摊派,付 150 贯。", act: "cash", amount: -150 },
  { text: "船货抵港,得 25 贯。", act: "cash", amount: 25 },
  { text: "街衢整修:每店 40 贯,每商号 115 贯。", act: "repair", house: 40, hotel: 115 },
  { text: "曲江诗会夺魁,赏 10 贯。", act: "cash", amount: 10 },
  { text: "承继祖产,得 100 贯。", act: "cash", amount: 100 },
  { text: "年节赏钱,得 100 贯。", act: "cash", amount: 100 },
  { text: "租课返还,得 20 贯。", act: "cash", amount: 20 },
];

export function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 纯函数规则查询(服务端与前端共用,保证两边算出的租金一致) ----------

/** 某格当前归谁(未售出返回 -1) */
export const ownerOf = (g, i) => g.tiles[i]?.owner ?? -1;

/** 某人是否垄断了整个色组(且组内无抵押) */
export function hasMonopoly(g, seat, group) {
  const ts = groupTiles(group);
  return ts.every((i) => g.tiles[i].owner === seat) && ts.every((i) => !g.tiles[i].mortgaged);
}

/** 停在第 i 格该付多少租(dice 用于渠) */
export function rentOf(g, i, dice) {
  const cell = BOARD[i];
  const t = g.tiles[i];
  if (!t || t.owner < 0 || t.mortgaged) return 0;

  if (cell.t === "gate") {
    const n = BOARD.reduce((acc, c, j) => acc + (c.t === "gate" && g.tiles[j].owner === t.owner ? 1 : 0), 0);
    return GATE_RENT[n];
  }
  if (cell.t === "canal") {
    const n = BOARD.reduce((acc, c, j) => acc + (c.t === "canal" && g.tiles[j].owner === t.owner ? 1 : 0), 0);
    return CANAL_MULT[n] * dice;
  }
  // 坊:盖了店按等级收;空地且垄断整组则翻倍
  if (t.level > 0) return cell.rent[t.level];
  return cell.rent[0] * (hasMonopoly(g, t.owner, cell.g) ? 2 : 1);
}

/** 净资产:现金 + 未抵押地价 + 已抵押地价的一半 + 建筑造价 */
export function netWorth(g, seat) {
  let n = g.seats[seat].cash;
  for (let i = 0; i < BOARD.length; i++) {
    const t = g.tiles[i];
    if (!t || t.owner !== seat) continue;
    n += t.mortgaged ? mortgageValue(i) : BOARD[i].price;
    if (t.level > 0) n += t.level * GROUPS[BOARD[i].g].houseCost;
  }
  return n;
}

/** 变卖建筑 + 抵押全部地产后最多还能凑出多少钱(判定是否真的破产) */
export function maxRaisable(g, seat) {
  let n = g.seats[seat].cash;
  for (let i = 0; i < BOARD.length; i++) {
    const t = g.tiles[i];
    if (!t || t.owner !== seat) continue;
    if (t.level > 0) n += Math.floor(t.level * GROUPS[BOARD[i].g].houseCost / 2);
    if (!t.mortgaged) n += mortgageValue(i);
  }
  return n;
}
