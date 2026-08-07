// 机器人大脑。前后端共用:本地「人机 / 围观」在浏览器里跑,联机加机器人时在 DO 里跑。
//
// 要点同 sim.js —— **必须确定性**,随机一律走 m.seed,不许碰 Math.random,
// 否则无头回归跑不出可复现的结果。
//
// 设计上刻意不做得太强:它会犹豫、会空挥、会在不该跳的时候跳,
// 因为这游戏的乐头在于两个傻东西互殴,不在于被电脑教做人。

import { KINDS, STAGE, rngNext } from "./sim.js";

export const LEVELS = {
  easy:   { react: 0.42, aggr: 0.35, guard: 0.15, jump: 0.020, name: "菜鸟" },
  normal: { react: 0.66, aggr: 0.55, guard: 0.34, jump: 0.014, name: "老手" },
  hard:   { react: 0.88, aggr: 0.76, guard: 0.55, jump: 0.010, name: "锅王" },
};

const NONE = Object.freeze({});

/**
 * 算出机器人这一帧该按什么键。
 * @param m  当前对局状态
 * @param i  我是几号位
 * @param lv 难度键名
 */
export function botInput(m, i, lv = "normal") {
  const L = LEVELS[lv] ?? LEVELS.normal;
  const f = m.f[i], o = m.f[1 - i];
  if (m.phase !== "fight" || f.st === "ko" || f.stun > 0 || f.st === "atk") return NONE;

  const K = KINDS[f.kind];
  const dx = o.x - f.x;
  const dist = Math.abs(dx);
  const toward = dx > 0 ? "right" : "left";
  const away = dx > 0 ? "left" : "right";
  const rnd = () => rngNext(m.seed);

  const inp = {};

  // 对手正在出招且已经抬手 —— 该躲该挡了
  const threat = o.st === "atk" && o.phaseName !== "recover" && dist < 190;
  if (threat && rnd() < L.guard) { inp.down = true; return inp; }

  // 地上有香蕉皮在朝我滚过来:跳过去(不然滑倒硬直太亏)
  for (const p of m.proj) {
    if (p.owner === i) continue;
    const coming = (p.vx > 0 && p.x < f.x) || (p.vx < 0 && p.x > f.x);
    if (coming && Math.abs(p.x - f.x) < 150 && f.onGround && rnd() < L.react) {
      inp.up = true;
      return inp;
    }
  }

  // 判定框是从我的中心往前伸 reach,对手的身体边缘在 dist - theirHalf 处。
  // 所以能不能够着要看**边缘距离**,不能拿中心距直接跟 reach 比 ——
  // 两只电炖锅贴在一起时中心距恒为 96(身体宽),比 reach 还大,
  // 早先那版判断的结果是它俩面对面站一整局谁也不出手。
  const reach = K.moves.heavy.reach;
  const theirHalf = KINDS[o.kind].box.w / 2;
  const edge = dist - theirHalf;

  // 够得着就打
  if (edge < reach + 10 && f.onGround) {
    if (rnd() < L.aggr) {
      const r = rnd();
      // 血少的时候更爱赌大招
      const desperate = f.hp < f.maxHp * 0.35;
      if (K.moves.special.cd && f.cd.special === 0 && r < (desperate ? 0.5 : 0.26)) {
        inp.special = true;
      } else if (r < 0.62) {
        inp.light = true;
      } else {
        inp.heavy = true;
      }
      return inp;
    }
    // 不打就贴着晃,别站着挨揍
    if (rnd() < 0.25) inp[away] = true;
    return inp;
  }

  // 中距离:黑猩猩爱丢香蕉皮控场
  if (f.kind === "chimp" && dist > 220 && f.cd.special === 0 && rnd() < L.aggr * 0.55) {
    inp.special = true;
    return inp;
  }

  // 其余情况往前压
  if (rnd() < L.react) inp[toward] = true;
  if (f.onGround && rnd() < L.jump) inp.up = true;

  // 贴到墙角别一直往墙里挤
  const half = K.box.w / 2;
  if ((f.x <= half + 6 && toward === "left") || (f.x >= STAGE.w - half - 6 && toward === "right")) {
    delete inp[toward];
  }
  return inp;
}
