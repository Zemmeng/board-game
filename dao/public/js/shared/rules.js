// 仄梦的岛屿开拓——前后端共用模块:六边形几何、棋盘生成、规则判定
// 浏览器直接以 ES module 加载;Worker 侧由 wrangler 打包时经相对路径引入
//
// 坐标体系:轴坐标 (q, r),尖顶六边形,棋盘为半径 2 的大六边形(19 格)。
// 顶点 id = 围着它的三个格子坐标排序后拼接;棱 id = 两侧两个格子坐标排序后拼接。
// 棋盘外的虚拟格子也参与编号,保证海岸线上的顶点/棱有唯一 id。

export const RES = {
  wood:  { name: "灵木", tile: "灵木林", color: "#2e7d46" },
  brick: { name: "陶土", tile: "陶土丘", color: "#c05a35" },
  wheat: { name: "稻穗", tile: "稻田",   color: "#d9a521" },
  wool:  { name: "云绢", tile: "云绢泽", color: "#8cc06a" },
  ore:   { name: "辉石", tile: "辉石岩", color: "#6b7d8f" },
};
export const RES_KEYS = Object.keys(RES);
export const DESERT_COLOR = "#d8c48a";

export const COSTS = {
  road:    { wood: 1, brick: 1 },
  village: { wood: 1, brick: 1, wheat: 1, wool: 1 },
  city:    { wheat: 2, ore: 3 },
  dev:     { wool: 1, wheat: 1, ore: 1 },
};
export const BUILD_NAMES = { road: "道路", village: "村庄", city: "城邑" };

export const PIECE_LIMIT = { road: 15, village: 5, city: 4 };
export const BANK_PER_RES = 19;
export const PLAYER_COLORS = ["#d94a4a", "#3d7edb", "#e8912d", "#f0ead8"];
export const COLOR_NAMES = ["红", "蓝", "橙", "白"];

export const DEV_INFO = {
  knight:   { name: "骑士",   desc: "移动强盗到新地格并偷 1 张牌,计入最大军团" },
  vp:       { name: "胜利点", desc: "保密的 1 分,达到目标分时自动亮出" },
  monopoly: { name: "垄断",   desc: "指定一种资源,所有对手的这种资源全部交给你" },
  roads:    { name: "筑路",   desc: "免费建 2 条道路" },
  invent:   { name: "丰收",   desc: "从银行任取 2 张资源" },
};
export const DEV_DECK_SPEC = { knight: 14, vp: 5, monopoly: 2, roads: 2, invent: 2 };

// ---------- 几何 ----------

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const K = (q, r) => q + "," + r;
const parseK = (k) => k.split(",").map(Number);

export const TILE_KEYS = [];
for (let q = -2; q <= 2; q++) {
  for (let r = -2; r <= 2; r++) {
    if (Math.abs(q + r) <= 2) TILE_KEYS.push(K(q, r));
  }
}
const TILE_SET = new Set(TILE_KEYS);

// 单位尺寸下的格心坐标(渲染端自行乘以格子大小)
export function hexCenter(k) {
  const [q, r] = parseK(k);
  return { x: Math.sqrt(3) * (q + r / 2), y: 1.5 * r };
}

export const VERTICES = new Map();     // vid -> { hexes:[k×3], tiles:[棋盘内的 k], x, y }
export const EDGES = new Map();        // eid -> { v:[vid,vid], x, y }
export const VERTEX_EDGES = new Map(); // vid -> [eid]
export const VERTEX_ADJ = new Map();   // vid -> [相邻 vid]
export const TILE_VERTICES = new Map(); // k -> [vid×6](按角序)

for (const k of TILE_KEYS) {
  const [q, r] = parseK(k);
  const neighborK = (i) => K(q + DIRS[i][0], r + DIRS[i][1]);
  // 六个角:第 i 个角由本格与第 i、i+1 方向的邻格围成
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const trio = [k, neighborK(i), neighborK((i + 1) % 6)].sort();
    const vid = trio.join("|");
    corners.push(vid);
    if (!VERTICES.has(vid)) {
      const cs = trio.map(hexCenter);
      VERTICES.set(vid, {
        hexes: trio,
        tiles: trio.filter((h) => TILE_SET.has(h)),
        x: (cs[0].x + cs[1].x + cs[2].x) / 3,
        y: (cs[0].y + cs[1].y + cs[2].y) / 3,
      });
      VERTEX_EDGES.set(vid, []);
      VERTEX_ADJ.set(vid, []);
    }
  }
  TILE_VERTICES.set(k, corners);
  // 六条棱:与第 i 方向邻格共享,两端是第 i-1、i 号角
  for (let i = 0; i < 6; i++) {
    const eid = [k, neighborK(i)].sort().join("|");
    if (EDGES.has(eid)) continue;
    const va = corners[(i + 5) % 6];
    const vb = corners[i];
    const A = VERTICES.get(va), B = VERTICES.get(vb);
    EDGES.set(eid, { v: [va, vb], x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 });
    VERTEX_EDGES.get(va).push(eid);
    VERTEX_EDGES.get(vb).push(eid);
    VERTEX_ADJ.get(va).push(vb);
    VERTEX_ADJ.get(vb).push(va);
  }
}

export function tilesOfVertex(vid) {
  return VERTICES.get(vid).tiles;
}

// ---------- 棋盘生成(官方变体开局) ----------

export function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 数字签固定序列(按字母序沿螺旋放置时 6/8 天然不相邻)
const DISC_SEQ = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
const TERRAIN_POOL = [
  "wood", "wood", "wood", "wood",
  "wheat", "wheat", "wheat", "wheat",
  "wool", "wool", "wool", "wool",
  "brick", "brick", "brick",
  "ore", "ore", "ore",
  "desert",
];

// 半径 R 的环,按固定旋转方向走一圈
function ring(R) {
  if (R === 0) return [K(0, 0)];
  const out = [];
  let q = DIRS[4][0] * R, r = DIRS[4][1] * R;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < R; step++) {
      out.push(K(q, r));
      q += DIRS[side][0];
      r += DIRS[side][1];
    }
  }
  return out;
}

function rotate(arr, n) {
  return arr.slice(n).concat(arr.slice(0, n));
}

export function generateBoard(rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const kinds = shuffle(TERRAIN_POOL, rand);
    const corner = Math.floor(rand() * 6);
    const reversed = rand() < 0.5;
    let outer = rotate(ring(2), corner * 2);
    let inner = rotate(ring(1), corner);
    if (reversed) { outer = outer.slice().reverse(); inner = inner.slice().reverse(); }
    const spiral = [...outer, ...inner, K(0, 0)];

    const kindOf = {};
    TILE_KEYS.forEach((k, i) => { kindOf[k] = kinds[i]; });

    const numOf = {};
    let d = 0;
    for (const k of spiral) {
      if (kindOf[k] === "desert") continue; // 跳过荒漠
      numOf[k] = DISC_SEQ[d++];
    }

    // 保险:确认 6/8 不相邻(官方摆法应天然满足)
    let ok = true;
    for (const k of TILE_KEYS) {
      if (numOf[k] !== 6 && numOf[k] !== 8) continue;
      const [q, r] = parseK(k);
      for (const [dq, dr] of DIRS) {
        const n = numOf[K(q + dq, r + dr)];
        if (n === 6 || n === 8) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;

    const desert = TILE_KEYS.find((k) => kindOf[k] === "desert");
    return {
      tiles: TILE_KEYS.map((k) => ({ k, kind: kindOf[k], num: numOf[k] ?? null })),
      robber: desert,
    };
  }
  throw new Error("board generation failed");
}

export function makeDevDeck(rand = Math.random) {
  const deck = [];
  for (const [card, n] of Object.entries(DEV_DECK_SPEC)) {
    for (let i = 0; i < n; i++) deck.push(card);
  }
  return shuffle(deck, rand);
}

// ---------- 局面查询 ----------

export function buildingAt(game, vid) {
  for (let i = 0; i < game.seats.length; i++) {
    if (game.seats[i].villages.includes(vid)) return { seat: i, type: "village" };
    if (game.seats[i].cities.includes(vid)) return { seat: i, type: "city" };
  }
  return null;
}

export function roadOwner(game, eid) {
  for (let i = 0; i < game.seats.length; i++) {
    if (game.seats[i].roads.includes(eid)) return i;
  }
  return null;
}

export function resCount(seatObj) {
  return RES_KEYS.reduce((s, k) => s + (seatObj.res?.[k] ?? seatObj.resCount ?? 0), 0);
}

export function canPay(res, cost) {
  return Object.entries(cost).every(([k, n]) => (res[k] ?? 0) >= n);
}

// 村庄合法落点。setup 阶段不要求连自己的路
export function legalVillages(game, seat) {
  const isSetup = game.phase === "setup";
  const out = [];
  for (const [vid] of VERTICES) {
    if (buildingAt(game, vid)) continue;
    // 间隔规则:相邻顶点也不能有任何建筑
    if (VERTEX_ADJ.get(vid).some((n) => buildingAt(game, n))) continue;
    if (isSetup) { out.push(vid); continue; }
    // 常规阶段:必须落在自己的路上
    if (VERTEX_EDGES.get(vid).some((e) => roadOwner(game, e) === seat)) out.push(vid);
  }
  return out;
}

// 道路合法落点。setup 阶段必须贴着刚放下的村庄
export function legalRoads(game, seat) {
  if (game.phase === "setup") {
    const v = game.setup.lastVillage;
    return VERTEX_EDGES.get(v).filter((e) => roadOwner(game, e) === null);
  }
  const out = [];
  for (const [eid, edge] of EDGES) {
    if (roadOwner(game, eid) !== null) continue;
    for (const vid of edge.v) {
      const b = buildingAt(game, vid);
      if (b && b.seat === seat) { out.push(eid); break; }
      // 经由该顶点接自己的路网:顶点上不能压着对手的建筑
      if (b) continue;
      if (VERTEX_EDGES.get(vid).some((e) => e !== eid && roadOwner(game, e) === seat)) {
        out.push(eid);
        break;
      }
    }
  }
  return out;
}

// 某玩家的最长连续道路(对手建筑会截断路径,不可重复用棱)
export function longestRoadLen(game, seat) {
  const mine = new Set(game.seats[seat].roads);
  if (mine.size === 0) return 0;
  const used = new Set();
  const walk = (vid) => {
    const b = buildingAt(game, vid);
    if (b && b.seat !== seat && used.size > 0) return 0; // 途经对手建筑即断
    let best = 0;
    for (const eid of VERTEX_EDGES.get(vid)) {
      if (!mine.has(eid) || used.has(eid)) continue;
      used.add(eid);
      const [a, b2] = EDGES.get(eid).v;
      best = Math.max(best, 1 + walk(a === vid ? b2 : a));
      used.delete(eid);
    }
    return best;
  };
  let best = 0;
  const starts = new Set();
  for (const eid of mine) for (const v of EDGES.get(eid).v) starts.add(v);
  for (const v of starts) best = Math.max(best, walk(v));
  return best;
}

// 公开分(不含保密的胜利点卡)
export function publicVP(game, seat) {
  const s = game.seats[seat];
  let vp = s.villages.length + s.cities.length * 2;
  if (game.longest.holder === seat) vp += 2;
  if (game.army.holder === seat) vp += 2;
  return vp;
}

// 总分(仅服务端/本人可算,含胜利点卡)
export function totalVP(game, seat) {
  const s = game.seats[seat];
  const vpCards = (s.devs ?? []).filter((d) => d.c === "vp").length;
  return publicVP(game, seat) + vpCards;
}
