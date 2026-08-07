// 前端主逻辑:界面状态机 + WebSocket 客户端
// 服务端是权威;这里只做展示、可点位置的预计算和动作发送
import {
  RES, RES_KEYS, COSTS, DEV_INFO, PIECE_LIMIT,
  legalVillages, legalRoads, canPay, publicVP, getRates,
  TILE_VERTICES, buildingAt,
} from "./shared/rules.js";
import { initBoard, updatePieces, showHighlights, clearHighlights, flashTiles, markProduced } from "./render.js";

const $ = (id) => document.getElementById(id);
// 骰子点位:3×3 网格里亮哪些格
const PIP_MAP = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

let ws = null;
let G = null;          // 服务端下发的(按人裁剪过的)对局状态
let code = null;
let mode = null;       // 当前建造模式:road | village | city | null
let boardDrawn = false;
let joined = false;
let leaving = false;
let modalKind = null;

// 每个标签页一个身份令牌:刷新不掉线,同浏览器开多个标签页又能各当一个玩家
const token = (() => {
  let t = sessionStorage.getItem("dao-token");
  if (!t) {
    t = crypto.randomUUID();
    sessionStorage.setItem("dao-token", t);
  }
  return t;
})();

const nickVal = () => $("nick").value.trim().slice(0, 12);

// ---------- 屏幕切换与提示 ----------

function show(id) {
  for (const s of ["home", "lobby", "game"]) $(s).classList.toggle("hidden", s !== id);
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---------- 连接 ----------

function connect(c) {
  code = c.toUpperCase();
  leaving = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${code}`);
  ws.onopen = () => send({ t: "join", token, nick: nickVal() });
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => {
    if (leaving) return;
    if (!joined) return; // 加入失败的错误已单独提示
    toast("连接断开,正在重连…");
    setTimeout(() => { if (!leaving) connect(code); }, 1500);
  };
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function leave() {
  leaving = true;
  joined = false;
  G = null;
  boardDrawn = false;
  mode = null;
  closeModal();
  try { ws?.close(); } catch {}
  sessionStorage.removeItem("dao-room");
  history.replaceState(null, "", location.pathname);
  show("home");
}

function onMsg(m) {
  if (m.t === "joined") {
    joined = true;
    sessionStorage.setItem("dao-room", m.code);
    history.replaceState(null, "", "?room=" + m.code);
    return;
  }
  if (m.t === "err") {
    if (!joined) {
      $("home-err").textContent = m.msg;
      leaving = true;
      try { ws?.close(); } catch {}
      show("home");
    } else {
      toast(m.msg);
    }
    return;
  }
  if (m.t === "state") {
    const prev = G;
    G = m.g;
    // 本回合从"未掷"变"已掷":播掷骰动画,渲染时先别把点数剧透出来
    const justRolled = !!(prev && prev.phase !== "lobby" && G.turn?.dice && prev.turn &&
      prev.turn.n === G.turn.n && !prev.turn.rolled && G.turn.rolled);
    if (justRolled) diceAnimating = true;
    render();
    if (justRolled) {
      const [d1, d2] = G.turn.dice;
      rollBoardDice(d1, d2, () => {
        const sum = d1 + d2;
        if (sum !== 7 && G?.board) {
          flashTiles(G.board.tiles
            .filter((t) => t.num === sum && t.k !== G.board.robber)
            .map((t) => t.k));
        }
        updateProducedFx();
      });
    }
    animateGains(prev, G, justRolled ? 1100 : 0);
  }
}

// ---------- 骰子(盘面大骰子)与产出特效 ----------

let diceAnimating = false;
let diceTimer = null;

function setDie(el, v) {
  el.innerHTML = [...Array(9)]
    .map((_, i) => `<i class="${PIP_MAP[v].includes(i) ? "on" : ""}"></i>`)
    .join("");
}

function showBoardDice(d1, d2) {
  $("board-dice").classList.remove("hidden");
  setDie($("bdie1"), d1);
  setDie($("bdie2"), d2);
  const sum = $("bdice-sum");
  sum.textContent = d1 + d2;
  sum.classList.toggle("seven", d1 + d2 === 7);
}

function rollBoardDice(d1, d2, onDone) {
  const bd = $("board-dice");
  bd.classList.remove("hidden", "settle");
  bd.classList.add("rolling");
  $("bdice-sum").textContent = "?";
  $("bdice-sum").classList.remove("seven");
  clearInterval(diceTimer);
  const t0 = Date.now();
  diceTimer = setInterval(() => {
    if (Date.now() - t0 > 850) {
      clearInterval(diceTimer);
      bd.classList.remove("rolling");
      bd.classList.add("settle");
      showBoardDice(d1, d2);
      diceAnimating = false;
      onDone?.();
      return;
    }
    setDie($("bdie1"), 1 + Math.floor(Math.random() * 6));
    setDie($("bdie2"), 1 + Math.floor(Math.random() * 6));
  }, 80);
}

// 本轮产出的地格保留持续的金边呼吸特效,下一次掷骰前一直亮着
function updateProducedFx() {
  if (!G || G.phase !== "play" || !G.turn?.rolled || !G.turn.dice) { markProduced([]); return; }
  const sum = G.turn.dice[0] + G.turn.dice[1];
  if (sum === 7) { markProduced([]); return; }
  markProduced(G.board.tiles
    .filter((t) => t.num === sum && t.k !== G.board.robber)
    .map((t) => t.k));
}

// 自动掷骰:轮到自己且未掷时,短暂停顿后自动掷(留出掷前打发展卡的窗口)
let autoRollTimer = null;
let autoRollSentFor = -1;

function armAutoRoll() {
  const should = G?.phase === "play" && myTurn() && !G.turn.rolled && !G.turn.pending && G.winner === null;
  if (!should) {
    clearTimeout(autoRollTimer);
    autoRollTimer = null;
    return;
  }
  if (autoRollTimer || autoRollSentFor === G.turn.n) return;
  autoRollTimer = setTimeout(function fire() {
    autoRollTimer = null;
    if (!(G?.phase === "play" && myTurn() && !G.turn.rolled && !G.turn.pending)) return;
    if (modalKind) { autoRollTimer = setTimeout(fire, 800); return; } // 弹窗开着先不掷
    autoRollSentFor = G.turn.n;
    send({ t: "roll" });
  }, 1500);
}

// 自己的手牌涨了:芯片弹跳 + 飘"+n";别人的手牌数涨了:计数弹一下
function animateGains(prev, g, delay) {
  if (!prev || prev.phase === "lobby" || g.phase === "lobby") return;
  if (prev.you !== g.you || g.you < 0) return;
  const pm = prev.seats[g.you]?.res, nm = g.seats[g.you]?.res;
  const gains = [];
  if (pm && nm) {
    for (const k of RES_KEYS) if (nm[k] > pm[k]) gains.push([k, nm[k] - pm[k]]);
  }
  const bumps = [];
  g.seats.forEach((s, i) => {
    if (i !== g.you && prev.seats[i] && s.resCount > prev.seats[i].resCount) bumps.push(i);
  });
  if (!gains.length && !bumps.length) return;
  setTimeout(() => {
    for (const [k, n] of gains) {
      const chip = document.querySelector(`#hand .chip[data-res="${k}"]`);
      if (!chip) continue;
      chip.classList.remove("empty");
      chip.classList.add("gain-pop");
      const f = document.createElement("span");
      f.className = "gain-float";
      f.textContent = "+" + n;
      chip.appendChild(f);
      setTimeout(() => { chip.classList.remove("gain-pop"); f.remove(); }, 950);
    }
    for (const i of bumps) {
      const st = document.querySelector(`#players .player[data-seat="${i}"] .pstat`);
      if (st) { st.classList.add("bump"); setTimeout(() => st.classList.remove("bump"), 600); }
    }
  }, delay);
}

// ---------- 总渲染 ----------

function render() {
  if (!G) return;
  if (G.phase === "lobby") {
    renderLobby();
    show("lobby");
    return;
  }
  show("game");
  if (!boardDrawn) {
    initBoard($("board"), G.board);
    boardDrawn = true;
  }
  updatePieces(G);
  renderBanner();
  renderPlayers();
  renderHand();
  renderDevs();
  renderBuildPanel();
  renderTradePanel();
  renderActions();
  renderLog();
  updateHighlights();
  if (!diceAnimating) updateProducedFx();
  armAutoRoll();
  maybeModals();
}

function renderLobby() {
  $("lobby-code").textContent = G.code;
  const isHost = G.you === G.hostSeat;
  $("lobby-players").innerHTML = G.seats.map((s, i) => `
    <li>
      <span class="dot" style="background:${s.color}"></span>
      <b>${esc(s.nick)}</b>${i === G.you ? "(你)" : ""}
      ${i === G.hostSeat ? '<span class="tag">房主</span>' : ""}
      ${s.isBot ? '<span class="tag bot">🤖</span>' : ""}
      ${s.isBot && isHost ? `<button class="bot-rm" data-seat="${i}">移除</button>` : ""}
      ${s.isBot ? "" : `<span class="conn ${s.connected ? "on" : ""}"></span>`}
    </li>`).join("");
  for (const btn of $("lobby-players").querySelectorAll(".bot-rm")) {
    btn.onclick = () => send({ t: "remove_bot", seat: +btn.dataset.seat });
  }
  $("host-panel").classList.toggle("hidden", !isHost);
  $("btn-addbot").disabled = G.seats.length >= 4;
  $("btn-start").disabled = G.seats.length < 2;
  $("lobby-wait").textContent = isHost
    ? (G.seats.length < 2 ? "至少 2 人才能开始(可以添加机器人陪练)" : "")
    : "等待房主开始游戏…";
}

const myTurn = () => G.phase === "play" && G.turn.seat === G.you;

function renderBanner() {
  const b = $("banner");
  let text = "", cls = "";
  if (G.phase === "setup") {
    const st = G.setup;
    const cur = st.seq[st.idx];
    const what = st.need === "village" ? "村庄" : "道路";
    if (cur === G.you) { text = `开局放置:轮到你放${what},点击棋盘上的高亮位置`; cls = "mine"; }
    else text = `开局放置:等待 ${G.seats[cur].nick} 放${what}`;
  } else if (G.phase === "play") {
    const t = G.turn;
    if (t.pending?.t === "discard") {
      const names = Object.keys(t.pending.need).map((i) => G.seats[+i].nick).join("、");
      text = `掷出了 7!等待弃牌:${names}`;
    } else if (t.pending?.t === "robber") {
      if (t.seat === G.you) { text = "点击棋盘任意地格,移动强盗"; cls = "mine"; }
      else text = `等待 ${G.seats[t.seat].nick} 移动强盗`;
    } else if (t.seat === G.you) {
      cls = "mine";
      if (t.freeRoads > 0) text = `「筑路」生效:还可免费修 ${t.freeRoads} 条路,点击高亮棱边`;
      else if (!t.rolled) text = "你的回合,自动掷骰中…(想抢先打发展卡就趁现在)";
      else text = "行动阶段:建造、买卡、交易或兑换,完事点「结束回合」";
    } else {
      text = `${G.seats[t.seat].nick} 的回合`;
    }
  } else if (G.phase === "ended") {
    text = `🏆 ${G.seats[G.winner].nick} 获胜!`;
    cls = "mine";
  }
  b.textContent = text;
  b.className = cls;

  if (!diceAnimating) {
    if (G.phase !== "lobby" && G.turn?.dice) showBoardDice(G.turn.dice[0], G.turn.dice[1]);
    else $("board-dice").classList.add("hidden");
  }
}

function renderPlayers() {
  $("players").innerHTML = G.seats.map((s, i) => {
    const active = (G.phase === "play" && G.turn.seat === i) ||
      (G.phase === "setup" && G.setup.seq[G.setup.idx] === i);
    let vp = String(publicVP(G, i));
    if (i === G.you && s.devs) {
      const hidden = s.devs.filter((d) => d.c === "vp").length;
      if (hidden > 0) vp = `${publicVP(G, i)}+${hidden}`;
    }
    return `
    <div class="player ${active ? "active" : ""}" data-seat="${i}">
      <span class="dot" style="background:${s.color}"></span>
      <span class="pname">${esc(s.nick)}${i === G.you ? "(你)" : ""}</span>
      ${s.isBot ? '<span title="机器人">🤖</span>' : `<span class="conn ${s.connected ? "on" : ""}"></span>`}
      <span class="badges">
        ${G.longest.holder === i ? `<span title="最长路 ${G.longest.len} 段">🛤️</span>` : ""}
        ${G.army.holder === i ? `<span title="最大军团">⚔️</span>` : ""}
        ${s.knights > 0 ? `<span class="mini">⚔${s.knights}</span>` : ""}
      </span>
      <span class="pstat" title="手牌">🂠${s.resCount}</span>
      <span class="pstat" title="发展卡">📜${s.devCount}</span>
      <span class="pvp" title="分数">${vp}分</span>
    </div>`;
  }).join("");
}

function renderHand() {
  if (G.you < 0) { $("hand").innerHTML = ""; return; }
  const me = G.seats[G.you];
  if (!me.res) { $("hand").innerHTML = ""; return; }
  $("hand").innerHTML = `
    <div class="hand-row">
      ${RES_KEYS.map((k) => `
        <span class="chip ${me.res[k] ? "" : "empty"}" data-res="${k}">
          <i style="background:${RES[k].color}"></i>${RES[k].name} <b>${me.res[k]}</b>
        </span>`).join("")}
    </div>
    <div class="bank-row">银行:${RES_KEYS.map((k) => `${RES[k].name}${G.bank?.[k] ?? "-"}`).join(" · ")} · 发展卡${G.deckCount}</div>`;
}

function devPlayable(card) {
  if (G.phase !== "play" || !myTurn() || G.turn.pending || G.turn.devPlayed) return false;
  if (card === "vp") return false;
  return G.seats[G.you].devs.some((d) => d.c === card && d.t < G.turn.n);
}

function renderDevs() {
  const el = $("devs");
  if (G.you < 0 || !G.seats[G.you].devs?.length) { el.innerHTML = ""; return; }
  const groups = {};
  for (const d of G.seats[G.you].devs) groups[d.c] = (groups[d.c] ?? 0) + 1;
  el.innerHTML = "<div class='devs-title'>我的发展卡(点击打出)</div>" +
    Object.entries(groups).map(([c, n]) => `
      <button class="dev-card" data-card="${c}" ${devPlayable(c) ? "" : "disabled"}
        title="${DEV_INFO[c].desc}">${DEV_INFO[c].name} ×${n}</button>`).join("");
  for (const btn of el.querySelectorAll(".dev-card")) {
    btn.onclick = () => playDev(btn.dataset.card);
  }
}

// 建造面板:每项显示造价资源点(已有实心/缺少空心)、缺口文字、剩余棋子
const BUILD_ITEMS = [
  { kind: "road", name: "道路", vp: "", cost: COSTS.road },
  { kind: "village", name: "村庄", vp: "1分", cost: COSTS.village },
  { kind: "city", name: "城邑", vp: "2分", cost: COSTS.city },
  { kind: "dev", name: "发展卡", vp: "", cost: COSTS.dev },
];

function renderBuildPanel() {
  const panel = $("build-panel");
  if (G.phase !== "play" || G.you < 0) { panel.innerHTML = ""; return; }
  const t = G.turn;
  const me = G.seats[G.you];
  const res = me.res ?? {};
  const ok = myTurn() && t.rolled && !t.pending;

  panel.innerHTML = BUILD_ITEMS.map((it) => {
    const pips = Object.entries(it.cost).map(([k, n]) => {
      let h = "";
      for (let i = 0; i < n; i++) {
        h += `<i class="bpip ${(res[k] ?? 0) > i ? "have" : "lack"}" style="--c:${RES[k].color}" title="${RES[k].name}"></i>`;
      }
      return h;
    }).join("");
    const lack = Object.entries(it.cost)
      .filter(([k, n]) => (res[k] ?? 0) < n)
      .map(([k, n]) => `${RES[k].name}×${n - (res[k] ?? 0)}`);
    let left = "", enabled = false, status = "";
    if (it.kind === "road") {
      left = `余${PIECE_LIMIT.road - me.roads.length}`;
      const free = myTurn() && t.freeRoads > 0;
      enabled = free || (ok && canPay(res, it.cost) && me.roads.length < PIECE_LIMIT.road && legalRoads(G, G.you).length > 0);
      status = free ? `免费×${t.freeRoads}` : "";
    } else if (it.kind === "village") {
      left = `余${PIECE_LIMIT.village - me.villages.length}`;
      enabled = ok && canPay(res, it.cost) && me.villages.length < PIECE_LIMIT.village && legalVillages(G, G.you).length > 0;
    } else if (it.kind === "city") {
      left = `余${PIECE_LIMIT.city - me.cities.length}`;
      enabled = ok && canPay(res, it.cost) && me.villages.length > 0 && me.cities.length < PIECE_LIMIT.city;
    } else {
      left = `卡库${G.deckCount}`;
      enabled = ok && canPay(res, it.cost) && G.deckCount > 0;
    }
    if (!status) status = lack.length ? `差 ${lack.join("、")}` : (enabled ? "✓ 可造" : "");
    return `
      <button class="build-row ${mode === it.kind ? "active" : ""}" data-kind="${it.kind}" ${enabled ? "" : "disabled"}>
        <span class="b-name">${it.name}${it.vp ? `<em>${it.vp}</em>` : ""}</span>
        <span class="b-pips">${pips}</span>
        <span class="b-status ${lack.length && !status.startsWith("免费") ? "lackText" : "okText"}">${status}</span>
        <span class="b-left">${left}</span>
      </button>`;
  }).join("");

  for (const row of panel.querySelectorAll(".build-row")) {
    row.onclick = () => {
      const k = row.dataset.kind;
      if (k === "dev") { send({ t: "buy_dev" }); return; }
      mode = mode === k ? null : k;
      renderBuildPanel();
      updateHighlights();
    };
  }
}

// 交易提议面板:按身份给不同操作(发起人选人成交/撤回;被报价方同意/拒绝/还价)
function renderTradePanel() {
  const panel = $("trade-panel");
  const tr = G.phase === "play" ? G.turn?.trade : null;
  if (!tr) { panel.innerHTML = ""; return; }
  const chips = (map) => Object.entries(map).filter(([, n]) => n > 0)
    .map(([k, n]) => `<span class="chip small"><i style="background:${RES[k].color}"></i>${RES[k].name}×${n}</span>`)
    .join("");
  let controls = "";
  if (G.you === tr.by) {
    controls = (tr.accepted.length
      ? tr.accepted.map((i) => `<button class="tp-pick primary" data-seat="${i}">与 ${esc(G.seats[i].nick)} 成交</button>`).join("")
      : `<span class="tp-hint">等待其他玩家表态…</span>`)
      + `<button id="tp-cancel" class="linkish">撤回</button>`;
  } else if (tr.by === G.turn.seat) {
    const acc = tr.accepted.includes(G.you), dec = tr.declined.includes(G.you);
    controls = `
      <button id="tp-accept" class="primary" ${acc ? "disabled" : ""}>${acc ? "已同意" : "同意成交"}</button>
      <button id="tp-decline" ${dec ? "disabled" : ""}>${dec ? "已拒绝" : "拒绝"}</button>
      <button id="tp-counter">还价</button>`;
  } else if (G.you === G.turn.seat) {
    controls = `<button id="tp-accept" class="primary">接受还价</button>`;
  }
  panel.innerHTML = `
    <div class="tp-offer">🤝 ${esc(G.seats[tr.by].nick)} 出 ${chips(tr.give)} <b>求</b> ${chips(tr.want)}</div>
    <div class="tp-controls">${controls}</div>`;
  panel.querySelector("#tp-cancel")?.addEventListener("click", () => send({ t: "offer_cancel" }));
  panel.querySelector("#tp-accept")?.addEventListener("click", () => send({ t: "offer_accept" }));
  panel.querySelector("#tp-decline")?.addEventListener("click", () => send({ t: "offer_decline" }));
  panel.querySelector("#tp-counter")?.addEventListener("click", openOfferModal);
  for (const b of panel.querySelectorAll(".tp-pick")) {
    b.onclick = () => send({ t: "offer_pick", seat: +b.dataset.seat });
  }
}

function renderActions() {
  const playing = G.phase === "play";
  $("actions").classList.toggle("hidden", !playing);
  if (!playing) return;
  const t = G.turn;
  const me = G.seats[G.you];
  const ok = myTurn() && t.rolled && !t.pending;
  const canCounter = !myTurn() && t.rolled && !t.pending && G.you >= 0;
  $("btn-offer").disabled = !(ok || canCounter);
  $("btn-offer").textContent = myTurn() || G.you < 0 ? "发起交易" : `向 ${G.seats[t.seat].nick} 提议`;
  const rates = getRates(G, G.you);
  $("btn-trade").disabled = !(ok && RES_KEYS.some((k) => (me?.res?.[k] ?? 0) >= rates[k]));
  $("btn-end").disabled = !ok;
}

function renderLog() {
  const el = $("log");
  el.innerHTML = (G.log ?? []).slice(-40).map((l) => `<div>${esc(l)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 高亮与点击 ----------

function updateHighlights() {
  clearHighlights();
  if (!G || G.you < 0) return;

  if (G.phase === "setup") {
    const st = G.setup;
    if (st.seq[st.idx] !== G.you) return;
    if (st.need === "village") {
      showHighlights(legalVillages(G, G.you), "vertex", (id) => send({ t: "place", id }));
    } else {
      showHighlights(legalRoads(G, G.you), "edge", (id) => send({ t: "place", id }));
    }
    return;
  }
  if (G.phase !== "play") return;
  const t = G.turn;

  if (t.pending?.t === "robber" && t.seat === G.you) {
    const tiles = G.board.tiles.filter((x) => x.k !== G.board.robber).map((x) => x.k);
    showHighlights(tiles, "tile", pickRobberTile);
    return;
  }
  if (!myTurn() || t.pending) { mode = null; return; }
  if (t.freeRoads > 0) mode = "road";
  if (!mode) return;
  if (!t.rolled && !(mode === "road" && t.freeRoads > 0)) return;

  if (mode === "road") {
    showHighlights(legalRoads(G, G.you), "edge", (id) => send({ t: "build", kind: "road", id }));
  } else if (mode === "village") {
    showHighlights(legalVillages(G, G.you), "vertex", (id) => send({ t: "build", kind: "village", id }));
  } else if (mode === "city") {
    showHighlights(G.seats[G.you].villages, "vertex", (id) => send({ t: "build", kind: "city", id }));
  }
}

function pickRobberTile(tk) {
  const victims = [];
  for (const vid of TILE_VERTICES.get(tk)) {
    const b = buildingAt(G, vid);
    if (b && b.seat !== G.you && G.seats[b.seat].resCount > 0 && !victims.includes(b.seat)) {
      victims.push(b.seat);
    }
  }
  if (victims.length === 0) send({ t: "robber", tile: tk, victim: null });
  else if (victims.length === 1) send({ t: "robber", tile: tk, victim: victims[0] });
  else openVictimModal(tk, victims);
}

function playDev(card) {
  if (card === "monopoly") return openResPickModal("垄断:选择要收走的资源", (k) => {
    send({ t: "play_dev", card, res: k });
  });
  if (card === "invent") return openInventModal();
  send({ t: "play_dev", card }); // knight / roads
}

// ---------- 弹窗 ----------

function openModal(kind, html) {
  modalKind = kind;
  $("modal").innerHTML = html;
  $("modal-layer").classList.remove("hidden");
}

function closeModal() {
  modalKind = null;
  $("modal-layer").classList.add("hidden");
  $("modal").innerHTML = "";
}

function maybeModals() {
  const t = G.turn;
  const needMine = t?.pending?.t === "discard" && t.pending.need[G.you] != null;
  if (needMine && modalKind !== "discard") openDiscardModal(t.pending.need[G.you]);
  if (!needMine && modalKind === "discard") closeModal();
  if (G.phase === "ended" && modalKind !== "result") openResultModal();
}

function openDiscardModal(need) {
  const me = G.seats[G.you];
  const sel = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  openModal("discard", `
    <h3>掷出了 7:请弃掉 ${need} 张手牌</h3>
    ${RES_KEYS.filter((k) => me.res[k] > 0).map((k) => `
      <div class="pick-row" data-res="${k}">
        <span class="chip"><i style="background:${RES[k].color}"></i>${RES[k].name}(有 ${me.res[k]})</span>
        <span class="stepper">
          <button class="minus">−</button><b class="n">0</b><button class="plus">＋</button>
        </span>
      </div>`).join("")}
    <p class="modal-status"><span id="disc-sum">0</span> / ${need}</p>
    <button id="disc-ok" class="primary big" disabled>确认弃牌</button>`);
  const refresh = () => {
    let sum = 0;
    for (const row of $("modal").querySelectorAll(".pick-row")) {
      const k = row.dataset.res;
      row.querySelector(".n").textContent = sel[k];
      sum += sel[k];
    }
    $("disc-sum").textContent = sum;
    $("disc-ok").disabled = sum !== need;
  };
  for (const row of $("modal").querySelectorAll(".pick-row")) {
    const k = row.dataset.res;
    row.querySelector(".plus").onclick = () => { if (sel[k] < me.res[k]) { sel[k]++; refresh(); } };
    row.querySelector(".minus").onclick = () => { if (sel[k] > 0) { sel[k]--; refresh(); } };
  }
  $("disc-ok").onclick = () => { send({ t: "discard", give: sel }); closeModal(); };
}

function openVictimModal(tile, victims) {
  openModal("victim", `
    <h3>选择偷取对象</h3>
    ${victims.map((i) => `
      <button class="victim big" data-seat="${i}">
        <span class="dot" style="background:${G.seats[i].color}"></span>
        ${esc(G.seats[i].nick)}(${G.seats[i].resCount} 张手牌)
      </button>`).join("")}`);
  for (const btn of $("modal").querySelectorAll(".victim")) {
    btn.onclick = () => { send({ t: "robber", tile, victim: +btn.dataset.seat }); closeModal(); };
  }
}

function openResPickModal(title, cb) {
  openModal("respick", `
    <h3>${title}</h3>
    <div class="res-pick">${RES_KEYS.map((k) => `
      <button class="chip big" data-res="${k}"><i style="background:${RES[k].color}"></i>${RES[k].name}</button>`).join("")}
    </div>
    <button id="rp-cancel" class="linkish">取消</button>`);
  for (const btn of $("modal").querySelectorAll("[data-res]")) {
    btn.onclick = () => { cb(btn.dataset.res); closeModal(); };
  }
  $("rp-cancel").onclick = closeModal;
}

function openInventModal() {
  const sel = [];
  openModal("invent", `
    <h3>丰收:从银行任取 2 张</h3>
    <div class="res-pick">${RES_KEYS.map((k) => `
      <button class="chip big" data-res="${k}"><i style="background:${RES[k].color}"></i>${RES[k].name}(银行 ${G.bank[k]})</button>`).join("")}
    </div>
    <p class="modal-status" id="inv-sel">已选:—</p>
    <button id="inv-ok" class="primary big" disabled>确认</button>
    <button id="inv-cancel" class="linkish">取消</button>`);
  const refresh = () => {
    $("inv-sel").textContent = "已选:" + (sel.map((k) => RES[k].name).join("、") || "—");
    $("inv-ok").disabled = sel.length !== 2;
  };
  for (const btn of $("modal").querySelectorAll("[data-res]")) {
    btn.onclick = () => {
      const k = btn.dataset.res;
      if (sel.length >= 2) sel.length = 0;
      sel.push(k);
      refresh();
    };
  }
  $("inv-ok").onclick = () => { send({ t: "play_dev", card: "invent", res: sel[0], res2: sel[1] }); closeModal(); };
  $("inv-cancel").onclick = closeModal;
}

function openTradeModal() {
  const me = G.seats[G.you];
  const rates = getRates(G, G.you);
  let give = null, get = null;
  openModal("trade", `
    <h3>银行/港口兑换</h3>
    <p>付出(按你的港口汇率):</p>
    <div class="res-pick" id="tr-give">${RES_KEYS.filter((k) => me.res[k] >= rates[k]).map((k) => `
      <button class="chip big" data-res="${k}"><i style="background:${RES[k].color}"></i>${RES[k].name} <b>${rates[k]}:1</b>(有 ${me.res[k]})</button>`).join("")}
    </div>
    <p>换取 1 张:</p>
    <div class="res-pick" id="tr-get">${RES_KEYS.map((k) => `
      <button class="chip big" data-res="${k}"><i style="background:${RES[k].color}"></i>${RES[k].name}(银行 ${G.bank[k]})</button>`).join("")}
    </div>
    <button id="tr-ok" class="primary big" disabled>确认交换</button>
    <button id="tr-cancel" class="linkish">取消</button>`);
  const refresh = () => {
    for (const btn of $("tr-give").querySelectorAll("[data-res]")) btn.classList.toggle("sel", btn.dataset.res === give);
    for (const btn of $("tr-get").querySelectorAll("[data-res]")) btn.classList.toggle("sel", btn.dataset.res === get);
    $("tr-ok").disabled = !(give && get && give !== get && G.bank[get] > 0);
  };
  for (const btn of $("tr-give").querySelectorAll("[data-res]")) btn.onclick = () => { give = btn.dataset.res; refresh(); };
  for (const btn of $("tr-get").querySelectorAll("[data-res]")) btn.onclick = () => { get = btn.dataset.res; refresh(); };
  $("tr-ok").onclick = () => { send({ t: "bank_trade", give, get }); closeModal(); };
  $("tr-cancel").onclick = closeModal;
}

// 发起交易 / 还价:两组步进器(给出上限=手牌)
function openOfferModal() {
  const me = G.seats[G.you];
  const give = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  const want = Object.fromEntries(RES_KEYS.map((k) => [k, 0]));
  const row = (k, side) => `
    <div class="pick-row" data-side="${side}" data-res="${k}">
      <span class="chip"><i style="background:${RES[k].color}"></i>${RES[k].name}${side === "give" ? `(有 ${me.res[k]})` : ""}</span>
      <span class="stepper"><button class="minus">−</button><b class="n">0</b><button class="plus">＋</button></span>
    </div>`;
  openModal("offer", `
    <h3>${myTurn() ? "发起交易" : `向 ${esc(G.seats[G.turn.seat].nick)} 还价`}</h3>
    <p class="modal-status"><b>我给出:</b></p>
    ${RES_KEYS.filter((k) => me.res[k] > 0).map((k) => row(k, "give")).join("") || "<p class='modal-status'>(你没有手牌)</p>"}
    <p class="modal-status"><b>我想要:</b></p>
    ${RES_KEYS.map((k) => row(k, "want")).join("")}
    <p class="err" id="of-err"></p>
    <button id="of-ok" class="primary big" disabled>提出交易</button>
    <button id="of-cancel" class="linkish">取消</button>`);
  const refresh = () => {
    let sg = 0, sw = 0, overlap = false;
    for (const k of RES_KEYS) {
      sg += give[k];
      sw += want[k];
      if (give[k] > 0 && want[k] > 0) overlap = true;
    }
    $("of-err").textContent = overlap ? "同种资源不能既给又要" : "";
    $("of-ok").disabled = !(sg > 0 && sw > 0 && !overlap);
  };
  for (const r of $("modal").querySelectorAll(".pick-row")) {
    const k = r.dataset.res;
    const m = r.dataset.side === "give" ? give : want;
    const cap = r.dataset.side === "give" ? me.res[k] : 9;
    r.querySelector(".plus").onclick = () => { if (m[k] < cap) { m[k]++; r.querySelector(".n").textContent = m[k]; refresh(); } };
    r.querySelector(".minus").onclick = () => { if (m[k] > 0) { m[k]--; r.querySelector(".n").textContent = m[k]; refresh(); } };
  }
  $("of-ok").onclick = () => { send({ t: "offer", give, want }); closeModal(); };
  $("of-cancel").onclick = closeModal;
}

function openResultModal() {
  const rows = [...G.result].sort((a, b) => b.vp - a.vp);
  openModal("result", `
    <h3>🏆 ${esc(G.seats[G.winner].nick)} 获胜!</h3>
    <table class="result">
      <tr><th></th><th>村</th><th>城</th><th>胜利点卡</th><th>称号</th><th>总分</th></tr>
      ${rows.map((r) => `
        <tr>
          <td><span class="dot" style="background:${r.color}"></span>${esc(r.nick)}</td>
          <td>${r.villages}</td><td>${r.cities}</td><td>${r.vpCards}</td>
          <td>${r.longest ? "🛤️" : ""}${r.army ? "⚔️" : ""}</td>
          <td><b>${r.vp}</b></td>
        </tr>`).join("")}
    </table>
    <button id="res-close" class="linkish">继续观看棋盘</button>
    <button id="res-leave" class="primary big">回到首页</button>`);
  $("res-close").onclick = closeModal;
  $("res-leave").onclick = () => { closeModal(); leave(); };
}

// ---------- 首页交互 ----------

async function createRoom() {
  if (!requireNick()) return;
  $("btn-create").disabled = true;
  try {
    const res = await fetch("/api/create", {
      method: "POST",
      body: JSON.stringify({ hostToken: token }),
    });
    if (!res.ok) throw new Error("建房失败,稍后再试");
    const { code: c } = await res.json();
    connect(c);
  } catch (e) {
    $("home-err").textContent = e.message;
  } finally {
    $("btn-create").disabled = false;
  }
}

function requireNick() {
  if (!nickVal()) {
    $("home-err").textContent = "先给自己起个昵称";
    $("nick").focus();
    return false;
  }
  localStorage.setItem("dao-nick", nickVal());
  $("home-err").textContent = "";
  return true;
}

function init() {
  $("nick").value = localStorage.getItem("dao-nick") ?? "";
  $("btn-create").onclick = createRoom;
  $("btn-join").onclick = () => {
    if (!requireNick()) return;
    const c = $("join-code").value.trim().toUpperCase();
    if (!/^[A-Z2-9]{5}$/.test(c)) { $("home-err").textContent = "房间码是 5 位字母数字"; return; }
    connect(c);
  };
  $("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-join").click(); });
  $("btn-leave").onclick = leave;
  $("btn-addbot").onclick = () => send({ t: "add_bot" });
  $("btn-start").onclick = () => send({ t: "start", winVP: +$("win-vp").value });
  $("btn-end").onclick = () => { mode = null; send({ t: "end" }); };
  $("btn-trade").onclick = openTradeModal;
  $("btn-offer").onclick = openOfferModal;
  $("chat").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $("chat").value.trim()) {
      send({ t: "chat", text: $("chat").value });
      $("chat").value = "";
    }
  });

  // 带 ?room= 的链接:回填房间码;若本标签页此前就在这个房间,直接重连
  const room = new URLSearchParams(location.search).get("room");
  if (room) {
    $("join-code").value = room.toUpperCase();
    if (sessionStorage.getItem("dao-room") === room.toUpperCase() && nickVal()) {
      connect(room);
    }
  }
}

init();
