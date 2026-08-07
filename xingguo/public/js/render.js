// 画面层:把 sim 的状态画到 canvas 上。这里**不改任何模拟状态**,只读。
//
// 角色目前是代码画的(procedural)。等可灵的贴图做好,把 img/<kind>-<pose>.png
// 放进去、SPRITES 里登记上,drawFighter 会自动改走贴图,这份文件其余部分不用动。

import { KINDS, STAGE, ROUND_TICKS, TPS, WINS_NEEDED } from "./shared/sim.js";

export const VIEW = { w: 960, h: 540 };
const GROUND = STAGE.floor;          // 地平线在画布上的 y

// ---------- 贴图(有就用,没有就退回代码画) ----------
const sprites = {};
let spritesReady = false;

/** 姿势名 —— 出可灵素材时按这张表来,文件名 img/<kind>-<pose>.png */
export const POSES = ["idle", "walk", "jump", "light", "heavy", "special", "hit", "ko", "win"];

export function poseOf(f) {
  if (f.st === "ko") return "ko";
  if (f.st === "win") return "win";
  if (f.st === "hit" || f.st === "slip") return "hit";
  if (f.st === "atk") return f.mv;            // light / heavy / special
  if (f.st === "block") return "idle";
  if (!f.onGround) return "jump";
  if (f.st === "walk") return "walk";
  return "idle";
}

/** 按 img/sprites.json 里登记的清单去加载贴图;没有这个文件就一直用代码画的形象。
 *  走清单而不是挨个试文件,是为了别在控制台刷一屏 404 ——
 *  两个角色九个姿势就是 18 个请求,美术没做完之前全是红的。 */
export async function loadSprites() {
  let list;
  try {
    const res = await fetch("img/sprites.json", { cache: "no-cache" });
    if (!res.ok) return;
    list = await res.json();      // { chimp: ["idle","walk",...], pot: [...] }
  } catch { return; }

  await Promise.all(Object.entries(list).flatMap(([kind, poses]) => {
    sprites[kind] = sprites[kind] || {};
    return poses.filter((p) => POSES.includes(p)).map((p) => new Promise((done) => {
      const im = new Image();
      im.onload = () => { sprites[kind][p] = im; spritesReady = true; done(); };
      im.onerror = done;
      im.src = `img/${kind}-${p}.png`;
    }));
  }));
}

// ---------- 特效粒子(纯表现,不进模拟) ----------
const parts = [];
const HIT_WORDS = ["砰!", "咚!", "哐!", "嘭!"];

export function spawnFx(ev, m) {
  const at = (i) => m.f[i];
  switch (ev.t) {
    case "hit": {
      const big = ev.mv === "heavy";
      for (let i = 0; i < (big ? 16 : 9); i++) {
        parts.push(part(ev.x, ev.y, "spark", big ? 5 : 3.4));
      }
      if (big) parts.push(word(ev.x, ev.y - 26, HIT_WORDS[(m.tick + ev.target) % HIT_WORDS.length]));
      break;
    }
    case "block":
      for (let i = 0; i < 7; i++) parts.push(part(ev.x, ev.y, "guard", 2.6));
      parts.push(word(ev.x, ev.y - 20, "挡住了", 15, "#9fd8ff"));
      break;
    case "slip":
      parts.push(word(ev.x, ev.y - 30, "哎哟!", 26, "#ffd76b"));
      for (let i = 0; i < 10; i++) parts.push(part(ev.x, ev.y + 30, "dust", 3));
      break;
    case "jump":
      for (let i = 0; i < 6; i++) parts.push(part(at(ev.who).x, GROUND, "dust", 2.2));
      break;
    case "swing":
      if (ev.mv === "special" && at(ev.who).kind === "pot") {
        parts.push(word(at(ev.who).x, GROUND - 150, "滋———", 24, "#e8f4ff"));
      }
      break;
    case "ko":
      if (ev.who >= 0) {
        const o = at(1 - ev.who);
        for (let i = 0; i < 26; i++) parts.push(part(o.x, o.y - 60, "star", 6));
      }
      break;
  }
}

function part(x, y, type, spd) {
  const a = Math.random() * Math.PI * 2;
  return {
    type, x, y,
    vx: Math.cos(a) * spd * (0.5 + Math.random()),
    vy: Math.sin(a) * spd * (0.5 + Math.random()) - (type === "dust" ? 1.2 : 0),
    life: type === "star" ? 46 : 22, max: type === "star" ? 46 : 22,
    size: type === "dust" ? 3 + Math.random() * 4 : 2 + Math.random() * 3,
  };
}

function word(x, y, text, size = 30, color = "#ffe38a") {
  return { type: "word", x, y, vx: 0, vy: -1.5, life: 34, max: 34, text, size, color };
}

function stepFx() {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx; p.y += p.vy;
    if (p.type !== "word") p.vy += 0.34;
    p.vx *= 0.94;
    if (--p.life <= 0) parts.splice(i, 1);
  }
}

export function clearFx() { parts.length = 0; }

// ---------- 主绘制 ----------

export function draw(ctx, m, opts = {}) {
  stepFx();
  ctx.clearRect(0, 0, VIEW.w, VIEW.h);
  drawBackdrop(ctx, m);
  for (const p of m.proj) drawBanana(ctx, p);
  // 后画血少的那个,让濒死的角色压在上层,视觉焦点对
  const order = m.f[0].hp <= m.f[1].hp ? [1, 0] : [0, 1];
  for (const i of order) drawFighter(ctx, m.f[i], m, i);
  drawParts(ctx);
  drawHud(ctx, m, opts);
}

function drawBackdrop(ctx, m) {
  // 厨房墙:暖色渐变 + 一圈暗角
  const g = ctx.createLinearGradient(0, 0, 0, GROUND);
  g.addColorStop(0, "#4a3626");
  g.addColorStop(1, "#6d4f37");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIEW.w, GROUND);

  // 墙砖
  ctx.strokeStyle = "rgba(0,0,0,.10)";
  ctx.lineWidth = 2;
  for (let y = 60; y < GROUND; y += 54) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(VIEW.w, y); ctx.stroke();
  }

  // 吊灯:随回合轻微摆动,给画面一点活气
  const sway = Math.sin(m.tick / 42) * 16;
  ctx.strokeStyle = "#2a1e16"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(VIEW.w / 2, 0); ctx.lineTo(VIEW.w / 2 + sway, 74); ctx.stroke();
  const lamp = ctx.createRadialGradient(VIEW.w / 2 + sway, 88, 4, VIEW.w / 2 + sway, 88, 190);
  lamp.addColorStop(0, "rgba(255,214,130,.55)");
  lamp.addColorStop(1, "rgba(255,214,130,0)");
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, VIEW.w, GROUND);
  ctx.fillStyle = "#e8c98a";
  ctx.beginPath(); ctx.arc(VIEW.w / 2 + sway, 84, 15, 0, Math.PI * 2); ctx.fill();

  // 地面
  const fg = ctx.createLinearGradient(0, GROUND, 0, VIEW.h);
  fg.addColorStop(0, "#8a6a48");
  fg.addColorStop(1, "#4a3524");
  ctx.fillStyle = fg;
  ctx.fillRect(0, GROUND, VIEW.w, VIEW.h - GROUND);
  ctx.fillStyle = "rgba(0,0,0,.22)";
  ctx.fillRect(0, GROUND, VIEW.w, 5);
  ctx.strokeStyle = "rgba(0,0,0,.13)";
  ctx.lineWidth = 2;
  for (let x = 0; x < VIEW.w; x += 96) {
    ctx.beginPath(); ctx.moveTo(x, GROUND); ctx.lineTo(x - 40, VIEW.h); ctx.stroke();
  }
}

function drawFighter(ctx, f, m, idx) {
  const K = KINDS[f.kind];
  ctx.save();

  // 影子:离地越高越小越淡
  const air = Math.max(0, (GROUND - f.y) / 160);
  ctx.globalAlpha = 0.34 * (1 - air * 0.6);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(f.x, GROUND + 3, K.box.w * 0.44 * (1 - air * 0.3), 8 * (1 - air * 0.3), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.translate(f.x, f.y);
  ctx.scale(f.face, 1);

  // 挨打时闪一下。别用 brightness 拉太狠 —— 不锈钢本来就浅,一提亮直接糊成一团白,
  // 看不出是被打了还是贴图丢了。压低饱和 + 轻微提亮,再叠一层红更好认。
  if (f.hitFlash > 0) ctx.filter = "brightness(1.35) saturate(1.6) hue-rotate(-18deg)";

  const sp = spritesReady && sprites[f.kind]?.[poseOf(f)];
  if (sp) {
    const h = K.box.h * 1.28, w = h * (sp.width / sp.height);
    ctx.drawImage(sp, -w / 2, -h, w, h);
  } else if (f.kind === "chimp") {
    drawChimp(ctx, f, K);
  } else {
    drawPot(ctx, f, K);
  }

  ctx.filter = "none";
  ctx.restore();
}

/** 手臂/腿的摆动幅度:走路时来回摆,出招时按招式帧推进 */
function limbSwing(f) {
  if (f.st === "walk") return Math.sin(f.stT / 3.2) * 0.9;
  if (f.st === "idle") return Math.sin(f.stT / 11) * 0.16;
  return 0;
}

function atkReach(f) {
  if (f.st !== "atk") return 0;
  const M = KINDS[f.kind].moves[f.mv];
  const s = M.startup, a = s + M.active;
  if (f.stT <= s) return -0.35 * (f.stT / s);          // 抬手往后蓄
  if (f.stT <= a) return 1;                             // 打出去
  return Math.max(0, 1 - (f.stT - a) / M.recover);      // 收招
}

function drawChimp(ctx, f, K) {
  const sw = limbSwing(f), ext = atkReach(f);
  const H = K.box.h;
  const crouch = f.st === "block" ? 26 : 0;
  const bob = f.st === "idle" ? Math.sin(f.stT / 11) * 2 : 0;
  const dark = "#5a3d27", mid = "#6f4d31", skin = "#c99a6a";

  // 腿
  ctx.strokeStyle = dark; ctx.lineCap = "round"; ctx.lineWidth = 17;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 12, -34 + crouch);
    ctx.lineTo(s * 14 + sw * 13 * s, -2);
    ctx.stroke();
  }

  // 身体
  ctx.fillStyle = mid;
  ctx.beginPath();
  ctx.ellipse(0, -62 + crouch + bob, 30, 34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = skin;                       // 肚皮
  ctx.beginPath();
  ctx.ellipse(4, -58 + crouch + bob, 16, 21, 0, 0, Math.PI * 2);
  ctx.fill();

  // 手臂(前面那只会随出招伸出去)
  ctx.strokeStyle = dark; ctx.lineWidth = 15;
  ctx.beginPath();                            // 后臂
  ctx.moveTo(-16, -76 + crouch + bob);
  ctx.lineTo(-30 - sw * 12, -34 + crouch);
  ctx.stroke();
  const armX = 18 + ext * 56, armY = -70 + crouch + bob - ext * 12;
  ctx.beginPath();                            // 前臂
  ctx.moveTo(14, -78 + crouch + bob);
  ctx.lineTo(armX, armY);
  ctx.stroke();
  ctx.fillStyle = dark;                       // 拳头
  ctx.beginPath(); ctx.arc(armX, armY, 11, 0, Math.PI * 2); ctx.fill();

  // 头
  const hy = -H + 26 + crouch + bob;
  ctx.fillStyle = mid;
  ctx.beginPath(); ctx.arc(2, hy, 25, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = dark;                       // 耳朵
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(2 + s * 25, hy - 2, 8, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = skin;                       // 脸
  ctx.beginPath(); ctx.ellipse(8, hy + 5, 17, 18, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#2a1c12";                  // 眼睛
  const angry = f.st === "atk" || f.st === "win";
  for (const s of [0, 1]) {
    ctx.beginPath();
    ctx.arc(4 + s * 11, hy + (angry ? 1 : 0), angry ? 2.6 : 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#3a2718"; ctx.lineWidth = 3;   // 眉毛:出招时压下来
  ctx.beginPath();
  ctx.moveTo(0, hy - 7 + (angry ? 3 : 0));
  ctx.lineTo(17, hy - 9);
  ctx.stroke();
  ctx.lineWidth = 2.4;                              // 嘴
  ctx.beginPath();
  if (f.st === "ko") { ctx.arc(9, hy + 13, 5, 0, Math.PI * 2); }
  else if (angry) { ctx.moveTo(2, hy + 12); ctx.lineTo(16, hy + 12); }
  else { ctx.arc(9, hy + 9, 6, 0.15 * Math.PI, 0.85 * Math.PI); }
  ctx.stroke();
}

function drawPot(ctx, f, K) {
  const sw = limbSwing(f), ext = atkReach(f);
  const H = K.box.h;
  const crouch = f.st === "block" ? 20 : 0;
  const steel = "#c2c7cd", steelDark = "#8f979f", plastic = "#3a3f45";

  // 电源线拖在身后
  ctx.strokeStyle = "#2a2e33"; ctx.lineWidth = 5; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-26, -12);
  ctx.quadraticCurveTo(-64, -2 + Math.sin(f.stT / 9) * 5, -92, -8);
  ctx.stroke();
  ctx.fillStyle = "#e0e4e8";
  ctx.fillRect(-102, -15, 13, 14);

  // 从下往上摞:腿 → 底座 → 锅身 → 盖。各段的 y 全部写死,别再算差值,
  // 之前那版身高是用一串加减凑出来的,结果锅身高了一倍,把底座和腿全盖住,画出来像个垃圾桶。
  const legTop  = -24 + crouch;
  const baseTop = -46 + crouch, baseH = 22;
  const bodyBot = -40 + crouch;
  const bodyTop = -H + 16 + crouch;      // 顶上留 16px 给锅盖
  const bodyH = bodyBot - bodyTop;

  // 小短腿
  ctx.strokeStyle = plastic; ctx.lineWidth = 13;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * 16, legTop);
    ctx.lineTo(s * 18 + sw * 10 * s, -2);
    ctx.stroke();
  }

  // 底座
  ctx.fillStyle = plastic;
  roundRect(ctx, -40, baseTop, 80, baseH, 6); ctx.fill();
  ctx.fillStyle = f.hp > 0 ? "#ff5a3c" : "#553530";     // 电源指示灯
  ctx.beginPath(); ctx.arc(-26, baseTop + 11, 4.2, 0, Math.PI * 2); ctx.fill();

  // 锅身
  ctx.fillStyle = steel;
  roundRect(ctx, -42, bodyTop, 84, bodyH, 10); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.30)";              // 竖条高光
  roundRect(ctx, -34, bodyTop + 8, 13, bodyH - 20, 6); ctx.fill();
  ctx.fillStyle = steelDark;                            // 两侧把手
  for (const s of [-1, 1]) {
    roundRect(ctx, s > 0 ? 42 : -54, bodyTop + bodyH * 0.34, 12, 26, 5); ctx.fill();
  }

  // 锅盖:出招时掀起来
  const lidLift = ext * 26 + (f.st === "win" ? 12 : 0);
  const lidTilt = ext * 0.5;
  ctx.save();
  ctx.translate(0, bodyTop - lidLift);
  ctx.rotate(lidTilt);
  ctx.fillStyle = steel;
  ctx.beginPath(); ctx.ellipse(0, 0, 46, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = steelDark;
  ctx.beginPath(); ctx.ellipse(0, -7, 22, 8, 0, Math.PI, 0); ctx.fill();
  ctx.fillStyle = plastic;                              // 盖钮
  ctx.beginPath(); ctx.arc(0, -13, 7, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // 喷蒸汽:实打实画一团
  if (f.st === "atk" && f.mv === "special" && atkReach(f) > 0.2) {
    ctx.fillStyle = "rgba(240,248,255,.5)";
    for (let i = 0; i < 7; i++) {
      const t = (f.stT * 5 + i * 24) % 130;
      ctx.beginPath();
      ctx.arc(30 + t, bodyTop + 6 + Math.sin(t / 14) * 13, 9 + t / 11, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 脸(贴在锅身上)
  const fy = bodyTop + 40;
  ctx.fillStyle = "#20242a";
  const angry = f.st === "atk" || f.st === "win";
  for (const s of [0, 1]) {
    ctx.beginPath();
    ctx.ellipse(-9 + s * 20, fy, 4, f.st === "ko" ? 1.6 : 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#20242a"; ctx.lineWidth = 2.6; ctx.lineCap = "round";
  ctx.beginPath();
  if (f.st === "ko") { ctx.moveTo(-8, fy + 17); ctx.lineTo(10, fy + 17); }
  else if (angry) { ctx.moveTo(-10, fy + 15); ctx.quadraticCurveTo(1, fy + 8, 12, fy + 15); }
  else { ctx.moveTo(-9, fy + 13); ctx.quadraticCurveTo(1, fy + 20, 11, fy + 13); }
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBanana(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.spin);
  ctx.fillStyle = "#f2d03f";
  ctx.beginPath(); ctx.ellipse(0, 0, 17, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d8b02c";
  ctx.beginPath(); ctx.ellipse(-6, 2, 9, 4, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawParts(ctx) {
  for (const p of parts) {
    const a = p.life / p.max;
    ctx.globalAlpha = a;
    if (p.type === "word") {
      ctx.font = `900 ${p.size}px "PingFang SC", sans-serif`;
      ctx.textAlign = "center";
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(60,20,0,.85)";
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    } else {
      ctx.fillStyle = p.type === "spark" ? "#ffd76b"
        : p.type === "guard" ? "#9fd8ff"
        : p.type === "star" ? "#fff2a8" : "rgba(220,200,170,.85)";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// ---------- 顶部 HUD ----------

function drawHud(ctx, m, opts) {
  const names = opts.names ?? [KINDS[m.f[0].kind].name, KINDS[m.f[1].kind].name];
  for (let i = 0; i < 2; i++) bar(ctx, m, i, names[i]);

  // 倒计时
  const sec = Math.max(0, Math.ceil(m.timer / TPS));
  ctx.font = '900 40px ui-monospace, "PingFang SC", monospace';
  ctx.textAlign = "center";
  ctx.lineWidth = 6; ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.strokeText(String(sec), VIEW.w / 2, 56);
  ctx.fillStyle = sec <= 10 ? "#ff7a5c" : "#ffe9c4";
  ctx.fillText(String(sec), VIEW.w / 2, 56);
}

function bar(ctx, m, i, name) {
  const f = m.f[i];
  const W = 372, H = 24, pad = 26;
  const x = i === 0 ? pad : VIEW.w - pad - W;
  const y = 26;

  ctx.fillStyle = "rgba(0,0,0,.5)";
  roundRect(ctx, x - 3, y - 3, W + 6, H + 6, 6); ctx.fill();

  const ratio = f.hp / f.maxHp;
  const fw = Math.max(0, W * ratio);
  const g = ctx.createLinearGradient(x, 0, x + W, 0);
  if (ratio > 0.35) { g.addColorStop(0, "#5fd06a"); g.addColorStop(1, "#b7e05a"); }
  else { g.addColorStop(0, "#e8503c"); g.addColorStop(1, "#f0913a"); }
  ctx.fillStyle = g;
  // 按格斗游戏的老规矩:剩余血量贴着**外侧**,从中间往外掉。
  // 左边这条锚在左端,右边那条锚在右端。
  roundRect(ctx, i === 0 ? x : x + (W - fw), y, fw, H, 4); ctx.fill();

  ctx.font = '700 15px "PingFang SC", sans-serif';
  ctx.textAlign = i === 0 ? "left" : "right";
  ctx.fillStyle = "#fff3dd";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.65)";
  const tx = i === 0 ? x : x + W;
  ctx.strokeText(name, tx, y + H + 19);
  ctx.fillText(name, tx, y + H + 19);

  // 已赢的局数,画成小圆点
  for (let k = 0; k < WINS_NEEDED; k++) {
    const cx = i === 0 ? x + W - 11 - k * 21 : x + 11 + k * 21;
    ctx.beginPath(); ctx.arc(cx, y + H + 14, 7, 0, Math.PI * 2);
    ctx.fillStyle = k < m.wins[i] ? "#ffd24a" : "rgba(255,255,255,.22)";
    ctx.fill();
  }
}
