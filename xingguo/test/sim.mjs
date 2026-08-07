// 无头回归:让两个机器人自己打满整场,顺带把不变量全查一遍。
// 跑法:npm test
import {
  createMatch, step, KINDS, STAGE, TPS, WINS_NEEDED, ROUND_TICKS, MAX_ROUNDS,
} from "../public/js/shared/sim.js";
import { botInput, LEVELS } from "../public/js/shared/ai.js";

const MATCHES = 60;
const MAX_TICKS = TPS * 60 * 12;   // 三局两胜 + 演出,再宽也不该超过 12 分钟

let fail = 0;
const bad = (msg) => { console.error("❌ " + msg); fail++; };

function playOne(seed, kinds, lv) {
  const m = createMatch(kinds, seed);
  const stat = { hits: 0, blocks: 0, slips: 0, kos: 0, rounds: 0, swings: 0 };
  let t = 0;

  while (m.phase !== "over") {
    if (++t > MAX_TICKS) { bad(`seed=${seed} 打不完(超过 ${MAX_TICKS} 帧)`); return stat; }
    const ev = step(m, [botInput(m, 0, lv), botInput(m, 1, lv)]);

    for (const e of ev) {
      if (e.t === "hit") stat.hits++;
      else if (e.t === "block") stat.blocks++;
      else if (e.t === "slip") stat.slips++;
      else if (e.t === "swing") stat.swings++;
      else if (e.t === "ko") { stat.kos++; stat.rounds++; }
    }

    // ---- 不变量 ----
    for (let i = 0; i < 2; i++) {
      const f = m.f[i], K = KINDS[f.kind];
      if (!(f.hp >= 0 && f.hp <= f.maxHp)) bad(`seed=${seed} 血量越界 ${f.hp}/${f.maxHp}`);
      if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) bad(`seed=${seed} 坐标 NaN`);
      const half = K.box.w / 2;
      if (f.x < half - 0.5 || f.x > STAGE.w - half + 0.5) bad(`seed=${seed} 跑出台子 x=${f.x.toFixed(1)}`);
      if (f.y > STAGE.floor + 0.5) bad(`seed=${seed} 掉到地板下面 y=${f.y.toFixed(1)}`);
      if (f.stun < 0) bad(`seed=${seed} 硬直为负`);
    }
    // 两个身体不许穿模
    const need = (KINDS[m.f[0].kind].box.w + KINDS[m.f[1].kind].box.w) / 2;
    if (Math.abs(m.f[0].x - m.f[1].x) < need - 1.5) {
      bad(`seed=${seed} 身体重叠 ${Math.abs(m.f[0].x - m.f[1].x).toFixed(1)} < ${need}`);
    }
    if (m.wins[0] > WINS_NEEDED || m.wins[1] > WINS_NEEDED) bad(`seed=${seed} 局分超了 ${m.wins}`);
    if (m.timer > ROUND_TICKS) bad(`seed=${seed} 计时倒着走`);
  }

  // 允许打满 MAX_ROUNDS 后判平(winner = -1),但除此之外必须有赢家
  if (m.winner === -1) {
    if (m.round < MAX_ROUNDS) bad(`seed=${seed} 没打满就判平(round=${m.round})`);
    stat.draws = 1;
  } else if (m.winner !== 0 && m.winner !== 1) {
    bad(`seed=${seed} 赢家编号离谱:${m.winner}`);
  } else if (Math.max(...m.wins) !== WINS_NEEDED && m.round < MAX_ROUNDS) {
    bad(`seed=${seed} 赢家局分不是 ${WINS_NEEDED}:${m.wins}`);
  }
  stat.ticks = t;
  return stat;
}

// ---- 1. 打满 60 场 ----
const total = { hits: 0, blocks: 0, slips: 0, kos: 0, rounds: 0, swings: 0, ticks: 0, draws: 0 };
const levels = Object.keys(LEVELS);
for (let i = 0; i < MATCHES; i++) {
  const lv = levels[i % levels.length];
  const kinds = i % 4 === 0 ? ["chimp", "chimp"]
              : i % 4 === 1 ? ["pot", "pot"]
              : i % 4 === 2 ? ["chimp", "pot"] : ["pot", "chimp"];
  const s = playOne(i * 7919 + 13, kinds, lv);
  for (const k in total) total[k] += s[k] ?? 0;
  process.stdout.write(`\r跑完 ${i + 1}/${MATCHES} 场…`);
}
console.log();

// ---- 2. 同种子必须完全复现 ----
const a = playOne(424242, ["chimp", "pot"], "normal");
const b = playOne(424242, ["chimp", "pot"], "normal");
if (JSON.stringify(a) !== JSON.stringify(b)) {
  bad(`同种子结果不一致:\n  ${JSON.stringify(a)}\n  ${JSON.stringify(b)}`);
}

// ---- 3. 空输入下双方都不该动,且该判平手 ----
{
  const m = createMatch(["chimp", "pot"], 5);
  const x0 = [m.f[0].x, m.f[1].x];
  for (let i = 0; i < TPS * 2; i++) step(m, [{}, {}]);
  if (Math.abs(m.f[0].x - x0[0]) > 1 || Math.abs(m.f[1].x - x0[1]) > 1) bad("没输入却自己走了");
  while (m.phase === "fight") step(m, [{}, {}]);
  if (m.roundWinner !== -1) bad(`双方都没动,不该分出胜负(得到 ${m.roundWinner})`);
}

// ---- 4. 两个角色的招式表都得是自洽的 ----
for (const [k, K] of Object.entries(KINDS)) {
  for (const [name, M] of Object.entries(K.moves)) {
    if (!(M.startup > 0 && M.recover > 0)) bad(`${k}.${name} 帧数不合法`);
    if (M.reach && !(M.boxH > 0)) bad(`${k}.${name} 有 reach 却没 boxH`);
    if (!M.reach && !M.proj) bad(`${k}.${name} 既不打人也不放东西`);
  }
}

if (fail) {
  console.error(`\n❌ ${fail} 项不通过`);
  process.exit(1);
}
const avg = (n) => (n / MATCHES).toFixed(1);
console.log(`✅ ${MATCHES} 场全部打完,${(total.ticks / TPS).toFixed(0)} 秒模拟时长`);
console.log(`   平均每场 ${avg(total.rounds)} 局, 命中 ${avg(total.hits)}, 格挡 ${avg(total.blocks)},`
          + ` 滑倒 ${avg(total.slips)}, 挥空 ${avg(total.swings - total.hits - total.blocks)}`);
