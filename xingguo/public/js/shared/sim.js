// 「黑猩猩和电炖锅打架」—— 战斗模拟核心。
//
// 这份文件前后端共用:本地模式(人机/双人/围观)直接在浏览器里跑,
// 联机时由 Durable Object 权威地跑、客户端只负责画。
// 因此这里必须是**纯粹确定性**的:不碰 Date.now,不碰 Math.random,
// 随机数一律走 state 里的种子,同样的初始状态 + 同样的输入序列 = 同样的结果。

export const TPS = 30;                 // 每秒 30 个模拟帧
export const ROUND_TICKS = 60 * TPS;   // 每局 60 秒
export const WINS_NEEDED = 2;          // 三局两胜
// 平局不给任何人加分,真要一直平下去回合就无限续了 ——
// 联机时那等于让 Durable Object 一直空转,所以硬性封顶。
export const MAX_ROUNDS = 5;

// 世界坐标(渲染时再等比缩放到画布)
export const STAGE = { w: 960, floor: 400, ceil: 0 };
export const GRAVITY = 0.9;
export const FRICTION = 0.72;

// ---------- 角色 ----------
// box 是站立时的身体碰撞盒(相对脚底中心:x 居中,y 向上为负)
export const KINDS = {
  chimp: {
    name: "黑猩猩",
    hp: 100,
    speed: 3.6,
    jump: 15.5,
    box: { w: 86, h: 132 },
    crouchH: 88,
    moves: {
      light: { name: "挠", startup: 3, active: 3, recover: 6, dmg: 6,
               reach: 74, boxH: 44, boxY: -104, kb: 3.2, kbUp: 0, stun: 7 },
      heavy: { name: "抡臂", startup: 9, active: 4, recover: 15, dmg: 15,
               reach: 96, boxH: 60, boxY: -112, kb: 9, kbUp: -5, stun: 15 },
      // 香蕉皮:扔出去贴地滑行,踩到就滑倒(硬直特别长,但伤害低)
      special: { name: "扔香蕉皮", startup: 8, active: 1, recover: 16, cd: 90,
                 proj: "banana" },
    },
  },
  pot: {
    name: "电炖锅",
    hp: 132,
    speed: 2.5,
    jump: 11.5,
    box: { w: 96, h: 116 },
    crouchH: 84,
    moves: {
      light: { name: "盖子拍", startup: 4, active: 3, recover: 7, dmg: 7,
               reach: 68, boxH: 40, boxY: -92, kb: 3.4, kbUp: 0, stun: 7 },
      // 滚烫冲撞:起手时给自己一个向前的速度,冲的过程中判定一直开着
      heavy: { name: "滚烫冲撞", startup: 10, active: 10, recover: 16, dmg: 16,
               reach: 70, boxH: 78, boxY: -100, kb: 11, kbUp: -6, stun: 18,
               dash: 13 },
      // 喷蒸汽:近身多段小伤害,把人往外推,不给击退硬直,主要是逼退
      special: { name: "喷蒸汽", startup: 6, active: 15, recover: 12, cd: 105,
                 dmg: 2, reach: 120, boxH: 52, boxY: -96, kb: 2.2, kbUp: 0,
                 stun: 3, everyN: 3 },
    },
  },
};

export const PROJ = {
  banana: { w: 34, h: 18, vx: 9, dmg: 5, life: 90, slipStun: 42 },
};

// ---------- 随机数(可复现) ----------
// mulberry32:小、快、够用,关键是同种子必同序列
export function rngNext(s) {
  s.r = (s.r + 0x6D2B79F5) >>> 0;
  let t = s.r;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------- 建局 ----------

export function createMatch(kinds = ["chimp", "pot"], seed = 1) {
  return {
    tick: 0,
    seed: { r: seed >>> 0 },
    phase: "intro",          // intro -> fight -> ko -> over
    phaseT: TPS,             // 当前阶段剩余帧
    round: 1,
    wins: [0, 0],
    timer: ROUND_TICKS,
    winner: -1,              // 整场的赢家,-1 = 未定
    roundWinner: -1,
    f: [makeFighter(kinds[0], 260, 1), makeFighter(kinds[1], STAGE.w - 260, -1)],
    proj: [],
  };
}

function makeFighter(kind, x, face) {
  const K = KINDS[kind];
  return {
    kind, x, y: STAGE.floor, vx: 0, vy: 0, face,
    hp: K.hp, maxHp: K.hp,
    st: "idle",      // idle walk jump atk hit block slip ko win
    stT: 0,          // 该状态已经持续了几帧
    mv: null,        // 当前招式名(light/heavy/special)
    phaseName: "",   // startup / active / recover
    hitDone: false,  // 本次攻击是否已经命中过(防一刀多段)
    cd: { special: 0 },
    stun: 0,
    onGround: true,
    blocking: false,
    hitFlash: 0,
  };
}

/** 复位到新一局(保留比分) */
export function resetRound(m) {
  const k = [m.f[0].kind, m.f[1].kind];
  m.f = [makeFighter(k[0], 260, 1), makeFighter(k[1], STAGE.w - 260, -1)];
  m.proj = [];
  m.timer = ROUND_TICKS;
  m.phase = "intro";
  m.phaseT = TPS;
  m.roundWinner = -1;
}

// ---------- 每帧推进 ----------
// inputs: [{left,right,up,down,light,heavy,special}, {...}]
// 返回本帧发生的事件,给前端拿去放特效和音效(纯表现,不影响模拟)
export function step(m, inputs) {
  const ev = [];
  m.tick++;

  if (m.phase === "intro") {
    if (--m.phaseT <= 0) { m.phase = "fight"; ev.push({ t: "start" }); }
    return ev;
  }
  if (m.phase === "ko" || m.phase === "over") {
    if (--m.phaseT <= 0 && m.phase === "ko") {
      const decided = m.wins[0] >= WINS_NEEDED || m.wins[1] >= WINS_NEEDED;
      if (decided || m.round >= MAX_ROUNDS) {
        m.phase = "over";
        // 打满上限还没分出胜负的,先比局分,再比血量比例,还平就算平
        m.winner = m.wins[0] !== m.wins[1]
          ? (m.wins[0] > m.wins[1] ? 0 : 1)
          : judgeByHp(m);
        ev.push({ t: "over", who: m.winner });
      } else {
        m.round++;
        resetRound(m);
      }
    }
    // KO 演出期间还是要让身体落地,不然会浮空;
    // 分离也得照跑 —— 被打飞的那个会朝赢家滑过去,不推开就穿模了
    for (const f of m.f) physics(f);
    separate(m.f[0], m.f[1]);
    return ev;
  }

  // ---- 正常战斗帧 ----
  for (let i = 0; i < 2; i++) control(m, i, inputs[i] || {}, ev);
  for (const f of m.f) physics(f);
  separate(m.f[0], m.f[1]);
  for (let i = 0; i < 2; i++) resolveHits(m, i, ev);
  stepProjectiles(m, ev);
  for (const f of m.f) if (f.hitFlash > 0) f.hitFlash--;

  // 计时
  if (--m.timer <= 0) endRound(m, judgeByHp(m), ev, "time");

  return ev;
}

/** 时间到了按血量**百分比**判 —— 两个角色血上限不一样(锅 132、猩猩 100),
 *  比绝对值的话锅站着不动都能赢,那不成了。 */
function judgeByHp(m) {
  const [a, b] = m.f;
  const ra = a.hp / a.maxHp, rb = b.hp / b.maxHp;
  if (Math.abs(ra - rb) < 1e-9) return -1;
  return ra > rb ? 0 : 1;
}

function control(m, i, inp, ev) {
  const f = m.f[i], o = m.f[1 - i], K = KINDS[f.kind];
  if (f.st === "ko") return;

  for (const k in f.cd) if (f.cd[k] > 0) f.cd[k]--;

  // 受击/滑倒硬直:只倒计时,不接受输入
  if (f.stun > 0) {
    f.stun--;
    if (f.stun === 0 && f.st !== "ko") { f.st = "idle"; f.stT = 0; }
    return;
  }

  // 出招中:推进招式帧
  if (f.st === "atk") { advanceMove(m, i, ev); return; }

  // 不在出招时,自动面向对手
  f.face = o.x >= f.x ? 1 : -1;

  // 起招
  const startable = f.onGround;
  if (startable) {
    for (const mv of ["light", "heavy", "special"]) {
      if (!inp[mv]) continue;
      const M = K.moves[mv];
      if (M.cd && f.cd[mv] > 0) continue;
      f.st = "atk"; f.stT = 0; f.mv = mv; f.phaseName = "startup";
      f.hitDone = false; f.blocking = false;
      if (M.cd) f.cd[mv] = M.cd;
      ev.push({ t: "swing", who: i, mv });
      return;
    }
  }

  // 防御:蹲下且不按方向 = 格挡(简化成「按下 = 挡」)
  f.blocking = !!inp.down && f.onGround;
  if (f.blocking) { f.st = "block"; f.stT++; f.vx *= 0.5; return; }

  // 移动
  let dx = 0;
  if (inp.left) dx -= 1;
  if (inp.right) dx += 1;
  // 空中操控力减半,免得像在飞
  f.vx += dx * K.speed * (f.onGround ? 1 : 0.5) * 0.55;

  if (inp.up && f.onGround) {
    f.vy = -K.jump;
    f.onGround = false;
    f.st = "jump"; f.stT = 0;
    ev.push({ t: "jump", who: i });
    return;
  }

  if (!f.onGround) { f.st = "jump"; f.stT++; }
  else if (dx !== 0) { f.st = "walk"; f.stT++; }
  else { f.st = "idle"; f.stT++; }
}

function advanceMove(m, i, ev) {
  const f = m.f[i], M = KINDS[f.kind].moves[f.mv];
  f.stT++;
  const s = M.startup, a = s + M.active, r = a + M.recover;

  if (f.stT === s + 1 && M.dash) f.vx = M.dash * f.face;   // 冲撞起速
  if (f.stT === s + 1 && M.proj) spawnProj(m, i, M.proj, ev);

  f.phaseName = f.stT <= s ? "startup" : f.stT <= a ? "active" : "recover";
  if (f.stT > r) { f.st = "idle"; f.stT = 0; f.mv = null; f.phaseName = ""; }
}

function spawnProj(m, i, kind, ev) {
  const f = m.f[i], P = PROJ[kind];
  m.proj.push({
    kind, owner: i,
    x: f.x + f.face * 60, y: STAGE.floor - P.h / 2,
    vx: P.vx * f.face, life: P.life, spin: 0,
  });
  ev.push({ t: "proj", who: i, kind });
}

function physics(f) {
  const K = KINDS[f.kind];
  f.x += f.vx;
  f.y += f.vy;
  f.vy += GRAVITY;
  if (f.onGround) f.vx *= FRICTION;
  else f.vx *= 0.985;

  if (f.y >= STAGE.floor) {
    f.y = STAGE.floor; f.vy = 0;
    if (!f.onGround) { f.onGround = true; if (f.st === "jump") { f.st = "idle"; f.stT = 0; } }
  } else {
    f.onGround = false;
  }

  clampX(f);
}

function clampX(f) {
  const half = KINDS[f.kind].box.w / 2;
  if (f.x < half) { f.x = half; f.vx = Math.max(0, f.vx); }
  if (f.x > STAGE.w - half) { f.x = STAGE.w - half; f.vx = Math.min(0, f.vx); }
}

/** 两个身体不许重叠,轻的那个被推得多一点。
 *  贴墙的一方推不动,他那份位移要转给另一方 —— 否则「推开 → 钳回墙里」
 *  会一直循环,两个身体永远分不开。 */
function separate(a, b) {
  const aw = KINDS[a.kind].box.w / 2, bw = KINDS[b.kind].box.w / 2;
  const need = aw + bw, d = b.x - a.x, dist = Math.abs(d);
  if (dist >= need || dist === 0) return;

  const gap = need - dist, dir = d > 0 ? 1 : -1;
  const wa = KINDS[a.kind].hp, wb = KINDS[b.kind].hp;   // 拿血量当体重,锅更沉
  const total = wa + wb;
  const wantA = gap * (wb / total), wantB = gap * (wa / total);

  const ax0 = a.x;
  a.x -= wantA * dir; clampX(a);
  const movedA = Math.abs(a.x - ax0);

  const bx0 = b.x;
  b.x += (wantB + (wantA - movedA)) * dir; clampX(b);   // 接手 a 没推动的那部分
  const movedB = Math.abs(b.x - bx0);

  const left = gap - movedA - movedB;                    // b 也顶墙了,再还给 a
  if (left > 0.01) { a.x -= left * dir; clampX(a); }
}

function bodyBox(f) {
  const K = KINDS[f.kind];
  const h = f.st === "block" ? K.crouchH : K.box.h;
  return { x: f.x - K.box.w / 2, y: f.y - h, w: K.box.w, h };
}

function hitBox(f) {
  if (f.st !== "atk" || f.phaseName !== "active") return null;
  const M = KINDS[f.kind].moves[f.mv];
  if (!M.reach) return null;
  const x = f.face > 0 ? f.x : f.x - M.reach;
  return { x, y: f.y + M.boxY, w: M.reach, h: M.boxH, M };
}

const overlap = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function resolveHits(m, i, ev) {
  const f = m.f[i], o = m.f[1 - i];
  const hb = hitBox(f);
  if (!hb || o.st === "ko") return;
  const M = hb.M;

  // 蒸汽这种多段招:每 everyN 帧才判定一次,并且每次都能再中
  if (M.everyN) {
    const activeFrame = f.stT - M.startup;
    if (activeFrame % M.everyN !== 1) return;
  } else if (f.hitDone) return;

  if (!overlap(hb, bodyBox(o))) return;
  if (!M.everyN) f.hitDone = true;

  // 背对着挨打不算挡住
  const facingAway = (o.face > 0 && f.x < o.x) || (o.face < 0 && f.x > o.x);
  const blocked = o.blocking && !facingAway;
  const dmg = blocked ? Math.max(1, Math.round(M.dmg * 0.2)) : M.dmg;

  o.hp = Math.max(0, o.hp - dmg);
  o.hitFlash = 6;
  o.vx += (blocked ? M.kb * 0.5 : M.kb) * f.face;
  if (!blocked && M.kbUp) { o.vy = M.kbUp; o.onGround = false; }
  if (!blocked) { o.stun = M.stun; o.st = "hit"; o.stT = 0; o.mv = null; }

  ev.push({ t: blocked ? "block" : "hit", who: i, target: 1 - i, dmg,
            x: o.x, y: o.y - 70, mv: f.mv });

  if (o.hp <= 0) { o.st = "ko"; o.vy = -9; o.vx = 3 * f.face; endRound(m, i, ev, "ko"); }
}

function stepProjectiles(m, ev) {
  for (let k = m.proj.length - 1; k >= 0; k--) {
    const p = m.proj[k], P = PROJ[p.kind];
    p.x += p.vx;
    p.spin += p.vx * 0.05;
    if (--p.life <= 0 || p.x < 0 || p.x > STAGE.w) { m.proj.splice(k, 1); continue; }

    const o = m.f[1 - p.owner];
    if (o.st === "ko") continue;
    const box = { x: p.x - P.w / 2, y: p.y - P.h / 2, w: P.w, h: P.h };
    if (!overlap(box, bodyBox(o))) continue;

    m.proj.splice(k, 1);
    // 香蕉皮不看格挡 —— 你挡得住拳头,挡不住脚下打滑
    o.hp = Math.max(0, o.hp - P.dmg);
    o.hitFlash = 6;
    o.stun = P.slipStun;
    o.st = "slip"; o.stT = 0; o.mv = null;
    o.vx = p.vx * 0.6; o.vy = -7; o.onGround = false;
    ev.push({ t: "slip", who: p.owner, target: 1 - p.owner, x: o.x, y: o.y - 60 });
    if (o.hp <= 0) { o.st = "ko"; endRound(m, p.owner, ev, "ko"); }
  }
}

function endRound(m, who, ev, how) {
  if (m.phase !== "fight") return;
  m.phase = "ko";
  m.phaseT = TPS * 2.2;
  m.roundWinner = who;
  if (who >= 0) {
    m.wins[who]++;
    m.f[who].st = "win"; m.f[who].stT = 0;
  }
  ev.push({ t: "ko", who, how });
}

/** 给 UI 用的一句话战报 */
export function roundText(m) {
  if (m.phase === "over") {
    return m.winner < 0 ? "打满五局,不分胜负!"
                        : `${KINDS[m.f[m.winner].kind].name} 赢下这场!`;
  }
  if (m.phase === "ko") {
    if (m.roundWinner < 0) return "平手!";
    return `第 ${m.round} 局 —— ${KINDS[m.f[m.roundWinner].kind].name} 胜`;
  }
  if (m.phase === "intro") return `第 ${m.round} 局`;
  return "";
}
