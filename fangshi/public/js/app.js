// 「长安坊市」前端:界面状态机 + WebSocket 客户端。服务端权威,这里只做展示与动作发送。
import {
  BOARD, GROUPS, CURRENCY, BUILD_NAMES, GO, JAIL, TO_GO,
  groupTiles, hasMonopoly, rentOf, mortgageValue, redeemCost, netWorth,
} from "./shared/board.js?v=3";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ws = null, G = null, code = null, me = -1;
let joined = false, leaving = false;

const token = (() => {
  let t = sessionStorage.getItem("fangshi-token");
  if (!t) { t = crypto.randomUUID(); sessionStorage.setItem("fangshi-token", t); }
  return t;
})();

const nickVal = () => $("nick").value.trim().slice(0, 12);
const show = (id) => { for (const s of ["home", "lobby", "game"]) $(s).classList.toggle("hidden", s !== id); };

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
    if (leaving || !joined) return;
    toast("连接断开,正在重连…");
    setTimeout(() => { if (!leaving) connect(code); }, 1500);
  };
}

const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };

function onMsg(m) {
  if (m.t === "joined") {
    joined = true; me = m.seat;
    sessionStorage.setItem("fangshi-room", m.code);
    history.replaceState(null, "", "?room=" + m.code);
    return;
  }
  if (m.t === "err") {
    if (!joined) { $("home-err").textContent = m.msg; leaving = true; try { ws?.close(); } catch {} show("home"); }
    else toast(m.msg);
    return;
  }
  if (m.t === "state") { G = m.g; me = G.seats.findIndex((s) => s.token === token); render(); }
}

// ---------- 棋盘几何:0 号格在右下角,逆时针一圈 ----------

function gridPos(i) {
  if (i === 0) return [11, 11];
  if (i < 10) return [11, 11 - i];
  if (i === 10) return [11, 1];
  if (i < 20) return [21 - i, 1];
  if (i === 20) return [1, 1];
  if (i < 30) return [1, i - 19];
  if (i === 30) return [1, 11];
  return [i - 29, 11];
}

let boardBuilt = false;
function buildBoard() {
  const b = $("board");
  for (let i = 0; i < BOARD.length; i++) {
    const c = BOARD[i];
    const [r, col] = gridPos(i);
    const el = document.createElement("div");
    el.id = "cell" + i;
    el.className = "cell" + (i % 10 === 0 ? " corner" : "")
      + (["edict", "rumor", "tax", "gate", "canal"].includes(c.t) ? " special" : "");
    el.style.gridArea = `${r} / ${col} / ${r + 1} / ${col + 1}`;
    const bar = c.t === "ward" ? `<div class="bar" style="background:${GROUPS[c.g].hex}"></div>` : "";
    const price = c.price ? `<div class="pr">${c.price} ${CURRENCY}</div>`
      : c.amount ? `<div class="pr">缴 ${c.amount} ${CURRENCY}</div>` : "";
    el.innerHTML = `${bar}<div class="nm">${esc(c.name)}</div>${c.sub ? `<div class="pr">${esc(c.sub)}</div>` : price}
      <div class="pieces"></div>`;
    b.appendChild(el);
  }
  boardBuilt = true;
}

// ---------- 渲染 ----------

function render() {
  if (!G) return;
  if (G.phase === "lobby") { renderLobby(); show("lobby"); return; }
  show("game");
  if (!boardBuilt) buildBoard();
  renderBoard();
  renderBanner();
  renderDice();
  renderActions();
  renderPlayers();
  renderEstate();
  renderLog();
  renderModal();
}

function renderLobby() {
  $("lobby-code").textContent = G.code;
  $("lobby-players").innerHTML = G.seats.map((s, i) => `
    <li>
      <span class="dot" style="background:${s.color}"></span>
      <b>${esc(s.nick)}</b>${i === me ? "(你)" : ""}
      ${s.token === G.hostToken ? '<span class="tag">房主</span>' : ""}
      ${s.isBot ? '<span class="tag">🤖</span>' : ""}
      ${s.isBot && G.seats[me]?.token === G.hostToken ? `<button class="bot-rm" data-seat="${i}">移除</button>` : ""}
    </li>`).join("");
  for (const b of $("lobby-players").querySelectorAll(".bot-rm")) {
    b.onclick = () => send({ t: "remove_bot", seat: +b.dataset.seat });
  }
  const isHost = G.seats[me]?.token === G.hostToken;
  $("host-panel").classList.toggle("hidden", !isHost);
  $("btn-start").disabled = G.seats.length < 2;
  $("lobby-wait").textContent = isHost
    ? (G.seats.length < 2 ? "至少 2 人才能开市(可以加坊客)" : "")
    : "等房主开市…";
}

function renderBoard() {
  for (let i = 0; i < BOARD.length; i++) {
    const el = $("cell" + i);
    const t = G.tiles[i];
    const owner = t.owner >= 0 ? G.seats[t.owner] : null;
    el.classList.toggle("mine", t.owner === me);
    el.classList.toggle("mortgaged", !!t.mortgaged);
    let mark = el.querySelector(".own");
    if (owner && !mark) { mark = document.createElement("div"); mark.className = "own"; el.appendChild(mark); }
    if (mark) { mark.style.background = owner ? owner.color : "transparent"; mark.style.display = owner ? "" : "none"; }
    let lv = el.querySelector(".lv");
    if (t.level > 0) {
      if (!lv) { lv = document.createElement("div"); lv.className = "lv"; el.appendChild(lv); }
      lv.textContent = t.level === 5 ? "商" : "店".repeat(t.level);
    } else if (lv) lv.remove();
    el.querySelector(".pieces").innerHTML = "";
  }
  for (const [i, s] of G.seats.entries()) {
    if (s.bankrupt) continue;
    const box = $("cell" + s.pos)?.querySelector(".pieces");
    if (!box) continue;
    const p = document.createElement("div");
    p.className = "pc" + (G.turn?.seat === i ? " active" : "");
    p.style.background = s.color;
    p.textContent = s.piece;
    p.title = s.nick;
    box.appendChild(p);
  }
}

function renderBanner() {
  const b = $("banner");
  const p = G.pending;
  let text = "", mine = false;
  if (G.phase === "ended") text = `🏆 ${G.seats[G.winner]?.nick ?? "无人"} 独占长安!`;
  else if (p?.t === "buy") {
    mine = p.seat === me;
    text = mine ? `${BOARD[p.tile].name} 无主,买不买?` : `${G.seats[p.seat].nick} 正在决定是否承买 ${BOARD[p.tile].name}`;
  } else if (p?.t === "auction") {
    const cur = p.alive[p.at];
    mine = cur === me;
    text = `【发卖】${BOARD[p.tile].name} 当前最高 ${p.high} ${CURRENCY}` +
      (p.leader >= 0 ? `(${G.seats[p.leader].nick})` : "") + ` · 轮到 ${G.seats[cur].nick}`;
  } else if (p?.t === "trade") {
    mine = p.to === me;
    text = `${G.seats[p.from].nick} 向 ${G.seats[p.to].nick} 提出交易`;
  } else {
    const s = G.seats[G.turn.seat];
    mine = G.turn.seat === me;
    text = mine
      ? (s.jailed ? "你在大牢里:掷双数、缴赎身钱,或用免罪金牌" : G.turn.rolled ? "可营造/抵押,或结束回合" : "该你了,掷骰")
      : `${s.nick} 的回合`;
  }
  b.textContent = text;
  b.className = mine ? "mine" : "";
}

function renderDice() {
  const d = G.turn?.dice;
  $("dice").innerHTML = d ? d.map((n) => `<div class="die">${n}</div>`).join("") : "";
}

function renderActions() {
  const el = $("actions");
  const btns = [];
  const p = G.pending;
  const myTurn = G.turn?.seat === me && G.phase === "play";
  const s = G.seats[me];

  if (p?.t === "buy" && p.seat === me) {
    btns.push(["buy", `买下(${BOARD[p.tile].price} ${CURRENCY})`, "primary"], ["decline", "不要,发卖", ""]);
  } else if (p?.t === "auction" && p.alive[p.at] === me) {
    btns.push(["bid", `加价`, "primary"], ["bid_pass", "不加价", ""]);
  } else if (p?.t === "trade" && p.to === me) {
    btns.push(["trade_accept", "接受交易", "primary"], ["trade_reject", "回绝", "warn"]);
  } else if (myTurn && !p) {
    if (s.jailed && !G.turn.rolled) {
      btns.push(["roll", "掷骰(求双)", "primary"], ["jail_pay", "缴 50 贯赎身", ""]);
      if (s.pardons > 0) btns.push(["jail_card", "用免罪金牌", ""]);
    } else if (!G.turn.rolled || G.turn.canRollAgain) {
      btns.push(["roll", G.turn.canRollAgain ? "双数!再掷" : "掷骰", "primary"]);
    } else {
      btns.push(["trade_new", "提议交易", ""], ["end_turn", "结束回合", "primary"]);
    }
  }
  el.innerHTML = btns.map(([t, label, cls]) => `<button data-act="${t}" class="${cls}">${label}</button>`).join("");
  for (const b of el.querySelectorAll("button")) {
    b.onclick = () => {
      const act = b.dataset.act;
      if (act === "bid") {
        const min = (G.pending.high || 9) + 1;
        const v = prompt(`出价(至少 ${min} ${CURRENCY})`, String(min));
        if (v !== null) send({ t: "bid", amount: +v });
      } else if (act === "trade_new") openTradeCompose();
      else send({ t: act });
    };
  }
}

function renderPlayers() {
  $("players").innerHTML = `<div class="panel"><h3>坊中诸位</h3>` + G.seats.map((s, i) => `
    <div class="pl ${G.turn?.seat === i ? "turn" : ""} ${s.bankrupt ? "out" : ""}">
      <span class="dot" style="background:${s.color}"></span>
      <span class="nm">${esc(s.nick)}${i === me ? "(你)" : ""}${s.isBot ? " 🤖" : ""}${s.jailed ? " 🔒" : ""}</span>
      <span class="cash">${s.cash}</span>
      <span class="hint" title="净资产">/${netWorth(G, i)}</span>
    </div>`).join("") + `</div>`;
}

function renderEstate() {
  const mine = BOARD.map((_, i) => i).filter((i) => G.tiles[i].owner === me);
  const myTurn = G.turn?.seat === me && !G.pending && G.phase === "play";
  if (!mine.length) { $("estate").innerHTML = `<div class="panel"><h3>你的产业</h3><div class="hint">还没置下产业</div></div>`; return; }
  $("estate").innerHTML = `<div class="panel"><h3>你的产业(现银 ${G.seats[me].cash} ${CURRENCY})</h3>` + mine.map((i) => {
    const c = BOARD[i], t = G.tiles[i];
    const canBuild = myTurn && c.t === "ward" && !t.mortgaged && t.level < 5
      && hasMonopoly(G, me, c.g)
      && !groupTiles(c.g).some((j) => G.tiles[j].level < t.level)
      && G.seats[me].cash >= GROUPS[c.g].houseCost;
    return `<div class="est ${t.mortgaged ? "mg" : ""}">
      <span class="sw" style="background:${c.t === "ward" ? GROUPS[c.g].hex : "#8a8a7a"}"></span>
      <span class="nm">${esc(c.name)}${t.level ? ` · ${BUILD_NAMES[t.level]}` : ""}${t.mortgaged ? " · 已抵押" : ""}</span>
      ${canBuild ? `<button data-b="${i}">营造 ${GROUPS[c.g].houseCost}</button>` : ""}
      ${myTurn && t.level > 0 ? `<button data-s="${i}">拆</button>` : ""}
      ${myTurn && t.level === 0 && !t.mortgaged ? `<button data-m="${i}">抵押 ${mortgageValue(i)}</button>` : ""}
      ${myTurn && t.mortgaged ? `<button data-r="${i}">赎 ${redeemCost(i)}</button>` : ""}
    </div>`;
  }).join("") + `</div>`;
  const wire = (attr, t) => {
    for (const b of $("estate").querySelectorAll(`[data-${attr}]`)) {
      b.onclick = () => send({ t, tile: +b.dataset[attr] });
    }
  };
  wire("b", "build"); wire("s", "sell_build"); wire("m", "mortgage"); wire("r", "redeem");
}

function renderLog() {
  const el = $("log");
  el.innerHTML = (G.log ?? []).slice(-60).map((l) => `<div>${esc(l)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

// 交易:自己拟一份提议
let composing = false;
function openTradeCompose() { composing = true; render(); }

const tradeableOf = (seat) =>
  BOARD.map((_, i) => i).filter((i) => G.tiles[i].owner === seat && G.tiles[i].level === 0);

function renderCompose() {
  const others = G.seats.map((s, i) => i).filter((i) => i !== me && !G.seats[i].bankrupt);
  const list = (seat, key) => tradeableOf(seat).map((i) => {
    const c = BOARD[i];
    return `<label class="est"><input type="checkbox" data-k="${key}" value="${i}">
      <span class="sw" style="background:${c.t === "ward" ? GROUPS[c.g].hex : "#8a8a7a"}"></span>
      <span class="nm">${esc(c.name)}${G.tiles[i].mortgaged ? "(押)" : ""}</span></label>`;
  }).join("") || `<div class="hint">没有可交易的地(有建筑的要先拆)</div>`;

  $("modal").innerHTML = `<h2>提议交易</h2>
    <label class="hint">交易对象
      <select id="tr-to">${others.map((i) => `<option value="${i}">${esc(G.seats[i].nick)}</option>`).join("")}</select>
    </label>
    <div><b>我拿出</b><div id="tr-give">${list(me, "give")}</div>
      <label class="hint">外加现银 <input id="tr-gc" type="number" min="0" value="0"></label></div>
    <div><b>我想要</b><div id="tr-want"></div>
      <label class="hint">外加现银 <input id="tr-wc" type="number" min="0" value="0"></label></div>
    <div style="display:flex;gap:8px">
      <button id="tr-send" class="primary big">发出提议</button>
      <button id="tr-cancel" class="big">取消</button>
    </div>`;

  const paintWant = () => { $("tr-want").innerHTML = list(+$("tr-to").value, "want"); };
  paintWant();
  $("tr-to").onchange = paintWant;
  $("tr-cancel").onclick = () => { composing = false; render(); };
  $("tr-send").onclick = () => {
    const pick = (k) => [...$("modal").querySelectorAll(`input[data-k="${k}"]:checked`)].map((x) => +x.value);
    send({
      t: "trade_offer", to: +$("tr-to").value,
      giveTiles: pick("give"), wantTiles: pick("want"),
      giveCash: +$("tr-gc").value || 0, wantCash: +$("tr-wc").value || 0,
      givePardon: 0, wantPardon: 0,
    });
    composing = false;
  };
}

/** 把一份提议讲人话 */
function tradeText(p) {
  const names = (l) => l.map((i) => BOARD[i].name).join("、") || "无";
  return `<div class="hint">
    <b>${esc(G.seats[p.from].nick)}</b> 拿出:${names(p.give)}${p.giveCash ? ` + ${p.giveCash} ${CURRENCY}` : ""}<br>
    <b>${esc(G.seats[p.to].nick)}</b> 拿出:${names(p.want)}${p.wantCash ? ` + ${p.wantCash} ${CURRENCY}` : ""}</div>`;
}

function renderModal() {
  const p = G.pending;
  if (composing && G.phase === "play" && !p) { $("modal-layer").classList.remove("hidden"); renderCompose(); return; }
  composing = false;

  // 收到别人的提议:先把内容摆出来再让人决定
  if (p?.t === "trade" && p.to === me) {
    $("modal-layer").classList.remove("hidden");
    $("modal").innerHTML = `<h2>${esc(G.seats[p.from].nick)} 提出交易</h2>${tradeText(p)}
      <div style="display:flex;gap:8px">
        <button id="tr-ok" class="primary big">接受</button>
        <button id="tr-no" class="warn big">回绝</button>
      </div>`;
    $("tr-ok").onclick = () => send({ t: "trade_accept" });
    $("tr-no").onclick = () => send({ t: "trade_reject" });
    return;
  }

  const show = G.phase === "ended";
  $("modal-layer").classList.toggle("hidden", !show);
  if (!show) return;
  $("modal").innerHTML = `<h2>🏆 ${esc(G.seats[G.winner]?.nick ?? "无人")} 独占长安!</h2>
    <div class="hint">${G.seats.map((s, i) => `${esc(s.nick)} 净资产 ${netWorth(G, i)} ${CURRENCY}`).join("<br>")}</div>
    <button id="m-leave" class="primary big">回到首页</button>`;
  $("m-leave").onclick = leave;
}

function leave() {
  leaving = true; joined = false; G = null;
  try { ws?.close(); } catch {}
  sessionStorage.removeItem("fangshi-room");
  history.replaceState(null, "", location.pathname);
  show("home");
}

// ---------- 初始化 ----------

async function createRoom() {
  if (!nickVal()) { $("home-err").textContent = "先起个名号"; return; }
  $("btn-create").disabled = true;
  try {
    const res = await fetch("/api/create", { method: "POST", body: JSON.stringify({ hostToken: token }) });
    if (!res.ok) throw new Error("开局失败,稍后再试");
    const { code: c } = await res.json();
    connect(c);
  } catch (e) {
    $("home-err").textContent = e.message;
  } finally {
    $("btn-create").disabled = false;
  }
}

function init() {
  $("nick").value = localStorage.getItem("fangshi-nick") ?? "";
  $("nick").oninput = () => localStorage.setItem("fangshi-nick", nickVal());
  $("btn-create").onclick = createRoom;
  $("btn-join").onclick = () => {
    const c = $("join-code").value.trim().toUpperCase();
    if (!nickVal()) { $("home-err").textContent = "先起个名号"; return; }
    if (c.length !== 5) { $("home-err").textContent = "房间码是 5 位"; return; }
    connect(c);
  };
  $("btn-addbot").onclick = () => send({ t: "add_bot" });
  $("btn-start").onclick = () => send({ t: "start" });
  $("btn-leave").onclick = leave;
  $("chat").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $("chat").value.trim()) {
      send({ t: "chat", text: $("chat").value });
      $("chat").value = "";
    }
  });
  const room = new URLSearchParams(location.search).get("room");
  if (room) {
    $("join-code").value = room.toUpperCase();
    if (sessionStorage.getItem("fangshi-room") === room.toUpperCase() && nickVal()) connect(room);
  }
}

init();
