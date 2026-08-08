// 川麻前端:界面状态机 + WebSocket。服务端权威,这里只展示和发动作。
// 收到的永远是**按座位裁剪过**的视图(见 shared/view.js),别人的手牌根本不在数据里。
import { tileSvg, backSvg, tileName, loadTileArt } from "./tileface.js?v=3";
import { SUITS } from "./shared/tiles.js?v=2";
import { sfx, unlock, toggleMusic } from "./sfx.js?v=2";
import * as fx from "./fx.js?v=1";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const token = (() => {
  let t = localStorage.getItem("majiang-token");
  if (!t) { t = crypto.randomUUID(); localStorage.setItem("majiang-token", t); }
  return t;
})();

let ws = null, code = null, mySeat = -1, isHost = false;
let V = null, prevV = null, L = null, joined = false, leaving = false;
let sel = -1;                 // 选中的手牌
let swapPick = [];            // 换三张选中的

const show = (id) => { for (const s of ["home", "lobby", "table"]) $(s).classList.toggle("hidden", s !== id); };
const nickVal = () => $("nick").value.trim().slice(0, 10) || "无名";

let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2400);
}

// ---------- 连接 ----------

function connect(c) {
  code = c.toUpperCase(); leaving = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${code}`);
  ws.onopen = () => send({ t: "join", token, nick: nickVal() });
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  ws.onclose = () => {
    if (leaving || !joined) return;
    toast("断线了,正在重连…");
    setTimeout(() => { if (!leaving) connect(code); }, 1400);
  };
}
const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };

function onMsg(m) {
  if (m.t === "joined") {
    joined = true; mySeat = m.seat; isHost = m.host;
    localStorage.setItem("majiang-nick", nickVal());
    history.replaceState(null, "", "?room=" + m.code);
    $("lobby-code").textContent = m.code;
    return;
  }
  if (m.t === "err") {
    if (!joined) { $("home-err").textContent = m.msg; leaving = true; try { ws?.close(); } catch {} show("home"); }
    else toast(m.msg);
    return;
  }
  if (m.t === "lobby") { L = m.l; V = null; renderLobby(); show("lobby"); return; }
  if (m.t === "state") {
    const before = V;
    V = m.v;
    renderTable(); show("table");
    runEffects(before, V);          // 先渲染再放特效:飞牌需要新 DOM 当落点
    return;
  }
}

// ---------- 等人 ----------

function renderLobby() {
  $("lobby-seats").innerHTML = L.seats.map((s, i) => `<li>
      <b>${esc(s.nick)}</b>${i === mySeat ? "(你)" : ""}
      ${s.bot ? '<span class="tag">🀄 机器人</span>' : ""}
      ${s.connected ? "" : '<span class="tag">掉线</span>'}
    </li>`).join("") + Array.from({ length: 4 - L.seats.length },
      () => '<li style="opacity:.45">空位…</li>').join("");
  $("host-panel").classList.toggle("hidden", !isHost);
  $("btn-addbot").disabled = L.seats.length >= 4;
  $("btn-start").disabled = L.seats.length !== 4;
  $("lobby-wait").textContent = L.seats.length < 4
    ? `还差 ${4 - L.seats.length} 个人(可以加机器人凑)`
    : (isHost ? "人齐了,开局吧" : "等房主开局…");
}

// ---------- 牌桌 ----------

const T = (t, o) => `<span class="tile ${o?.cls ?? ""}" data-t="${t}">${tileSvg(t, o)}</span>`;
const B = (w) => `<span class="tile static">${backSvg({ w })}</span>`;
const rel = (i) => (i - mySeat + 4) % 4;      // 0 自己 1 下家 2 对家 3 上家

function renderTable() {
  const v = V;
  // 三个对家
  for (const s of v.seats) {
    const r = rel(s.seat);
    if (r === 0) continue;
    const box = $("opp-" + r);
    const turn = v.turn === s.seat && v.phase === "play" && !s.won;
    const w = r === 2 ? 22 : 18;
    box.innerHTML = `
      <div class="who ${turn ? "turn" : ""} ${s.won ? "won" : ""}">
        ${esc(s.nick ?? "?")}${s.bot ? " 🀄" : ""}
        ${s.lack >= 0 ? ` · 缺${SUITS[s.lack]}` : ""}
        · ${s.score >= 0 ? "+" : ""}${s.score}
        ${s.won ? " · 已胡" : ""}${s.connected ? "" : " · 掉线"}
      </div>
      <div class="backs">${Array.from({ length: s.handCount }, () => B(w)).join("")}</div>
      ${s.melds.length ? `<div class="melds">${s.melds.map((m) => meldHtml(m, w)).join("")}</div>` : ""}`;
  }

  // 中间
  $("wall-info").textContent = v.wallLeft;
  $("banner").textContent = bannerText(v);
  $("banner").className = isMyTurn(v) ? "mine" : "";
  // 四家弃牌都摆中央,按相对座位放到上/下/左/右四片
  const lastDiscarder = v.seats.reduce((a, s) => s.discards.length ? s : a, null);
  for (const s of v.seats) {
    const zone = $("rz-" + rel(s.seat));
    if (!zone) continue;
    const w = rel(s.seat) === 0 ? 25 : 22;
    zone.innerHTML = s.discards.map((t, i) => T(t, {
      w, cls: "static" + (s === lastDiscarder && i === s.discards.length - 1 ? " just" : ""),
    })).join("");
  }

  // 自己
  renderMyHand(v);
  renderActs(v);
  renderPhasePanel(v);

  $("log").innerHTML = (v.log ?? []).slice(-8).map((l) => `<div>${esc(prettyLog(l, v))}</div>`).join("");
  $("log").scrollTop = $("log").scrollHeight;

  if (v.phase === "over" && v.result) showResult(v);
}

function meldHtml(m, w) {
  const n = m.kind === "peng" ? 3 : 4;
  const dim = m.kind === "an";     // 暗杠盖着
  return `<span class="meld">${Array.from({ length: n }, (_, i) =>
    dim && i < 2 ? B(w) : T(m.tile, { w, cls: "static" })).join("")}</span>`;
}

function isMyTurn(v) {
  if (v.phase === "play") return (v.pending && v.pending.mine) || (!v.pending && v.turn === mySeat);
  if (v.phase === "lack") return v.lack < 0;
  if (v.phase === "swap") return !v.swapPicked;
  return false;
}

function bannerText(v) {
  if (v.phase === "lack") return v.lack < 0 ? "选一门定缺" : "等其他人定缺…";
  if (v.phase === "swap") return v.swapPicked ? "等其他人换牌…" : "选三张同花色换出去";
  if (v.phase === "over") return "本局结束";
  const me = v.seats[mySeat];
  if (me?.won) return "你已经胡了,看他们打完";
  if (v.pending) {
    if (v.pending.mine) return `${v.seats[v.pending.from].nick} 打了 ${tileName(v.pending.tile)} —— 要不要?`;
    return "等别人决定…";
  }
  if (v.turn === mySeat) {
    if (v.mustDiscardLack) return `该你了 —— 还有${SUITS[v.lack]}没打完,先打${SUITS[v.lack]}`;
    return v.ting?.length ? `该你了 · 听 ${v.ting.map(tileName).join(" ")}` : "该你了";
  }
  return `等 ${v.seats[v.turn]?.nick ?? ""} 出牌`;
}

function renderMyHand(v) {
  const me = v.seats[mySeat];
  $("my-melds").innerHTML = (me?.melds ?? []).map((m) => meldHtml(m, 30)).join("");

  const canDiscard = v.actions?.includes("discard") && !v.pending;
  const tiles = [];
  for (let t = 0; t < 27; t++) for (let k = 0; k < v.hand[t]; k++) tiles.push(t);
  // 刚摸的那张单独摆到最右,跟手牌隔开
  const drawn = v.lastDrawn;
  let drawnUsed = false;
  const order = tiles.filter((t) => {
    if (t === drawn && !drawnUsed) { drawnUsed = true; return false; }
    return true;
  });

  const render = (t, extra) => {
    const lackBlock = v.mustDiscardLack && (t / 9 | 0) !== v.lack;
    const cls = [
      canDiscard ? "" : "static",
      lackBlock ? "dead" : "",
      sel === t ? "sel" : "",
      canDiscard && !lackBlock && v.discardHints?.[t] ? "hintok" : "",
      extra ?? "",
    ].join(" ");
    return T(t, { w: 44, cls });
  };
  $("my-hand").innerHTML = order.map((t) => render(t)).join("")
    + (drawnUsed ? render(drawn, "drawn") : "");

  for (const el of $("my-hand").querySelectorAll(".tile")) {
    el.onclick = () => {
      const t = +el.dataset.t;
      if (!canDiscard) return;
      if (v.mustDiscardLack && (t / 9 | 0) !== v.lack) { toast(`先把${SUITS[v.lack]}打完`); return; }
      unlock();
      if (sel === t) { send({ t: "discard", tile: t }); sel = -1; }
      else { sel = t; sfx.select(); renderTable(); }
    };
  }

  const hints = v.ting?.length ? `听:${v.ting.map(tileName).join(" ")}` : "";
  $("my-info").innerHTML = [
    me ? `<span>${esc(me.nick ?? "你")} · ${me.score >= 0 ? "+" : ""}${me.score}</span>` : "",
    v.lack >= 0 ? `<span>定缺 ${SUITS[v.lack]}</span>` : "",
    hints ? `<span style="color:#7fd39a">${hints}</span>` : "",
    canDiscard ? `<span>点一下选中,再点一下打出</span>` : "",
  ].filter(Boolean).join("");
}

function renderActs(v) {
  const box = $("acts");
  const acts = [];
  if (v.pending?.mine) {
    for (const a of v.actions) {
      if (a === "hu") acts.push(["hu", "胡", "hu"]);
      else if (a === "gang") acts.push(["gang", "杠", ""]);
      else if (a === "peng") acts.push(["peng", "碰", ""]);
      else if (a === "pass") acts.push(["pass", "过", "pass"]);
    }
  } else if (!v.pending && v.turn === mySeat && v.phase === "play") {
    for (const a of v.actions) {
      if (a === "zimo") acts.push(["zimo", "自摸", "hu"]);
      else if (a.startsWith("angang:")) acts.push([a, "暗杠 " + tileName(+a.split(":")[1]), ""]);
      else if (a.startsWith("bugang:")) acts.push([a, "补杠 " + tileName(+a.split(":")[1]), ""]);
    }
  }
  box.innerHTML = acts.map(([k, label, cls]) => `<button data-a="${k}" class="${cls}">${label}</button>`).join("");
  for (const b of box.querySelectorAll("button")) {
    b.onclick = () => {
      unlock();
      const a = b.dataset.a;
      if (a === "zimo") send({ t: "zimo" });
      else if (a.startsWith("angang:")) send({ t: "angang", tile: +a.split(":")[1] });
      else if (a.startsWith("bugang:")) send({ t: "bugang", tile: +a.split(":")[1] });
      else send({ t: "respond", act: a });
    };
  }
}

function renderPhasePanel(v) {
  const p = $("phase-panel");
  if (v.phase === "lack" && v.lack < 0) {
    p.classList.remove("hidden");
    const counts = [0, 0, 0];
    for (let t = 0; t < 27; t++) counts[(t / 9) | 0] += v.hand[t];
    p.innerHTML = `<div class="panel-box">
      <h3>定缺</h3>
      <p class="hint">选一门不要的花色。这一门的牌必须先打完,而且胡牌时手里不能留。</p>
      <div class="suit-pick">${SUITS.map((s, i) =>
        `<button data-s="${i}">${s}<br><span style="font-size:12px">${counts[i]} 张</span></button>`).join("")}</div>
    </div>`;
    for (const b of p.querySelectorAll("[data-s]")) {
      b.onclick = () => { unlock(); send({ t: "lack", suit: +b.dataset.s }); };
    }
    return;
  }
  if (v.phase === "swap" && !v.swapPicked) {
    p.classList.remove("hidden");
    const tiles = [];
    for (let t = 0; t < 27; t++) for (let k = 0; k < v.hand[t]; k++) tiles.push(t);
    const q = swapPick.length ? (swapPick[0] / 9 | 0) : -1;
    p.innerHTML = `<div class="panel-box">
      <h3>换三张</h3>
      <p class="hint">选三张**同花色**的牌换出去(${["顺时针", "逆时针", "对家"][v.swapDir]})。已选 ${swapPick.length}/3</p>
      <div class="swap-hand">${tiles.map((t, i) => {
        const picked = swapPick.filter((x) => x === t).length;
        const before = tiles.slice(0, i).filter((x) => x === t).length;
        const on = before < picked;
        const dead = q >= 0 && (t / 9 | 0) !== q && !on;
        return `<span class="tile ${on ? "sel" : ""} ${dead ? "dead" : ""}" data-t="${t}" data-i="${i}">${tileSvg(t, { w: 38 })}</span>`;
      }).join("")}</div>
      <button id="swap-go" class="primary big" ${swapPick.length === 3 ? "" : "disabled"}>换出去</button>
    </div>`;
    for (const el of p.querySelectorAll(".tile")) {
      el.onclick = () => {
        const t = +el.dataset.t;
        // ⚠️ 取消选中要看**点的是不是已选中的那一张**,不能拿牌值去 indexOf ——
        // 手里有三张五万时,点第二张会 indexOf 到第一张、把它取消掉,
        // 结果永远凑不满三张。而换三张时手上正好有刻子是很常见的事。
        if (el.classList.contains("sel")) swapPick.splice(swapPick.indexOf(t), 1);
        else {
          if (swapPick.length >= 3) return;
          if (swapPick.length && (swapPick[0] / 9 | 0) !== (t / 9 | 0)) { toast("三张要同花色"); return; }
          swapPick.push(t);
        }
        sfx.select();
        renderPhasePanel(v);
      };
    }
    $("swap-go").onclick = () => { unlock(); send({ t: "swap", tiles: swapPick.slice() }); swapPick = []; };
    return;
  }
  p.classList.add("hidden");
}

// ---------- 特效 + 音效 ----------
// 全部由「新旧视图对比」驱动。**不解析服务端日志文本** —— 日志是给人看的字符串,
// 措辞一改特效就全哑了,这是余一那边早就踩过的坑。

const MELD_WORD = { peng: "碰", ming: "杠", an: "暗杠", bu: "补杠" };

function runEffects(prev, cur) {
  for (const e of fx.diff(prev, cur, mySeat)) {
    switch (e.t) {
      case "discard": {
        const from = fx.seatAnchor(rel(e.seat));
        fx.flyTile(e.tile, from, $("rz-" + rel(e.seat)), { spin: e.seat !== mySeat });
        sfx.discard();
        break;
      }
      case "meld": {
        sfx[e.kind === "peng" ? "peng" : "gang"]();
        fx.shout(MELD_WORD[e.kind] ?? "碰", {
          color: e.kind === "peng" ? "#ffd95e" : "#7fd8ff",
          sub: cur.seats[e.seat]?.nick ?? "",
        });
        fx.pulse(seatPlate(e.seat), "hit");
        break;
      }
      case "win": {
        sfx.hu();
        const f = e.fan;
        fx.shout(f?.zimo ? "自 摸" : "胡", {
          color: "#ff8f5e",
          sub: f ? `${f.names.join("+")} ×${f.mult}` : "",
          ms: 1500,
        });
        fx.pulse(seatPlate(e.seat), "glow", 1400);
        if (e.seat === mySeat) fx.buzz([28, 60, 28, 60, 90]);
        break;
      }
      case "score":
        fx.floatScore(seatPlate(e.seat), e.delta);
        break;
      case "myturn":
        sfx.turn();
        fx.pulse($("mine"), "myturn");
        fx.buzz(24);
        break;
      case "claim":
        sfx.turn();
        fx.pulse($("acts"), "pop");
        fx.buzz([20, 50, 20]);
        break;
      case "draw":
        sfx.draw();
        break;
      case "lack":
        fx.shout("缺 " + SUITS[e.suit], { color: "#ffd95e", ms: 900 });
        break;
      case "phase":
        if (e.to === "play" && e.from === "swap") { sfx.shuffle(); fx.shout("换三张", { ms: 900 }); }
        break;
    }
  }
}

const seatPlate = (i) => rel(i) === 0
  ? $("my-info")
  : $("opp-" + rel(i))?.querySelector(".who");

function prettyLog(line, v) {
  return line.replace(/^(\d) /, (_, d) => (v.seats[+d]?.nick ?? d) + " ")
             .replace(/^(\d)/, (d) => v.seats[+d]?.nick ?? d);
}

// ---------- 结算 ----------

let resultShown = false;
function showResult(v) {
  if (resultShown) return;
  resultShown = true;
  const r = v.result;
  const mine = v.seats[mySeat];
  (mine?.score ?? 0) >= 0 ? sfx.win() : sfx.lose();

  const rows = v.seats.map((s) => {
    const f = s.winFan;
    const detail = f ? `${f.names.join("+")} ×${f.mult}${f.zimo ? "(自摸)" : ""}`
                     : (r.how === "流局" ? "没胡" : "");
    return `<div class="score-row">
      <span>${esc(s.nick ?? s.seat)}${s.seat === mySeat ? "(你)" : ""} <span class="hint">${esc(detail)}</span></span>
      <span class="${s.score >= 0 ? "pos" : "neg"}">${s.score >= 0 ? "+" : ""}${s.score}</span>
    </div>`;
  }).join("");

  $("modal-layer").classList.remove("hidden");
  $("modal").innerHTML = `<h2>${r.how === "流局" ? "流局" : "本局结束"}</h2>
    <div>${rows}</div>
    <div class="row" style="justify-content:center">
      ${isHost ? '<button id="m-again" class="primary big">再来一局</button>' : '<span class="hint">等房主开下一局</span>'}
      <button id="m-home" class="linkish">离开</button>
    </div>`;
  if (isHost) $("m-again").onclick = () => { send({ t: "again" }); closeResult(); };
  $("m-home").onclick = goHome;
}
function closeResult() { resultShown = false; $("modal-layer").classList.add("hidden"); }

function goHome() {
  leaving = true; joined = false; V = null; L = null; mySeat = -1;
  closeResult();
  try { ws?.close(); } catch {}
  history.replaceState(null, "", location.pathname);
  show("home");
}

// ---------- 起步 ----------

async function createRoom() {
  if (!$("nick").value.trim()) { $("home-err").textContent = "先起个名号"; return; }
  $("btn-create").disabled = true;
  try {
    const res = await fetch("/api/create", { method: "POST", body: JSON.stringify({ hostToken: token }) });
    if (!res.ok) throw new Error("开桌失败,稍后再试");
    const { code: c } = await res.json();
    connect(c);
  } catch (e) { $("home-err").textContent = e.message; }
  finally { $("btn-create").disabled = false; }
}

function init() {
  $("nick").value = localStorage.getItem("majiang-nick") ?? "";
  $("btn-create").onclick = () => { unlock(); createRoom(); };
  $("btn-join").onclick = () => {
    unlock();
    const c = $("join-code").value.trim().toUpperCase();
    if (!$("nick").value.trim()) { $("home-err").textContent = "先起个名号"; return; }
    if (c.length !== 5) { $("home-err").textContent = "房间码是 5 位"; return; }
    connect(c);
  };
  $("btn-addbot").onclick = () => send({ t: "add_bot" });
  $("btn-start").onclick = () => { resultShown = false; send({ t: "start" }); };
  $("btn-leave").onclick = goHome;
  $("btn-quit").onclick = goHome;
  $("btn-music").onclick = () => {
    const on = toggleMusic();
    $("btn-music").classList.toggle("off", !on);
  };
  $("btn-music").classList.add("off");

  const room = new URLSearchParams(location.search).get("room");
  if (room) $("join-code").value = room.toUpperCase();
}

loadTileArt().then(() => { if (V) renderTable(); });
init();
