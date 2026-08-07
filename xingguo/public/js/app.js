// 前端主程序:模式调度 + 输入 + 主循环。
//
// 本地三个模式(人机/双人/围观)直接在这儿跑 sim;
// 联机时不跑 sim,只把按键发上去、把服务端下发的快照画出来。
import {
  createMatch, step, KINDS, TPS, roundText,
} from "./shared/sim.js?v=1";
import { botInput } from "./shared/ai.js?v=1";
import { draw, spawnFx, clearFx, loadSprites, VIEW } from "./render.js?v=1";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const token = (() => {
  let t = sessionStorage.getItem("xingguo-token");
  if (!t) { t = crypto.randomUUID(); sessionStorage.setItem("xingguo-token", t); }
  return t;
})();

let mode = null;          // solo | local2p | watch | online
let mySide = "chimp";     // 我演谁
let level = "normal";
let M = null;             // 本地模式下的对局状态
let raf = 0, acc = 0, lastT = 0;
let running = false;

// 联机用
let ws = null, code = null, mySeat = -1, joined = false, leaving = false;
let snapPrev = null, snapCur = null, snapAt = 0, lastSentMask = -1;

const ctx = $("stage").getContext("2d");

// ---------- 输入 ----------
const KEYS = {
  // 一号位
  KeyA: [0, "left"], KeyD: [0, "right"], KeyW: [0, "up"], KeyS: [0, "down"],
  KeyJ: [0, "light"], KeyK: [0, "heavy"], KeyL: [0, "special"],
  // 二号位(同屏双人)
  ArrowLeft: [1, "left"], ArrowRight: [1, "right"], ArrowUp: [1, "up"], ArrowDown: [1, "down"],
  Digit1: [1, "light"], Digit2: [1, "heavy"], Digit3: [1, "special"],
  Numpad1: [1, "light"], Numpad2: [1, "heavy"], Numpad3: [1, "special"],
};
const held = [{}, {}];    // held[座位][动作] = true

addEventListener("keydown", (e) => {
  const k = KEYS[e.code];
  if (!k || !running) return;
  e.preventDefault();
  held[k[0]][k[1]] = true;
});
addEventListener("keyup", (e) => {
  const k = KEYS[e.code];
  if (!k) return;
  held[k[0]][k[1]] = false;
});
addEventListener("blur", () => { held[0] = {}; held[1] = {}; });

// 手机虚拟按键:一律算一号位
for (const b of document.querySelectorAll("#pad .pb")) {
  const act = b.dataset.k;
  const on = (e) => { e.preventDefault(); held[0][act] = true; };
  const off = (e) => { e.preventDefault(); held[0][act] = false; };
  b.addEventListener("pointerdown", on);
  b.addEventListener("pointerup", off);
  b.addEventListener("pointercancel", off);
  b.addEventListener("pointerleave", off);
}

const MASK = { left: 1, right: 2, up: 4, down: 8, light: 16, heavy: 32, special: 64 };
const toMask = (o) => Object.keys(MASK).reduce((n, k) => n | (o[k] ? MASK[k] : 0), 0);
const fromMask = (n) => Object.keys(MASK).reduce((o, k) => (o[k] = !!(n & MASK[k]), o), {});

// ---------- 界面 ----------
const show = (id) => {
  for (const s of ["home", "lobby", "fight"]) $(s).classList.toggle("hidden", s !== id);
};

let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

let shoutTimer = 0;
function shout(text, ms = 1200) {
  const el = $("shout");
  if (!text) { el.classList.add("hidden"); return; }
  el.textContent = text;
  el.classList.remove("hidden");
  // 重新触发入场动画
  el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
  clearTimeout(shoutTimer);
  shoutTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

// ---------- 本地模式 ----------

function startLocal(m) {
  mode = m;
  const other = mySide === "chimp" ? "pot" : "chimp";
  const kinds = m === "watch" ? ["chimp", "pot"] : [mySide, other];
  M = createMatch(kinds, (Math.random() * 1e9) | 0);
  held[0] = {}; held[1] = {};
  clearFx();
  snapPrev = snapCur = null;
  $("pad").classList.toggle("hidden", m === "watch" || !isTouch());
  show("fight");
  running = true;
  acc = 0; lastT = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loopLocal);
}

function inputsFor(M) {
  if (mode === "watch") return [botInput(M, 0, level), botInput(M, 1, level)];
  if (mode === "local2p") return [held[0], held[1]];
  return [held[0], botInput(M, 1, level)];   // solo:我是 0 号
}

let lastPhase = "";
function loopLocal(now) {
  raf = requestAnimationFrame(loopLocal);
  const dt = Math.min(now - lastT, 250);     // 切后台回来别一次补几百帧
  lastT = now;
  acc += dt;
  const stepMs = 1000 / TPS;
  while (acc >= stepMs) {
    acc -= stepMs;
    const ev = step(M, inputsFor(M));
    for (const e of ev) spawnFx(e, M);
    handlePhase(M, ev);
  }
  draw(ctx, M, { names: nameTags(M) });
}

function nameTags(m) {
  const n = [KINDS[m.f[0].kind].name, KINDS[m.f[1].kind].name];
  if (mode === "solo") n[0] += "(你)";
  else if (mode === "local2p") { n[0] += "(1P)"; n[1] += "(2P)"; }
  else if (mode === "online" && mySeat >= 0) n[mySeat] += "(你)";
  return n;
}

function handlePhase(m, ev) {
  for (const e of ev) {
    if (e.t === "ko") {
      shout(e.who < 0 ? "平手!" : "KO!", 1500);
    } else if (e.t === "over") {
      running = false;
      setTimeout(() => showResult(m), 900);
    } else if (e.t === "start" && m.round > 1) {
      shout(`第 ${m.round} 局`, 900);
    }
  }
  if (m.phase !== lastPhase) {
    if (m.phase === "intro" && m.round === 1) shout("打!", 800);
    lastPhase = m.phase;
  }
}

function showResult(m) {
  const win = m.winner;
  const mine = mode === "solo" ? 0 : mode === "online" ? mySeat : -1;
  let title;
  if (win < 0) title = "🤝 打满五局,不分胜负";
  else if (mine < 0) title = `🏆 ${KINDS[m.f[win].kind].name} 赢了`;
  else title = win === mine ? "🎉 你赢了!" : "💀 你输了";

  $("modal-layer").classList.remove("hidden");
  $("modal").innerHTML = `<h2>${title}</h2>
    <p class="hint">${esc(roundText(m))} · 局分 ${m.wins[0]} : ${m.wins[1]}</p>
    <div class="row" style="justify-content:center">
      <button id="m-again">再来一局</button>
      <button id="m-home" class="linkish">回首页</button>
    </div>`;
  $("m-again").onclick = () => {
    $("modal-layer").classList.add("hidden");
    if (mode === "online") send({ t: "again" }); else startLocal(mode);
  };
  $("m-home").onclick = goHome;
}

function goHome() {
  running = false;
  cancelAnimationFrame(raf);
  $("modal-layer").classList.add("hidden");
  shout(null);
  leaving = true;
  try { ws?.close(); } catch {}
  ws = null; joined = false; mySeat = -1; code = null;
  snapPrev = snapCur = null;
  sessionStorage.removeItem("xingguo-room");
  history.replaceState(null, "", location.pathname);
  show("home");
}

// ---------- 联机 ----------

function connect(c) {
  code = c.toUpperCase();
  leaving = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${code}`);
  ws.onopen = () => send({ t: "join", token, side: mySide });
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => {
    if (leaving || !joined) return;
    toast("连接断开,正在重连…");
    setTimeout(() => { if (!leaving) connect(code); }, 1400);
  };
}

const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };

function onMsg(m) {
  if (m.t === "joined") {
    joined = true; mySeat = m.seat;
    sessionStorage.setItem("xingguo-room", m.code);
    history.replaceState(null, "", "?room=" + m.code);
    $("lobby-code").textContent = m.code;
    show("lobby");
    return;
  }
  if (m.t === "err") {
    if (!joined) { $("lobby-err").textContent = m.msg; goHome(); }
    else toast(m.msg);
    return;
  }
  if (m.t === "lobby") { renderLobby(m); return; }
  if (m.t === "begin") {
    held[0] = {}; held[1] = {};
    clearFx();
    lastSentMask = -1;
    snapPrev = snapCur = null;
    $("pad").classList.toggle("hidden", !isTouch());
    show("fight");
    running = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loopOnline);
    return;
  }
  if (m.t === "snap") {
    snapPrev = snapCur;
    snapCur = m.m;
    snapAt = performance.now();
    for (const e of (m.ev || [])) spawnFx(e, snapCur);
    handlePhase(snapCur, m.ev || []);
    return;
  }
}

function renderLobby(m) {
  $("lobby-players").innerHTML = m.seats.map((s, i) => `<li>
      <b>${KINDS[s.side].name}</b>
      ${i === mySeat ? '<span class="tag">你</span>' : ""}
      ${s.bot ? '<span class="tag">🤖</span>' : ""}
      ${s.connected ? "" : '<span class="tag">掉线</span>'}
    </li>`).join("");
  $("lobby-wait").textContent = m.seats.length < 2
    ? "等对手进来…把房间码发给他"
    : "两边都到齐了,马上开打";
  $("btn-lobby-bot").classList.toggle("hidden", m.seats.length >= 2);
}

function loopOnline(now) {
  raf = requestAnimationFrame(loopOnline);

  // 按键有变化才发,别每帧刷
  const mask = toMask(held[0]);
  if (mask !== lastSentMask) { lastSentMask = mask; send({ t: "in", k: mask }); }

  if (!snapCur) return;
  // 服务端 30Hz、屏幕 60Hz,两帧之间插值一下,不然人物是跳着走的
  const view = snapPrev ? lerpSnap(snapPrev, snapCur, Math.min(1, (now - snapAt) / (1000 / TPS))) : snapCur;
  draw(ctx, view, { names: nameTags(snapCur) });
}

function lerpSnap(a, b, t) {
  const out = { ...b, f: b.f.map((fb, i) => {
    const fa = a.f[i];
    // 只插位置。状态、血量这些跳变的字段一律用最新的,插了反而出错
    if (!fa || fa.kind !== fb.kind) return fb;
    return { ...fb, x: fa.x + (fb.x - fa.x) * t, y: fa.y + (fb.y - fa.y) * t };
  }) };
  return out;
}

// ---------- 首页交互 ----------

const isTouch = () => matchMedia("(pointer: coarse)").matches;

function pick(sel, attr, set) {
  for (const b of document.querySelectorAll(sel)) {
    b.onclick = () => {
      for (const x of document.querySelectorAll(sel)) x.classList.toggle("on", x === b);
      set(b.dataset[attr]);
    };
  }
}

function init() {
  pick(".pick", "side", (v) => { mySide = v; });
  pick(".lvl", "lv", (v) => { level = v; });

  for (const b of document.querySelectorAll(".mode")) {
    b.onclick = () => {
      const m = b.dataset.mode;
      if (m === "online") createRoom();
      else startLocal(m);
    };
  }

  $("btn-quit").onclick = goHome;
  $("btn-leave").onclick = goHome;
  $("btn-lobby-bot").onclick = () => send({ t: "add_bot" });

  loadSprites();

  // 链接里带房间码就直接进
  const room = new URLSearchParams(location.search).get("room");
  if (room) { mode = "online"; connect(room); }
}

async function createRoom() {
  mode = "online";
  try {
    const res = await fetch("/api/create", { method: "POST", body: JSON.stringify({ token }) });
    if (!res.ok) throw new Error("开房失败,稍后再试");
    const { code: c } = await res.json();
    connect(c);
  } catch (e) {
    toast(e.message);
    mode = null;
  }
}

// 画布按容器宽度适配(内部分辨率固定 960×540,CSS 负责缩放)
$("stage").width = VIEW.w;
$("stage").height = VIEW.h;

init();
