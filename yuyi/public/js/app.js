// 「余一」前端:界面状态机 + WebSocket 客户端(服务端权威,这里只做展示与动作发送)
import { sfx, ensure as sfxEnsure, isMuted, setMuted } from "./sfx.js?v=3";

const $ = (id) => document.getElementById(id);

const COLORS = ["r", "y", "g", "b"];
const COLOR_INFO = {
  r: { name: "赤", hex: "#d9484a" },
  y: { name: "金", hex: "#e0a92e" },
  g: { name: "翠", hex: "#3f9e57" },
  b: { name: "黛", hex: "#3f6fd9" },
};
const isWild = (c) => c === "w" || c === "W";
const colorOf = (c) => (isWild(c) ? null : c[0]);
const valOf = (c) => (isWild(c) ? c : c.slice(1));
const GLYPH = { s: "⃠", r: "⇄", d: "+2", w: "✦", W: "+4" };

// 对手在桌沿上的落座点(百分比,按人数排布;自己永远在下方手牌区)
const SEAT_POS = {
  1: [[50, 8]],
  2: [[19, 30], [81, 30]],
  3: [[16, 42], [50, 8], [84, 42]],
  4: [[14, 48], [30, 11], [70, 11], [86, 48]],
  5: [[13, 52], [23, 17], [50, 7], [77, 17], [87, 52]],
};

function playableCard(card, top, color) {
  if (isWild(card)) return true;
  if (colorOf(card) === color) return true;
  return top && !isWild(top) && valOf(card) === valOf(top);
}

let ws = null, G = null, code = null;
let joined = false, leaving = false, modalKind = null;
let unoArmed = false;
let lastPileKey = null;
let lastTurnSeat = null; // 上一帧轮到谁 —— 弃牌堆变了就说明是 TA 刚出的牌

const token = (() => {
  let t = sessionStorage.getItem("yuyi-token");
  if (!t) {
    t = crypto.randomUUID();
    sessionStorage.setItem("yuyi-token", t);
  }
  return t;
})();

const nickVal = () => $("nick").value.trim().slice(0, 12);

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

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function leave() {
  leaving = true;
  joined = false;
  G = null;
  unoArmed = false;
  closeModal();
  try { ws?.close(); } catch {}
  sessionStorage.removeItem("yuyi-room");
  history.replaceState(null, "", location.pathname);
  show("home");
}

function onMsg(m) {
  if (m.t === "joined") {
    joined = true;
    sessionStorage.setItem("yuyi-room", m.code);
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
    G = m.g;
    render();
  }
}

// ---------- 特效 ----------
// 服务端每次推 state 都整体重渲染,所以动画一律靠「新旧状态对比」触发:
// 先在 render() 开头算出这一帧该放什么,渲染完再把 class 挂到新生成的节点上。

const fxPrev = { hand: null, color: null, round: null, counts: null, myTurn: false, phase: null };

function fxAdd(node, ms) {
  $("fx").appendChild(node);
  setTimeout(() => node.remove(), ms);
}

function sealDrop() {
  const d = document.createElement("div");
  d.className = "fx-seal";
  d.textContent = "余一";
  fxAdd(d, 1200);
}

function ripple(hex) {
  const d = document.createElement("div");
  d.className = "fx-ripple";
  d.style.background = `radial-gradient(circle, ${hex}00 42%, ${hex}b0 60%, ${hex}00 70%)`;
  fxAdd(d, 900);
}

function jolt(id, cls, ms) {
  const el = $(id);
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // 强制重排,让同名动画能连着放第二次
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// ---------- 渲染 ----------

function render() {
  if (!G) return;
  if (G.phase === "lobby") {
    renderLobby();
    show("lobby");
    return;
  }
  show("game");

  // 渲染前先算差异(渲染会把旧节点全换掉)
  const handLen = G.seats[G.you]?.hand?.length ?? null;
  const counts = G.seats.map((s) => s.handCount);
  const dealing = handLen !== null && (fxPrev.hand === null || G.round !== fxPrev.round);
  const drew = !dealing && handLen !== null && fxPrev.hand !== null
    ? Math.max(0, handLen - fxPrev.hand) : 0;
  // 只有万能牌指定新颜色才算「换色」;普通牌打出不同花色也会改 G.color,
  // 那种每手都响涟漪和磬声就太吵了
  const colorChanged = fxPrev.color && G.color && G.color !== fxPrev.color && isWild(G.pileTop);
  const wentUno = fxPrev.counts && counts.some((n, i) => n === 1 && fxPrev.counts[i] !== 1);

  renderPlayers();
  renderBanner();
  renderCenter();
  renderAlerts();
  renderHand();
  renderLog();
  maybeModals();

  const hand = [...$("hand").children];
  if (dealing) {
    hand.forEach((el, i) => { el.style.setProperty("--i", i); el.classList.add("deal"); });
    sfx.deal(hand.length);
  } else if (drew > 0) {
    hand.slice(-drew).forEach((el, i) => { el.style.setProperty("--i", i); el.classList.add("flip"); });
    if (drew >= 2) { jolt("hand", "tremble", 420); sfx.penalty(); } // 被抓 / 吃罚牌
    else sfx.draw();
  }
  if (colorChanged) { ripple(COLOR_INFO[G.color]?.hex ?? "#f4ead3"); sfx.chime(); }
  if (wentUno) { sealDrop(); sfx.uno(); }

  const nowMyTurn = myTurn();
  if (nowMyTurn && !fxPrev.myTurn && !dealing) sfx.turn();
  if (G.phase === "ended" && fxPrev.phase !== "ended") sfx.win();

  fxPrev.hand = handLen;
  fxPrev.color = G.color;
  fxPrev.round = G.round;
  fxPrev.counts = counts;
  fxPrev.myTurn = nowMyTurn;
  fxPrev.phase = G.phase;
  lastTurnSeat = G.turn?.seat ?? lastTurnSeat;
}

function renderLobby() {
  $("lobby-code").textContent = G.code;
  $("lobby-players").innerHTML = G.seats.map((s, i) => `
    <li>
      <span class="dot" style="background:${s.color}"></span>
      <b>${esc(s.nick)}</b>${i === G.you ? "(你)" : ""}
      ${i === G.hostSeat ? '<span class="tag">房主</span>' : ""}
      ${s.isBot ? '<span class="tag bot">🤖 机器人</span>' : ""}
      ${s.isBot && G.you === G.hostSeat ? `<button class="bot-rm" data-seat="${i}">移除</button>` : ""}
      ${s.isBot ? "" : `<span class="conn ${s.connected ? "on" : ""}"></span>`}
    </li>`).join("");
  for (const b of $("lobby-players").querySelectorAll(".bot-rm")) {
    b.onclick = () => send({ t: "remove_bot", seat: +b.dataset.seat });
  }
  const isHost = G.you === G.hostSeat;
  $("host-panel").classList.toggle("hidden", !isHost);
  $("btn-start").disabled = G.seats.length < 2;
  $("lobby-wait").textContent = isHost
    ? (G.seats.length < 2 ? "至少 2 人才能开始(可以加机器人)" : "")
    : "等待房主开始游戏…";
}

const myTurn = () => G.phase === "play" && G.turn?.seat === G.you && !G.pending;

function renderPlayers() {
  // 围坐:自己固定在下方(手牌区),其余人按出牌顺序沿桌沿从左、经上、到右排开
  const others = [];
  for (let k = 1; k < G.seats.length; k++) others.push((G.you + k) % G.seats.length);
  const pos = SEAT_POS[others.length] ?? SEAT_POS[5];

  $("players").innerHTML = others.map((i, k) => {
    const s = G.seats[i];
    const active = G.phase === "play" && G.turn?.seat === i;
    const vul = G.vulnerable?.seat === i;
    const fan = Array.from({ length: Math.min(s.handCount, 8) }, (_, n) =>
      `<i style="--n:${n - Math.min(s.handCount, 8) / 2}"></i>`).join("");
    return `
    <div class="seat ${active ? "active" : ""}" data-seat="${i}"
         style="left:${pos[k][0]}%; top:${pos[k][1]}%">
      <div class="sfan">${fan}</div>
      <div class="sinfo">
        <img class="pav" src="img/avatar-${(i % 6) + 1}.jpg" alt="" style="box-shadow:0 0 0 2px ${s.color}">
        <span class="pname">${esc(s.nick)}</span>
        ${s.isBot ? '<span title="机器人">🤖</span>' : `<span class="conn ${s.connected ? "on" : ""}"></span>`}
        <span class="pstat" title="手牌数">🂠${s.handCount}</span>
        ${G.target !== 0 ? `<span class="pvp" title="累计分数">${s.score}分</span>` : ""}
      </div>
      ${s.handCount === 1 ? '<span class="one">余1</span>' : ""}
      ${vul ? '<span class="vul">没喊!</span>' : ""}
    </div>`;
  }).join("") + meSeatHtml();
}

function meSeatHtml() {
  const me = G.seats[G.you];
  const active = G.phase === "play" && G.turn?.seat === G.you;
  return `
    <div class="seat me ${active ? "active" : ""}" data-seat="${G.you}">
      <div class="sinfo">
        <img class="pav" src="img/avatar-${(G.you % 6) + 1}.jpg" alt="" style="box-shadow:0 0 0 2px ${me.color}">
        <span class="pname">${esc(me.nick)}(你)</span>
        <span class="pstat" title="手牌数">🂠${me.handCount}</span>
        ${G.target !== 0 ? `<span class="pvp" title="累计分数">${me.score}分</span>` : ""}
      </div>
    </div>`;
}

function renderBanner() {
  const b = $("banner");
  let text = "", cls = "";
  const p = G.pending;
  if (G.phase === "ended") {
    text = `🏆 ${G.seats[G.winner].nick} 获得最终胜利!`;
    cls = "mine";
  } else if (p?.t === "firstcolor") {
    text = p.seat === G.you ? "首牌是「换色」:请选择起始颜色" : `等待 ${G.seats[p.seat].nick} 选择起始颜色`;
    if (p.seat === G.you) cls = "mine";
  } else if (p?.t === "challenge") {
    text = p.victim === G.you
      ? "你被 +4 了!质疑还是认摸?"
      : `等待 ${G.seats[p.victim].nick} 决定是否质疑 +4`;
    if (p.victim === G.you) cls = "mine";
  } else if (p?.t === "drawn") {
    text = p.seat === G.you ? "摸到一张能打的牌,要出吗?" : `${G.seats[p.seat].nick} 在考虑摸到的牌…`;
    if (p.seat === G.you) cls = "mine";
  } else if (p?.t === "round") {
    text = `第 ${G.round} 局结束,等待房主开下一局`;
  } else if (G.turn?.seat === G.you) {
    text = "你的回合:点手里发亮的牌打出,或点牌堆摸一张";
    cls = "mine";
  } else if (G.turn) {
    text = `${G.seats[G.turn.seat].nick} 的回合`;
  }
  b.textContent = text;
  b.className = cls;
}

function cardHtml(card, extra = "") {
  const c = colorOf(card);
  const cls = c ? "c-" + c : "c-w";
  const v = valOf(card);
  const glyph = GLYPH[v] ?? v;
  const corner = GLYPH[v] ?? v;
  const wildDots = isWild(card)
    ? `<span class="wdots">${COLORS.map((k) => `<i style="background:${COLOR_INFO[k].hex}"></i>`).join("")}</span>`
    : "";
  return `
    <div class="ucard ${cls} v-${v} ${extra}" data-card="${card}">
      <span class="corner tl">${corner}</span>
      <span class="big">${glyph}</span>
      ${wildDots}
      <span class="corner br">${corner}</span>
    </div>`;
}

function renderCenter() {
  const pileKey = G.pileTop + "|" + (G.v ?? "");
  $("pile").innerHTML = G.pileTop ? cardHtml(G.pileTop, "big-card") : "";
  if (lastPileKey !== null && lastPileKey.split("|")[0] !== G.pileTop) {
    const el = $("pile").firstElementChild;
    sfx.play();
    if (el) {
      // 让牌从「刚出牌那个人」的座位飞过来
      const src = lastTurnSeat === G.you
        ? $("hand")
        : document.querySelector(`.seat[data-seat="${lastTurnSeat}"]`);
      if (src) {
        const a = src.getBoundingClientRect(), b = el.getBoundingClientRect();
        el.style.setProperty("--fx", `${a.left + a.width / 2 - (b.left + b.width / 2)}px`);
        el.style.setProperty("--fy", `${a.top + a.height / 2 - (b.top + b.height / 2)}px`);
      }
      el.classList.add("fly");
    }
    const v = valOf(G.pileTop ?? "");
    if (v === "d" || v === "W") { jolt("game", "quake", 460); sfx.slam(); } // +2 / +4 落桌
  }
  lastPileKey = pileKey;

  $("deck-count").textContent = `牌堆 ${G.deckCount}`;
  $("deck").classList.toggle("clickable", myTurn());

  $("color-ind").innerHTML = "当前颜色 " + COLORS.map((k) =>
    `<i class="cdot ${G.color === k ? "on" : ""}" style="background:${COLOR_INFO[k].hex}"></i>`).join("");
  $("dir-ind").textContent = G.seats.length > 2 ? (G.dir === 1 ? "方向 ⟳" : "方向 ⟲") : "";
  $("round-ind").textContent = G.target === 0 ? "单局定胜负" : `第 ${G.round} 局 · 先到 ${G.target} 分`;
}

function renderAlerts() {
  const el = $("alerts");
  const vul = G.vulnerable;
  if (!vul) { el.innerHTML = ""; return; }
  if (vul.seat === G.you) {
    el.innerHTML = `<button id="al-late" class="warn big">❗ 快补喊「余一」!</button>`;
    $("al-late").onclick = () => send({ t: "uno_late" });
  } else {
    el.innerHTML = `<button id="al-catch" class="warn big">🫵 ${esc(G.seats[vul.seat].nick)} 没喊余一,抓TA!</button>`;
    $("al-catch").onclick = () => send({ t: "catch" });
  }
}

function renderHand() {
  const me = G.seats[G.you];
  if (!me?.hand) { $("hand").innerHTML = ""; $("btn-uno").classList.add("hidden"); return; }
  const canAct = myTurn();
  $("hand").innerHTML = me.hand.map((c) => {
    const ok = canAct && playableCard(c, G.pileTop, G.color);
    return cardHtml(c, ok ? "ok" : canAct ? "dim" : "");
  }).join("");
  for (const el of $("hand").querySelectorAll(".ucard")) {
    el.onclick = () => tryPlay(el.dataset.card);
  }
  const showUno = me.hand.length === 2 && (canAct || G.pending?.t === "drawn");
  $("btn-uno").classList.toggle("hidden", !showUno);
  $("btn-uno").classList.toggle("armed", unoArmed);
  if (!showUno) unoArmed = false;
}

function renderLog() {
  const el = $("log");
  el.innerHTML = (G.log ?? []).slice(-40).map((l) => `<div>${esc(l)}</div>`).join("");
  el.scrollTop = el.scrollHeight;
}

// ---------- 出牌与弹窗 ----------

function tryPlay(card) {
  if (!myTurn()) return;
  if (!playableCard(card, G.pileTop, G.color)) {
    toast("这张牌对不上颜色或数字");
    return;
  }
  if (isWild(card)) {
    openColorModal((c) => {
      send({ t: "play", card, color: c, uno: unoArmed });
      unoArmed = false;
    });
  } else {
    send({ t: "play", card, uno: unoArmed });
    unoArmed = false;
  }
}

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

function openColorModal(cb) {
  openModal("color", `
    <h3>指定颜色</h3>
    <div class="color-pick">
      ${COLORS.map((k) => `
        <button class="cbig" data-c="${k}" style="background:${COLOR_INFO[k].hex}">${COLOR_INFO[k].name}</button>`).join("")}
    </div>
    <button id="cp-cancel" class="linkish">取消</button>`);
  for (const b of $("modal").querySelectorAll(".cbig")) {
    b.onclick = () => { closeModal(); cb(b.dataset.c); };
  }
  $("cp-cancel").onclick = closeModal;
}

function maybeModals() {
  const p = G.pending;

  const needDrawn = p?.t === "drawn" && p.seat === G.you;
  if (needDrawn && modalKind !== "drawn") openDrawnModal(p.card);
  if (!needDrawn && modalKind === "drawn") closeModal();

  const needChal = p?.t === "challenge" && p.victim === G.you;
  if (needChal && modalKind !== "challenge") openChallengeModal(p);
  if (!needChal && modalKind === "challenge") closeModal();

  const needFirst = p?.t === "firstcolor" && p.seat === G.you;
  if (needFirst && modalKind !== "firstcolor") {
    openColorModalInto((c) => send({ t: "color", c }));
  }
  if (!needFirst && modalKind === "firstcolor") closeModal();

  const needRound = p?.t === "round";
  if (needRound && modalKind !== "round") openRoundModal(p);
  if (!needRound && modalKind === "round") closeModal();

  if (G.phase === "ended" && modalKind !== "result") openResultModal();
}

// 首牌换色:不可取消的颜色选择
function openColorModalInto(cb) {
  openModal("firstcolor", `
    <h3>首牌是「换色」:选择起始颜色</h3>
    <div class="color-pick">
      ${COLORS.map((k) => `
        <button class="cbig" data-c="${k}" style="background:${COLOR_INFO[k].hex}">${COLOR_INFO[k].name}</button>`).join("")}
    </div>`);
  for (const b of $("modal").querySelectorAll(".cbig")) {
    b.onclick = () => { closeModal(); cb(b.dataset.c); };
  }
}

function openDrawnModal(card) {
  openModal("drawn", `
    <h3>摸到了这张,能打!</h3>
    <div class="modal-card">${cardHtml(card)}</div>
    <button id="dr-play" class="primary big">打出去</button>
    <button id="dr-keep" class="big">留着,过</button>`);
  $("dr-play").onclick = () => {
    closeModal();
    const uno = G.seats[G.you].hand.length === 2 && unoArmed;
    if (isWild(card)) {
      openColorModal((c) => { send({ t: "play_drawn", play: true, color: c, uno }); unoArmed = false; });
    } else {
      send({ t: "play_drawn", play: true, uno });
      unoArmed = false;
    }
  };
  $("dr-keep").onclick = () => { closeModal(); send({ t: "play_drawn", play: false }); };
}

function openChallengeModal(p) {
  openModal("challenge", `
    <h3>${esc(G.seats[p.by].nick)} 对你打出了「+4换色」</h3>
    <p class="modal-status">质疑:若TA当时手里还有同色牌,TA自摸 4 张、你正常出牌;<br>若TA清白,你要摸 6 张并被跳过。</p>
    <button id="ch-accept" class="primary big">认了,摸 4 张</button>
    <button id="ch-doubt" class="warn big">🔍 质疑!</button>`);
  $("ch-accept").onclick = () => { closeModal(); send({ t: "challenge", accept: true }); };
  $("ch-doubt").onclick = () => { closeModal(); send({ t: "challenge", accept: false }); };
}

function openRoundModal(p) {
  const rows = [...G.seats].map((s, i) => ({ ...s, i })).sort((a, b) => b.score - a.score);
  openModal("round", `
    <h3>第 ${G.round} 局:${esc(G.seats[p.winner].nick)} 清空手牌!+${p.points} 分</h3>
    <table class="result">
      <tr><th></th><th>本局余牌</th><th>累计</th></tr>
      ${rows.map((s) => `
        <tr>
          <td><span class="dot" style="background:${s.color}"></span>${esc(s.nick)}</td>
          <td>${s.i === p.winner ? "—" : s.handCount + " 张"}</td>
          <td><b>${s.score}</b></td>
        </tr>`).join("")}
    </table>
    ${G.you === G.hostSeat
      ? '<button id="rd-next" class="primary big">开下一局</button>'
      : '<p class="modal-status">等待房主开下一局…</p>'}`);
  $("rd-next")?.addEventListener("click", () => { closeModal(); send({ t: "next_round" }); });
}

function openResultModal() {
  const rows = [...G.result].sort((a, b) => b.score - a.score);
  openModal("result", `
    <h3>🏆 ${esc(G.seats[G.winner].nick)} 获得最终胜利!</h3>
    ${G.target !== 0 ? `
    <table class="result">
      <tr><th></th><th>总分</th></tr>
      ${rows.map((r) => `
        <tr><td><span class="dot" style="background:${r.color}"></span>${esc(r.nick)}${r.isBot ? " 🤖" : ""}</td>
        <td><b>${r.score}</b></td></tr>`).join("")}
    </table>` : ""}
    <button id="res-close" class="linkish">留在房间看看</button>
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
  localStorage.setItem("bg-nick", nickVal());
  $("home-err").textContent = "";
  return true;
}

function init() {
  $("nick").value = localStorage.getItem("bg-nick") ?? localStorage.getItem("dao-nick") ?? "";
  // 音频保底解锁:这几个按钮必然是真实用户手势,通用监听万一没覆盖到也不会哑
  for (const id of ["btn-create", "btn-join", "btn-start", "btn-addbot"]) {
    $(id).addEventListener("click", () => sfxEnsure());
  }

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
  $("btn-start").onclick = () => send({ t: "start", target: +$("target").value });
  $("deck").onclick = () => { if (myTurn()) send({ t: "draw" }); };
  $("btn-uno").onclick = () => {
    unoArmed = !unoArmed;
    $("btn-uno").classList.toggle("armed", unoArmed);
  };
  $("chat").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && $("chat").value.trim()) {
      send({ t: "chat", text: $("chat").value });
      $("chat").value = "";
    }
  });

  const snd = $("btn-sound");
  const paintSnd = () => {
    snd.textContent = isMuted() ? "🔇" : "🔊";
    snd.classList.toggle("off", isMuted());
  };
  snd.onclick = () => { setMuted(!isMuted()); sfxEnsure(); paintSnd(); };
  paintSnd();

  const room = new URLSearchParams(location.search).get("room");
  if (room) {
    $("join-code").value = room.toUpperCase();
    if (sessionStorage.getItem("yuyi-room") === room.toUpperCase() && nickVal()) {
      connect(room);
    }
  }
}

init();
