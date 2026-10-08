import {
  parseGroups, parseList, parsePairs, groupsToText, listToText, pairsToText,
  dealEach, dealSpy, spyResult, spyCountFor, checksum, hashStr,
} from "./deal.js";
import {
  esc, store, cfg, unlockAudio, sfx, buzz, keepAwake, sheet, closeSheet, isSheetOpen,
  confirmBox, promptBox, toast, api,
} from "./util.js";

// =====================================================================
// 设置 & 词库
// =====================================================================
const DEFAULTS = {
  n: 5,
  names: ["", "", "", "", "", "", "", "", "", ""],
  sound: true, vib: true,
  chTarget: 5, chTime: 60, chDiff: "普通",
  tabooMin: 10,
  catHint: false,
};
const S = { ...DEFAULTS, ...store.get("settings", {}) };
S.names = [...DEFAULTS.names.map((x, i) => S.names?.[i] ?? x)];
const saveS = () => { store.set("settings", S); cfg.sound = S.sound; cfg.vib = S.vib; };
cfg.sound = S.sound; cfg.vib = S.vib;

const GAMES = {
  who: { name: "我是谁", ico: "🤔", color: "#5ab8ff", desc: "额头上的词大家都看得见,只有你自己不知道" },
  charades: { name: "你比我猜", ico: "🙆", color: "#ff5d8f", desc: "一人比划不许出声,60 秒全队合作猜词" },
  taboo: { name: "禁忌动作", ico: "🤫", color: "#3ddc97", desc: "每人一个禁忌自己不知道,别人想办法诱你中招" },
  spy: { name: "谁是卧底", ico: "🕵️", color: "#ffb547", desc: "大家词一样,只有卧底的不一样——找出他" },
};

const BUILTIN_TEXT = {
  who: groupsToText(window.WORDS_WHO),
  charades: groupsToText(window.WORDS_CHARADES),
  taboo: listToText(window.WORDS_TABOO),
  spy: pairsToText(window.WORDS_SPY),
};
let localBank = store.get("bank", {}); // { game: 自定义文本 },没有就是内置
const saveBank = () => store.set("bank", localBank);
const localText = (g) => localBank[g] ?? BUILTIN_TEXT[g];

function itemsOf(game, text) {
  if (game === "who") return Object.entries(parseGroups(text)).flatMap(([c, ws]) => ws.map((w) => ({ w, c })));
  if (game === "taboo") return parseList(text).map((w) => ({ w, c: "" }));
  if (game === "spy") return parsePairs(text);
  return parseGroups(text);
}

const nameOf = (seat, names) => (names && names[seat]) || S.names[seat - 1] || "";
const seatLabel = (seat, names) => {
  const nm = nameOf(seat, names);
  return nm ? `${seat}号 ${nm}` : `${seat}号`;
};
const drinkTxt = (n) => (n ? `${n} 口` : "不喝");

// =====================================================================
// 路由
// =====================================================================
const app = document.getElementById("app");
let route = null;
let prevRoute = "";
const Gcache = {};
let G = null; // 当前房间类游戏的上下文
let CH = null; // 你比我猜的上下文

function go(r) { location.hash = r ? "#/" + r : "#/"; }
window.addEventListener("hashchange", onRoute);
function onRoute() {
  const r = location.hash.replace(/^#\/?/, "");
  if (r === route) return;
  closeSheet();
  settleOpen = false;
  prevRoute = route ?? "";
  route = r;
  if (["who", "taboo", "spy"].includes(r)) G = Gcache[r] ||= makeG(r);
  else G = null;
  if (r === "charades") CH = makeCH(); else { CH && clearInterval(CH.iv); CH = null; }
  keepAwake(!!G && G.view !== "join");
  render();
  window.scrollTo(0, 0);
  if (G && multi()) poll();
}

function render() {
  const r = route;
  let html;
  if (r === "settings") html = viewSettings();
  else if (r === "words") html = viewWords();
  else if (r === "charades") html = viewCharades();
  else if (G) html = viewRoomGame();
  else html = viewHome();
  app.innerHTML = html;
  afterRender();
}

function top(title, { back = "", bar = "" } = {}) {
  return `<div class="top">
    <button class="back" data-act="back" data-to="${back}" aria-label="返回">‹</button>
    <div class="t"><h2>${title}</h2>${bar}</div>
  </div>`;
}

// =====================================================================
// 首页
// =====================================================================
function viewHome() {
  const cards = Object.entries(GAMES).map(([k, g]) => `
    <button class="game" data-act="go" data-to="${k}">
      <div class="ico" style="background:${g.color}22;border:2px solid ${g.color}">${g.ico}</div>
      <div><h3 style="color:${g.color}">${g.name}</h3><p>${g.desc}</p></div>
    </button>`).join("");
  return `
    <div class="hero"><h1>微醺局</h1><p>喝得慢的酒桌小游戏 · 围坐一桌就开玩</p></div>
    <div class="games">${cards}</div>
    <div class="row mt">
      <button class="btn sm" data-act="go" data-to="settings">⚙️ 设置</button>
      <button class="btn sm" data-act="go" data-to="words">📝 词库</button>
    </div>
    <div class="motto">🍻 乐趣在比划、猜词和起哄,酒只是小惩罚:<br>
      惩罚单位统一是「口」,<b>单次最多 2 口</b>,每个游戏一轮结束才结算一次。</div>
    <div class="foot">适量饮酒 · 不喝酒的朋友用饮料代替一样好玩<br>
      <a href="https://games.wawazhiliao.com">🎲 仄梦桌游馆</a></div>`;
}

// =====================================================================
// 设置
// =====================================================================
function stepper(act, val, unit = "") {
  return `<div class="stepper"><button data-act="${act}" data-d="-1">−</button>
    <div class="val">${val}${unit ? `<span class="small dim"> ${unit}</span>` : ""}</div>
    <button data-act="${act}" data-d="1">+</button></div>`;
}
const sw = (key, label, sub = "") => `<div class="toggle" data-act="sw" data-k="${key}">
  <div>${label}${sub ? `<div class="small dim">${sub}</div>` : ""}</div><div class="switch ${S[key] ? "on" : ""}"></div></div>`;

function viewSettings() {
  const names = Array.from({ length: S.n }, (_, i) => `
    <div class="row" style="align-items:center;margin-bottom:8px">
      <div style="flex:none;width:52px;font-weight:800;font-size:22px">${i + 1}号</div>
      <input class="inp" style="font-size:20px;min-height:52px" data-name="${i}" maxlength="8" placeholder="昵称(可空)" value="${esc(S.names[i])}">
    </div>`).join("");
  return `${top("设置")}
    <div class="panel"><div class="label">默认人数</div>${stepper("setN", S.n, "人")}
      <div class="label mt">座位昵称(单机模式 / 你比我猜用)</div>${names}</div>
    <div class="panel mt">
      ${sw("sound", "🔔 声音提示", "倒计时结束、猜对、跳过")}
      ${sw("vib", "📳 震动提示", "iPhone 的浏览器不支持震动")}
      ${sw("catHint", "💡 我是谁:提示自己的类别", "比如告诉你「动物」,降低难度")}
    </div>
    <div class="panel mt">
      <div class="label">你比我猜 · 过关目标</div>${stepper("setTarget", S.chTarget, "个")}
      <div class="label mt">你比我猜 · 每轮时长</div>${stepper("setChTime", S.chTime, "秒")}
      <div class="label mt">禁忌动作 · 每轮时长</div>${stepper("setTaboo", S.tabooMin, "分钟")}
    </div>
    <div class="stack mt">
      <button class="btn" data-act="go" data-to="words">📝 编辑词库</button>
      <button class="btn ghost sm" data-act="resetUsed">清空「你比我猜」出过的词记录</button>
    </div>`;
}

// =====================================================================
// 词库编辑
// =====================================================================
let wordsTab = "who";
const WORD_HELP = {
  who: "一行一个词。「# 类别名」开头的行是分组标题(可以开「💡提示类别」)。",
  charades: "一行一个词。必须分「# 简单」「# 普通」「# 离谱」三组(也可以自己加组)。",
  taboo: "一行一个禁忌。要选聊天十分钟里一不小心就会做、但又不是一秒就中的。",
  spy: "一行一对,用 / 隔开,比如:牛奶 / 豆浆。每轮随机决定谁是平民词。",
};
function hostedRoom() {
  // 当前正当着房主的房间(最近一次进的房间)
  const last = store.get("lastRoom", null);
  if (!last) return null;
  return store.get("host." + last, null) ? last : null;
}
function viewWords() {
  const SHORT = { who: "我是谁", charades: "比划", taboo: "禁忌", spy: "卧底" };
  const tabs = Object.keys(GAMES).map((k) =>
    `<button class="${wordsTab === k ? "on" : ""}" data-act="wtab" data-k="${k}">${SHORT[k]}</button>`).join("");
  const text = localText(wordsTab);
  const custom = localBank[wordsTab] != null;
  const hr = hostedRoom();
  const scope = wordsTab === "charades"
    ? "「你比我猜」只用一部手机,词库存在这台手机上。"
    : hr ? `你是房间 <b>${hr}</b> 的房主:保存后会<b>同步给房间里所有人</b>。`
      : "保存在这台手机上。单机模式直接用;多人模式下,要先在房间里「认领房主」,你的词库才会同步给大家(不然大家用内置词库,保证每部手机算出的词一致)。";
  return `${top("词库")}
    <div class="seg">${tabs}</div>
    <p class="small dim">${WORD_HELP[wordsTab]}</p>
    <div class="panel small" style="padding:12px 14px">${scope}</div>
    <textarea class="bank mt" id="bank-ta" spellcheck="false">${esc(text)}</textarea>
    <p class="small dim" id="bank-count">${countText(wordsTab, text)} · ${custom ? "已自定义" : "内置词库"}</p>
    <div class="stack">
      <button class="btn amber" data-act="saveBank">保存</button>
      <button class="btn ghost sm" data-act="resetBank">恢复内置词库</button>
    </div>`;
}
function countText(game, text) {
  const it = itemsOf(game, text);
  if (game === "spy") return `共 ${it.length} 对`;
  if (game === "charades") return Object.entries(it).map(([k, v]) => `${k} ${v.length}`).join(" · ") || "空";
  return `共 ${it.length} 个`;
}

// =====================================================================
// 房间类游戏(我是谁 / 禁忌动作 / 谁是卧底)
// =====================================================================
function makeG(game) {
  const j = store.get("join." + game, {});
  return {
    game,
    view: "join",
    mode: j.mode || "multi",
    room: j.room || store.get("lastRoom", "") || "",
    round: j.round || 1,
    n: j.n || (game === "spy" ? Math.max(5, S.n) : S.n),
    seat: j.seat || 0,
    name: j.name ?? store.get("myName", ""),
    srv: null, offline: false, skew: 0,
    roomBank: null, bankVer: -1,
    local: { st: {}, timer: null, fix: {} },
    pass: { i: 1, show: false },
    hold: false,
    fired: {},
    iv: 0,
  };
}
const saveJoin = () => {
  store.set("join." + G.game, { mode: G.mode, room: G.room, round: G.round, n: G.n, seat: G.seat, name: G.name });
  if (G.name) store.set("myName", G.name);
};
const rkey = () => `${G.game}:${G.round}`;
const multi = () => G.mode === "multi";
const synced = () => multi() && !G.offline && !!G.srv;
const token = () => store.get("tok." + G.room, null);
const isHost = () => !!(synced() && G.srv.host?.mine);
const rd = () => (synced() ? G.srv.r : G.local);
const roomNames = () => (synced() ? G.srv.names : null);

function bankTextFor(game) {
  if (multi()) return (G.roomBank && G.roomBank[game]) || BUILTIN_TEXT[game];
  return localText(game);
}

let dealMemo = { k: "", v: null };
function curDeal() {
  const text = bankTextFor(G.game);
  const fix = rd().fix || {};
  const room = multi() ? G.room : "solo" + (G.soloSeed ||= String(Math.floor(Math.random() * 1e6)));
  const k = [G.game, room, G.round, G.n, hashStr(text), JSON.stringify(fix)].join("~");
  if (dealMemo.k === k) return dealMemo.v;
  let v;
  try {
    const items = itemsOf(G.game, text);
    v = G.game === "spy" ? dealSpy(items, room, G.round, G.n, fix) : dealEach(G.game, items, room, G.round, G.n, fix);
  } catch (e) {
    v = { error: e.message };
  }
  dealMemo = { k, v };
  return v;
}
function dealCheck(d) {
  if (!d || d.error) return "—";
  return checksum(G.game === "spy" ? [d.civ, d.spy, d.spies] : d.map((x) => x.w));
}

// ---------- 同步 ----------
async function poll() {
  if (!G || !multi() || !/^\d{4}$/.test(G.room)) return;
  const inPlay = G.view === "play";
  const res = await api.state(G.room, inPlay ? rkey() : "", token());
  if (!G) return;
  if (res.offline) {
    if (!G.offline) { G.offline = true; renderSoft(); }
    return;
  }
  if (res.error) return;
  // 只有房间数据真的变了才重绘,免得吞掉正按在按钮上的点击
  const same = !G.offline && G.srv && G.srv.v === res.data.v && G.polledKey === (inPlay ? rkey() : "");
  G.offline = false;
  G.polledKey = inPlay ? rkey() : "";
  applyState(res.data);
  if (res.data.bankVer !== G.bankVer) await loadBank(res.data.bankVer);
  else if (same) return;
  renderSoft();
}
function applyState(d) {
  G.srv = d;
  G.skew = d.now - Date.now();
}
async function loadBank(ver) {
  if (ver === 0) { G.roomBank = null; G.bankVer = 0; return; }
  const b = await api.bank(G.room);
  if (b.data) {
    const changed = G.bankVer >= 0;
    G.roomBank = b.data.bank;
    G.bankVer = b.data.bankVer;
    if (changed && G.view === "play") toast("房主更新了词库,本轮的词可能变了");
  }
}
async function op(body) {
  if (!synced()) return false;
  const res = await api.op(G.room, { k: rkey(), ...body }, token());
  if (res.error) { toast(res.error); return false; }
  if (res.offline) { G.offline = true; toast("网络断了,先用本机记录"); renderSoft(); return false; }
  applyState(res.data);
  if (res.data.bankVer !== G.bankVer) await loadBank(res.data.bankVer);
  renderSoft();
  return true;
}
// 轮询刷新时不打断正在输入的框、不重建打开的弹层
function renderSoft() {
  if (!G) return;
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && app.contains(a)) {
    if (G.view === "join") updateSeatNames();
    return;
  }
  if (G.hold) return;
  render();
  if (isSheetOpen() && settleOpen) openSettle(true);
}
function updateSeatNames() {
  const names = roomNames();
  document.querySelectorAll("[data-seatname]").forEach((el) => {
    el.textContent = nameOf(+el.dataset.seatname, names) || " ";
  });
}

// 本地状态改动(单机模式或离线)
function setSt(seat, patch) {
  if (synced()) {
    const cur = { ...(G.srv.r.st[seat] || {}), ...patch };
    G.srv.r.st[seat] = cur; // 乐观更新
    op({ op: "st", seat, ...patch });
  } else {
    G.local.st[seat] = { ...(G.local.st[seat] || {}), ...patch };
  }
  render();
  if (settleOpen) openSettle(true);
}
const st = (seat) => rd().st?.[seat] || {};

// ---------- 进入 / 换轮 ----------
async function enterRoom() {
  if (multi()) {
    if (!/^\d{4}$/.test(G.room)) return toast("房间码要 4 位数字");
    if (!G.seat || G.seat > G.n) return toast("先选你的座位号");
    saveJoin();
    store.set("lastRoom", G.room);
    G.view = "play";
    G.local = { st: {}, timer: null, fix: {} };
    render();
    keepAwake(true);
    await poll();
    if (synced() && (G.name || "") !== (G.srv.names[G.seat] || "")) op({ op: "name", seat: G.seat, name: G.name });
  } else {
    saveJoin();
    G.local = { st: {}, timer: null, fix: {} };
    G.view = "pass";
    G.pass = { i: 1, show: false };
    render();
    keepAwake(true);
  }
}

async function nextRound() {
  const ok = await confirmBox(`进入第 ${G.round + 1} 轮?`, multi() ? "提醒大家也点「下一轮」,轮数对齐才能看到一样的词。" : "会重新传看一遍新词。", "下一轮");
  if (!ok) return;
  setRound(G.round + 1);
}
function setRound(r) {
  G.round = Math.max(1, Math.min(9999, r));
  G.local = { st: {}, timer: null, fix: {} };
  G.fired = {};
  G.hold = false;
  saveJoin();
  if (multi()) {
    if (G.srv) G.srv = { ...G.srv, r: { fix: {}, st: {}, timer: null } };
    render();
    poll();
  } else {
    G.view = "pass";
    G.pass = { i: 1, show: false };
    render();
  }
  window.scrollTo(0, 0);
}

// ---------- 视图 ----------
function viewRoomGame() {
  const g = GAMES[G.game];
  if (G.view === "join") return viewJoin(g);
  if (G.view === "pass") return viewPass(g);
  return viewPlay(g);
}

function viewJoin(g) {
  const isSpy = G.game === "spy";
  const minN = isSpy ? 4 : 3;
  if (G.n < minN) G.n = minN;
  const seg = `<div class="seg">
    <button class="${multi() ? "on" : ""}" data-act="mode" data-k="multi">📱 每人一部手机</button>
    <button class="${!multi() ? "on" : ""}" data-act="mode" data-k="single">🤳 只有一部</button></div>`;
  const nPanel = `<div class="field"><div class="label">人数</div>${stepper("joinN", G.n, "人")}
    ${isSpy ? `<p class="small dim" style="margin:6px 0 0">${G.n} 人局:${spyCountFor(G.n)} 个卧底(7 人起 2 个)</p>` : ""}</div>`;
  let body;
  if (multi()) {
    const names = roomNames();
    const seats = Array.from({ length: G.n }, (_, i) => {
      const s = i + 1;
      return `<button class="${G.seat === s ? "on" : ""}" data-act="seat" data-s="${s}">${s}<small data-seatname="${s}">${esc(nameOf(s, names)) || "&nbsp;"}</small></button>`;
    }).join("");
    body = `
      <div class="field"><div class="label">房间码(4 位数字,大家填一样的)</div>
        <div class="row"><input class="inp code" id="j-room" inputmode="numeric" maxlength="4" placeholder="····" value="${esc(G.room)}" style="flex:3">
        <button class="btn sm" data-act="randRoom" style="flex:1;min-height:60px">🎲 随机</button></div></div>
      <div class="field"><div class="label">轮数(大家对齐)</div>${stepper("joinRound", G.round)}</div>
      ${nPanel}
      <div class="field"><div class="label">我坐几号</div><div class="seats">${seats}</div></div>
      <div class="field"><div class="label">我的昵称(可空,会显示在别人手机上)</div>
        <input class="inp" id="j-name" maxlength="8" placeholder="比如:阿杰" value="${esc(G.name)}"></div>
      <button class="btn amber xl" data-act="enter">进入房间</button>
      <p class="small dim center">${isSpy ? "每部手机只显示你自己的词" : "每部手机能看到其他人的词,自己的显示为「？？？」"}<br>
        ${G.offline ? "⚠️ 当前连不上同步服务,照样能玩(用内置词库)" : ""}</p>`;
  } else {
    body = `${nPanel}
      <div class="panel small">${isSpy
        ? "手机依次传给每个人,各自偷偷看自己的词。"
        : "屏幕会依次提示「请 X 号闭眼,其他人看」,把每个人的词给其余人看一遍。"}
        昵称在 <a href="#/settings">设置</a> 里改。</div>
      <button class="btn amber xl mt" data-act="enter">开始传看</button>`;
  }
  return `${top(g.ico + " " + g.name)}${seg}<div class="mt">${body}</div>${rulesBlock()}`;
}

function roomBar(d) {
  const ck = dealCheck(d);
  const parts = [];
  if (multi()) parts.push(`<span class="chip big">房间 ${esc(G.room)}</span>`);
  parts.push(`<button class="chip big" data-act="editRound">第 ${G.round} 轮</button>`);
  parts.push(`<span class="chip">${G.n}人</span>`);
  if (multi()) {
    parts.push(`<span class="chip">校验 ${ck}</span>`);
    parts.push(G.offline || !G.srv ? `<span class="chip warn">未同步</span>` : `<span class="chip ok">● 同步</span>`);
    const h = synced() ? G.srv.host : null;
    if (synced()) parts.push(`<button class="chip host" data-act="hostMenu">${h ? (h.mine ? "👑 我是房主" : `👑 ${h.seat ? h.seat + "号" : "有"}房主`) : "👑 认领房主"}</button>`);
  }
  return `<div class="roombar">${parts.join("")}</div>`;
}

function viewPlay(g) {
  const d = curDeal();
  const header = top(g.ico + " " + g.name, { back: "join", bar: roomBar(d) });
  if (d.error) return `${header}<div class="panel">⚠️ ${esc(d.error)}<br>去词库里多加点词吧。</div>`;
  let body = "";
  if (G.game === "who") body = playWho(d);
  else if (G.game === "taboo") body = playTaboo(d);
  else body = playSpy(d);
  return header + body + rulesBlock();
}

// ---------- 我是谁 ----------
function wordCard(d, s, { hideAll = false, extra = "" } = {}) {
  const me = multi() && s === G.seat;
  const x = d[s - 1];
  const sst = st(s);
  const out = !!sst.out;
  const names = roomNames();
  let word, cat = "";
  if (me && !out) {
    word = "？？？";
    if (G.game === "who" && S.catHint && x.c) cat = `类别:${esc(x.c)}`;
  } else if (hideAll && !out) word = "🙈";
  else { word = esc(x.w); if (x.c && G.game === "who") cat = esc(x.c); }
  const badge = G.game === "who"
    ? out ? `<span class="chip ok badge">✓ 猜中</span>` : sst.wrong ? `<span class="chip warn badge">错 ${sst.wrong}</span>` : ""
    : out ? `<span class="chip bad badge">😵 中招</span>` : "";
  let hostops = "";
  if (isHost() && !out) {
    hostops = me
      ? `<div class="hostops"><button data-act="reroll" data-s="${s}">🔄 换掉我的</button></div>`
      : `<div class="hostops"><button data-act="reroll" data-s="${s}">🔄 换</button><button data-act="setWord" data-s="${s}">✏️ 改</button></div>`;
  }
  const long = (x.w || "").length > 6 && word === esc(x.w) ? "long" : "";
  return `<div class="wcard ${me ? "me" : ""} ${out ? "out" : ""}">
    <div class="who"><b>${s}号</b><span class="nm">${esc(nameOf(s, names))}</span>${me ? `<span class="chip warn">我</span>` : ""}${badge}</div>
    <div class="word ${long}">${word}</div>${cat ? `<div class="cat">${cat}</div>` : ""}${hostops}${extra}</div>`;
}

function playWho(d) {
  const seats = [...Array(G.n)].map((_, i) => i + 1);
  const left = seats.filter((s) => !st(s).out);
  let banner = "";
  if (left.length === 1) banner = `<div class="banner">只剩 ${seatLabel(left[0], roomNames())} 没猜出来!本轮结束 🍻<br><span class="small">去结算吧</span></div>`;
  else if (left.length === 0) banner = `<div class="banner good">全员猜中!本轮结束</div>`;

  if (multi()) {
    const me = st(G.seat);
    const mine = d[G.seat - 1];
    const panel = me.out
      ? `<div class="reveal"><div class="dim">你的词是</div><div class="w">${esc(mine.w)}</div><div class="small dim">已猜中,退出本轮 🎉</div></div>`
      : `<div class="row"><button class="btn col" data-act="wrong">❌ 猜错了<span class="small dim">+1 口 · 结算时算</span></button>
           <button class="btn mint" data-act="gotIt">🎉 我猜对了</button></div>
         <p class="small dim center" style="margin:8px 0 0">${me.wrong ? `本轮已猜错 ${me.wrong} 次` : "先问一个「是 / 不是」的问题,再决定猜不猜"}</p>`;
    return `${banner}<div class="cards">${seats.map((s) => wordCard(d, s)).join("")}</div>
      <div class="mepanel">${panel}</div>${footBtns()}`;
  }
  // 单机:词都藏起来,只在猜中时翻开
  const cards = seats.map((s) => {
    const sst = st(s);
    const ops = sst.out ? "" : `<div class="hostops"><button data-act="soloWrong" data-s="${s}" style="background:rgba(255,181,71,.16);color:var(--amber)">错 +1</button>
      <button data-act="soloGot" data-s="${s}" style="background:rgba(61,220,151,.16);color:var(--mint)">猜对</button></div>`;
    return wordCard(d, s, { hideAll: true, extra: ops });
  }).join("");
  return `${banner}<div class="cards">${cards}</div>
    <button class="btn ghost sm mt" data-act="repass">🙈 再传看一遍</button>${footBtns()}`;
}

function footBtns() {
  return `<div class="row mt"><button class="btn sky" data-act="settle">🧾 本轮结算</button>
    <button class="btn amber" data-act="next">下一轮 →</button></div>`;
}

// ---------- 禁忌动作 ----------
function timerEnd() {
  const t = rd().timer;
  if (!t) return null;
  return synced() ? t.end - G.skew : t.end;
}
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function timerBox() {
  const end = timerEnd();
  const dur = S.tabooMin * 60;
  if (!end) {
    return `<div class="tbox"><div class="timer dim">${fmt(dur * 1000)}</div>
      <button class="btn mint mt" data-act="tStart">⏱ 开始倒计时 ${S.tabooMin} 分钟</button>
      ${multi() ? `<p class="small dim center" style="margin:6px 0 0">任何一人点开始,所有手机一起倒计时</p>` : ""}</div>`;
  }
  const left = end - Date.now();
  return `<div class="tbox"><div class="timer ${left <= 60000 ? "hot" : left <= 180000 ? "warn" : ""}" id="tTimer">${left > 0 ? fmt(left) : "时间到!"}</div>
    <div class="row mt"><button class="btn ghost sm" data-act="tReset">重置</button></div></div>`;
}
function playTaboo(d) {
  const seats = [...Array(G.n)].map((_, i) => i + 1);
  const end = timerEnd();
  const over = end && end - Date.now() <= 0;
  const banner = over ? `<div class="banner">⏰ 时间到!没中招的人获胜,各指定一个人喝 1 口</div>` : "";
  if (multi()) {
    const me = st(G.seat);
    const mine = d[G.seat - 1];
    const panel = me.out
      ? `<div class="reveal" style="border-color:var(--red);background:linear-gradient(160deg,rgba(255,90,90,.16),var(--card))">
          <div class="dim">你的禁忌是</div><div class="w" style="color:var(--red)">${esc(mine.w)}</div><div class="small dim">中招出局,喝 1 口(结算时算)</div></div>`
      : `<button class="btn red xl" data-act="caught">😵 我中招了</button>
         <p class="small dim center" style="margin:8px 0 0">被大家喊「中了!」就点它,会揭晓你的禁忌</p>`;
    return `${timerBox()}${banner}<div class="cards">${seats.map((s) => wordCard(d, s)).join("")}</div>
      <div class="mepanel">${panel}</div>${footBtns()}`;
  }
  const cards = seats.map((s) => {
    const ops = st(s).out ? "" : `<div class="hostops"><button data-act="soloCaught" data-s="${s}" style="background:rgba(255,90,90,.16);color:var(--red)">😵 中招</button></div>`;
    return wordCard(d, s, { hideAll: true, extra: ops });
  }).join("");
  return `${timerBox()}${banner}<div class="cards">${cards}</div>
    <button class="btn ghost sm mt" data-act="repass">🙈 再传看一遍</button>${footBtns()}`;
}

// ---------- 谁是卧底 ----------
function playSpy(d) {
  const names = roomNames();
  const outs = Object.entries(rd().st || {}).filter(([, v]) => v.out).map(([k]) => +k);
  const res = spyResult(d, outs);
  let holdHtml = "";
  if (multi()) {
    const mine = d.seats[G.seat - 1];
    const meOut = outs.includes(G.seat);
    holdHtml = `<div class="hold ${G.hold ? "on" : ""}" data-hold="1">
      ${G.hold || res ? `<div class="dim">你的词</div><div class="w">${esc(mine.w)}</div>${res ? `<div class="chip ${mine.spy ? "host" : "ok"}">${mine.spy ? "🕵️ 你是卧底" : "🙂 你是平民"}</div>` : ""}`
        : `<div style="font-size:48px">👆</div><div class="ttl" style="font-size:26px">按住看你的词</div><div class="small dim">松手就藏起来,别让旁边的人瞄到</div>`}
    </div>${meOut && !res ? `<p class="center dim">你已出局,安静围观吧 🍿</p>` : ""}`;
  }
  const alive = d.seats.length - outs.length;
  const info = res ? "" : `<div class="panel mt center">
      <div>本轮 ${G.n} 人 · <b>${d.spies.length}</b> 个卧底 · 还剩 ${alive} 人</div>
      <div class="ttl mt" style="font-size:24px;color:var(--amber)">从 ${seatLabel(d.start, names)} 开始,顺时针描述</div>
      <div class="small dim">每人一句话描述自己的词,不能直接说出词;说完一圈就投票</div></div>`;
  const seatsHtml = d.seats.map((x, i) => {
    const s = i + 1;
    const out = outs.includes(s);
    const cls = [out ? "out" : "", multi() && s === G.seat ? "me" : "", res && x.spy ? "isspy" : ""].join(" ");
    return `<button class="${cls}" data-act="${res ? "" : "voteOut"}" data-s="${s}">${s}<small>${esc(nameOf(s, names)) || (res ? (x.spy ? "卧底" : "平民") : "&nbsp;")}</small></button>`;
  }).join("");
  let result = "";
  if (res) {
    const civWin = res === "civ";
    const lines = d.seats.map((x, i) => {
      const s = i + 1;
      const drink = civWin ? (x.spy ? 2 : 0) : x.spy ? 0 : 1;
      return `<div class="settle-row"><div class="n">${s}号<small>${esc(nameOf(s, names))}</small></div>
        <div class="mid"><span class="chip ${x.spy ? "host" : ""}">${x.spy ? "🕵️ 卧底" : "平民"}</span><span>${esc(x.w)}</span></div>
        <div class="drink ${drink ? "" : "zero"}">${drinkTxt(drink)}</div></div>`;
    }).join("");
    result = `<div class="banner ${civWin ? "good" : ""}">${civWin ? "🎉 卧底全部出局,平民胜利!" : "🕵️ 卧底撑到最后,卧底胜利!"}</div>
      <div class="panel"><div class="row center" style="margin-bottom:8px"><div><div class="small dim">平民词</div><b style="font-size:26px">${esc(d.civ)}</b></div>
        <div><div class="small dim">卧底词</div><b style="font-size:26px;color:var(--pink)">${esc(d.spy)}</b></div></div>
        ${lines}<p class="small dim" style="margin:8px 0 0">${civWin ? "平民胜:每个卧底喝 2 口" : "卧底胜:每个平民喝 1 口"}</p></div>`;
  }
  let hostops = "";
  if (isHost() && !res) {
    hostops = `<div class="row mt"><button class="btn sm" data-act="spyReroll">🔄 换一组词</button>
      <button class="btn sm" data-act="spySet">✏️ 指定词</button></div>`;
  }
  const solo = multi() ? "" : `<button class="btn ghost sm mt" data-act="repass">🙈 再传看一遍</button>`;
  return `${holdHtml}${result}${info}
    <div class="label mt">${res ? "本轮身份" : "投票结果出来后,点被投出的人"}</div>
    <div class="spyseats">${seatsHtml}</div>
    ${outs.length && !res ? `<button class="btn ghost sm mt" data-act="spyUndo">↩️ 撤销上一次出局</button>` : ""}
    ${hostops}${solo}
    <div class="row mt"><button class="btn amber" data-act="next">下一轮 →</button></div>`;
}

// ---------- 单机传看 ----------
function viewPass(g) {
  const d = curDeal();
  const header = top(g.ico + " " + g.name, { back: "join", bar: roomBar(d) });
  if (d.error) return `${header}<div class="panel">⚠️ ${esc(d.error)}</div>`;
  const i = G.pass.i;
  const lbl = seatLabel(i);
  const spy = G.game === "spy";
  if (!G.pass.show) {
    return `${header}<div class="pass">
      <div class="small dim">${i} / ${G.n}</div>
      ${spy ? `<div class="say">请把手机交给</div><div class="seatbig">${i}号</div><div class="say">${esc(nameOf(i))}</div>
        <button class="btn amber xl" data-act="passShow">我是 ${i} 号,看词</button>`
      : `<div class="seatbig">🙈</div><div class="say">请 <span style="color:var(--amber)">${esc(lbl)}</span> 闭眼<br>其他人看屏幕</div>
        <button class="btn amber xl" data-act="passShow">${i} 号闭好眼了,显示</button>`}
      <button class="btn ghost sm" data-act="passSkip">跳过传看,直接开始</button></div>`;
  }
  const w = spy ? d.seats[i - 1].w : d[i - 1].w;
  const last = i >= G.n;
  return `${header}<div class="pass">
    <div class="say">${spy ? "你的词是" : `${esc(lbl)} 的${G.game === "who" ? "词" : "禁忌"}`}</div>
    <div class="w" style="color:var(--amber)">${esc(w)}</div>
    ${spy ? `<p class="dim">记住它,别给别人看</p>` : `<p class="dim">其他人记住了吗?</p>`}
    <button class="btn mint xl" data-act="passNext">${last ? "都看完了,开始!" : spy ? "记住了,藏起来交给下一位" : `看好了,让 ${i} 号睁眼`}</button></div>`;
}

// ---------- 规则 ----------
function rulesBlock() {
  const R = {
    who: `<ol><li>每人分到一个词(人物、动物、食物、物品……),<b>自己看不到,别人都看得到</b>。</li>
      <li>大家轮流向其他人问一个只能回答「是 / 不是」的问题,问完可以选择猜自己的词。</li>
      <li>猜对:在自己手机上点「我猜对了」揭晓,退出本轮。</li>
      <li>猜错:记 1 口。</li>
      <li>最后一个没猜出来的人喝 2 口,本轮结束。</li>
      <li>每人每轮最多 2 口,一轮结束统一结算。</li></ol>`,
    taboo: `<ol><li>每人分到一个禁忌(比如摸头发、说「我觉得」),<b>自己看不到,别人都看得到</b>。</li>
      <li>大家正常聊天喝酒,想办法诱导别人触发他的禁忌。</li>
      <li>有人触发了,大家喊「中了!」——他在自己手机上点「我中招了」揭晓,喝 1 口并出局。</li>
      <li>倒计时结束还没中招的人获胜,每人可指定一个人喝 1 口。</li>
      <li>每人每轮最多 2 口,一轮结束统一结算。</li></ol>`,
    spy: `<ol><li>大部分人拿到相同的「平民词」,1~2 人拿到相似的「卧底词」。谁都不知道自己是不是卧底。</li>
      <li>从屏幕提示的人开始,轮流用一句话描述自己的词(不能直接说出词)。</li>
      <li>一圈说完,大家投票,得票最多的人出局,在手机上点他的座位号。</li>
      <li>卧底全部出局 → 平民胜,每个卧底喝 2 口;平民剩到和卧底一样多 → 卧底胜,每个平民喝 1 口。</li>
      <li>平票就这两人再各说一句,重新投。</li></ol>`,
  };
  return `<details class="rules"><summary>📖 规则</summary>${R[G.game]}</details>`;
}

// ---------- 结算 ----------
let settleOpen = false;
function openSettle(refresh = false) {
  if (!G) return;
  const d = curDeal();
  if (d.error) return;
  const names = roomNames();
  const seats = [...Array(G.n)].map((_, i) => i + 1);
  let rows = "", note = "";
  if (G.game === "who") {
    const left = seats.filter((s) => !st(s).out);
    rows = seats.map((s) => {
      const x = st(s);
      const lastOne = !x.out;
      const raw = (x.wrong || 0) + (lastOne ? 2 : 0);
      const drink = Math.min(2, raw);
      return `<div class="settle-row"><div class="n">${s}号<small>${esc(nameOf(s, names))}</small></div>
        <div class="mid nw"><button class="mini ${x.out ? "on" : ""}" data-m="tglOut" data-s="${s}">${x.out ? "✓ 猜中" : "没猜出"}</button>
          <span class="small dim" style="margin-left:4px">错</span><button class="mini" data-m="wrongD" data-s="${s}" data-d="-1">−</button><b>${x.wrong || 0}</b><button class="mini" data-m="wrongD" data-s="${s}" data-d="1">+</button></div>
        <div class="drink ${drink ? "" : "zero"}">${drinkTxt(drink)}</div></div>`;
    }).join("");
    note = left.length > 1 ? `还有 ${left.length} 人没猜出来;按规则「没猜出来的」每人 +2(封顶 2 口)。` : "猜错 1 次 1 口,没猜出来 +2,每人封顶 2 口。";
  } else {
    const picks = {};
    seats.forEach((s) => { const p = st(s).pick; if (!st(s).out && p) picks[p] = (picks[p] || 0) + 1; });
    rows = seats.map((s) => {
      const x = st(s);
      const drink = Math.min(2, (x.out ? 1 : 0) + (picks[s] || 0));
      const chooser = x.out ? "" : `<span class="small dim">指定:</span>` + seats.filter((t) => t !== s)
        .map((t) => `<button class="mini ${x.pick === t ? "pinkon" : ""}" data-m="pick" data-s="${s}" data-t="${t}">${t}</button>`).join("");
      return `<div class="settle-row"><div class="n">${s}号<small>${esc(nameOf(s, names))}</small></div>
        <div class="mid"><button class="mini ${x.out ? "on" : ""}" data-m="tglOut" data-s="${s}">${x.out ? "😵 中招" : "🏆 幸存"}</button>${chooser}</div>
        <div class="drink ${drink ? "" : "zero"}">${drinkTxt(drink)}</div></div>`;
    }).join("");
    note = "中招 1 口;幸存者每人点一个号码,被点的人 +1 口。每人封顶 2 口。";
  }
  const words = G.game === "who" || G.game === "taboo"
    ? `<details class="rules" style="margin-top:12px"><summary>本轮所有人的${G.game === "who" ? "词" : "禁忌"}</summary><ul>${seats.map((s) => `<li>${s}号:${multi() && s === G.seat && !st(s).out ? "？？？(你自己的,先别看)" : esc(d[s - 1].w)}</li>`).join("")}</ul></details>`
    : "";
  const html = `<h3>🧾 第 ${G.round} 轮结算</h3><div>${rows}</div><p class="small dim">${note}${synced() ? " 改动会同步到所有手机。" : ""}</p>
    ${words}<div class="stack mt"><button class="btn amber" data-m="next">喝完了,下一轮 →</button><button class="btn ghost sm" data-m="close">关闭</button></div>`;
  if (refresh && isSheetOpen()) {
    document.querySelector(".modal .sheet").innerHTML = html;
    return;
  }
  settleOpen = true;
  sheet(html, (a, b) => {
    if (a === "_close" || a === "close") { settleOpen = false; closeSheet(); return; }
    if (a === "next") { settleOpen = false; closeSheet(); setRound(G.round + 1); return; }
    const s = +b?.dataset.s;
    if (a === "tglOut") setSt(s, { out: !st(s).out });
    if (a === "wrongD") setSt(s, { wrong: Math.max(0, Math.min(9, (st(s).wrong || 0) + +b.dataset.d)) });
    if (a === "pick") { const t = +b.dataset.t; setSt(s, { pick: st(s).pick === t ? 0 : t }); }
  });
}

// =====================================================================
// 你比我猜
// =====================================================================
function makeCH() {
  return { view: "setup", diff: S.chDiff, performer: store.get("chPerformer", 1), word: "", ok: [], skip: [], end: 0, iv: 0, count: 3, lastTick: -1, flash: "" };
}
function chPool(diff) {
  const groups = itemsOf("charades", localText("charades"));
  if (diff === "混合") return [...new Set(Object.values(groups).flat())];
  return groups[diff] || [];
}
function chNext() {
  const pool = chPool(CH.diff);
  if (!pool.length) { CH.word = "(词库空了)"; return; }
  const key = "used.ch." + CH.diff;
  let used = new Set(store.get(key, []));
  const thisRound = new Set([...CH.ok, ...CH.skip, CH.word]);
  let cand = pool.filter((w) => !used.has(w) && !thisRound.has(w));
  if (!cand.length) { used = new Set(); cand = pool.filter((w) => !thisRound.has(w)); if (!cand.length) cand = pool; toast("这一档的词都出过一遍了,重新洗牌"); }
  CH.word = cand[Math.floor(Math.random() * cand.length)];
  used.add(CH.word);
  store.set(key, [...used]);
}
function viewCharades() {
  const g = GAMES.charades;
  const n = S.n;
  if (CH.view === "setup") {
    const diffs = ["简单", "普通", "离谱", "混合"].map((x) => `<button class="${CH.diff === x ? "on" : ""}" data-act="chDiff" data-k="${x}">${x}</button>`).join("");
    const perf = Array.from({ length: n }, (_, i) => `<button class="${CH.performer === i + 1 ? "on" : ""}" data-act="chPerf" data-s="${i + 1}">${i + 1}<small>${esc(S.names[i]) || "&nbsp;"}</small></button>`).join("");
    return `${top(g.ico + " " + g.name)}
      <div class="field"><div class="label">难度</div><div class="seg">${diffs}</div></div>
      <div class="field"><div class="label">这一轮谁来比划</div><div class="seats">${perf}</div></div>
      <div class="panel small">⏱ ${S.chTime} 秒内猜对 <b>${S.chTarget}</b> 个算过关(在 <a href="#/settings">设置</a> 里改)<br>
        ❌ 没过关:全员喝 1 口 · ✅ 过关:表演者指定一个人喝 1 口</div>
      <button class="btn pink xl mt" data-act="chReady">开始</button>
      <details class="rules"><summary>📖 规则</summary><ol>
        <li>只用一部手机,表演者拿着看词,其余人猜。</li>
        <li>表演者只能比划动作,<b>不能说话、不能对口型</b>,也不能指着实物。</li>
        <li>有人猜对就点「猜对了」,太难就点「跳过」换下一个。</li>
        <li>大家是一队的:${S.chTime} 秒内猜对 ${S.chTarget} 个过关。</li>
        <li>没过关全员喝 1 口;过关由表演者指定一个人喝 1 口。</li></ol></details>`;
  }
  if (CH.view === "count") {
    return `${top(g.ico + " " + g.name, { back: "chSetup" })}
      <div class="pass"><div class="say">${esc(seatLabel(CH.performer))} 表演</div><div class="count3">${CH.count || "开始!"}</div>
      <p class="dim">其他人准备猜</p></div>`;
  }
  if (CH.view === "play") {
    const left = CH.end - Date.now();
    return `<div class="ch-stage" style="padding-top:calc(12px + env(safe-area-inset-top))">
      <div class="ch-score"><span>✅ <b>${CH.ok.length}</b> / ${S.chTarget}</span>
        <span class="timer ${left <= 10000 ? "hot" : ""}" id="chTimer" style="font-size:52px">${Math.max(0, Math.ceil(left / 1000))}</span>
        <span class="dim">跳过 ${CH.skip.length}</span></div>
      <div class="ch-word ${CH.word.length > 5 ? "long" : ""} ${CH.flash}">${esc(CH.word)}</div>
      <div class="ch-btns"><button class="btn mint" data-act="chOk">✅ 猜对了</button><button class="btn amber" data-act="chSkip">跳过</button></div>
      <button class="btn ghost sm" data-act="chStop">提前结束</button></div>`;
  }
  // result
  const pass = CH.ok.length >= S.chTarget;
  const nextP = (CH.performer % n) + 1;
  return `${top(g.ico + " " + g.name, { back: "chSetup" })}
    <div class="banner ${pass ? "good" : ""}" style="font-size:24px">${pass ? `🎉 过关!猜对 ${CH.ok.length} 个` : `😅 没过关,猜对 ${CH.ok.length} / ${S.chTarget}`}</div>
    <div class="panel center"><div class="ttl" style="font-size:26px;color:var(--amber)">${pass ? `请 ${esc(seatLabel(CH.performer))} 指定一个人喝 1 口` : "全员各喝 1 口 🍻"}</div></div>
    <div class="label mt">✅ 猜对的(${CH.ok.length})</div><div class="list ok">${CH.ok.map((w) => `<span>${esc(w)}</span>`).join("") || `<span class="dim">无</span>`}</div>
    <div class="label mt">⏭ 跳过的(${CH.skip.length})</div><div class="list skip">${CH.skip.map((w) => `<span>${esc(w)}</span>`).join("") || `<span class="dim">无</span>`}</div>
    <div class="panel mt center"><div class="dim">下一位表演者</div><div class="ttl" style="font-size:34px">${esc(seatLabel(nextP))}</div></div>
    <button class="btn pink xl mt" data-act="chNextPerf">把手机交给 ${nextP} 号,开始</button>
    <button class="btn ghost sm mt" data-act="chSetup">换难度 / 换人</button>`;
}
function chStartCount() {
  CH.view = "count"; CH.count = 3; CH.ok = []; CH.skip = []; CH.word = "";
  keepAwake(true);
  render(); sfx.tick();
  clearInterval(CH.iv);
  CH.iv = setInterval(() => {
    if (!CH) return;
    CH.count--;
    if (CH.count > 0) { sfx.tick(); render(); return; }
    clearInterval(CH.iv);
    sfx.go(); buzz(80);
    CH.view = "play";
    CH.end = Date.now() + S.chTime * 1000;
    CH.lastTick = -1;
    chNext();
    render();
    CH.iv = setInterval(chTick, 200);
  }, 900);
}
function chTick() {
  if (!CH || CH.view !== "play") return;
  const left = CH.end - Date.now();
  const sec = Math.max(0, Math.ceil(left / 1000));
  const el = document.getElementById("chTimer");
  if (el) { el.textContent = sec; el.classList.toggle("hot", left <= 10000); }
  if (sec <= 5 && sec > 0 && sec !== CH.lastTick) { CH.lastTick = sec; sfx.tick(); }
  if (left <= 0) chFinish();
}
function chFinish() {
  clearInterval(CH.iv);
  sfx.end(); buzz([300, 120, 300, 120, 500]);
  CH.view = "result";
  render();
}
let chLastTap = 0;
function chMark(ok) {
  const now = Date.now();
  if (now - chLastTap < 350) return; // 防手抖连点
  chLastTap = now;
  (ok ? CH.ok : CH.skip).push(CH.word);
  ok ? sfx.ok() : sfx.skip();
  buzz(ok ? 40 : 20);
  chNext();
  CH.flash = ok ? "flash-ok" : "flash-skip";
  render();
  CH.flash = "";
}

// =====================================================================
// 定时刷新:禁忌倒计时
// =====================================================================
setInterval(() => {
  if (!G || G.game !== "taboo" || G.view !== "play") return;
  const end = timerEnd();
  if (!end) return;
  const left = end - Date.now();
  const el = document.getElementById("tTimer");
  if (el) {
    el.textContent = left > 0 ? fmt(left) : "时间到!";
    el.className = "timer " + (left <= 60000 ? "hot" : left <= 180000 ? "warn" : "");
  }
  const sec = Math.ceil(left / 1000);
  if (sec <= 5 && sec > 0 && G.fired.tick !== sec) { G.fired.tick = sec; sfx.tick(); }
  const fid = "end" + Math.round(end / 1000);
  if (left <= 0 && !G.fired[fid]) {
    G.fired[fid] = true;
    // 刚进房间时倒计时早就结束了,就不再响
    if (left > -15000) { sfx.end(); buzz([400, 150, 400, 150, 600]); }
    render();
    if (left > -15000 && !isSheetOpen()) openSettle();
  }
}, 250);

let pollIv = 0;
function afterRender() {
  clearInterval(pollIv);
  if (G && multi() && (G.view === "play" || G.view === "join")) {
    pollIv = setInterval(poll, G.view === "play" ? 2500 : 4000);
  }
}

// =====================================================================
// 事件
// =====================================================================
document.addEventListener("pointerdown", unlockAudio, { capture: true });

app.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "j-room") {
    t.value = t.value.replace(/\D/g, "").slice(0, 4);
    G.room = t.value;
    if (G.room.length === 4) { G.srv = null; G.bankVer = -1; G.roomBank = null; poll(); }
  } else if (t.id === "j-name") G.name = t.value.trim();
  else if (t.dataset.name !== undefined) { S.names[+t.dataset.name] = t.value.trim(); saveS(); }
  else if (t.id === "bank-ta") {
    const c = document.getElementById("bank-count");
    if (c) c.textContent = countText(wordsTab, t.value) + " · 未保存";
  }
});

// 卧底:按住看词
app.addEventListener("pointerdown", (e) => {
  if (e.target.closest("[data-hold]") && G) { G.hold = true; render(); buzz(15); }
});
const release = () => { if (G && G.hold) { G.hold = false; render(); } };
window.addEventListener("pointerup", release);
window.addEventListener("pointercancel", release);
app.addEventListener("contextmenu", (e) => { if (e.target.closest("[data-hold]")) e.preventDefault(); });

app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !b.dataset.act) return;
  const a = b.dataset.act, ds = b.dataset;
  const A = ACTIONS[a];
  if (A) await A(ds, b);
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ACTIONS = {
  go: (ds) => go(ds.to),
  back(ds) {
    if (ds.to === "join" && G) { G.view = "join"; G.hold = false; keepAwake(false); render(); return; }
    if (ds.to === "chSetup" && CH) { clearInterval(CH.iv); CH.view = "setup"; keepAwake(false); render(); return; }
    // 设置 / 词库:从游戏里点进来的就回到游戏
    go(["who", "taboo", "spy", "charades"].includes(prevRoute) ? prevRoute : "");
  },
  // 设置
  setN(ds) { S.n = clamp(S.n + +ds.d, 3, 10); saveS(); render(); },
  setTarget(ds) { S.chTarget = clamp(S.chTarget + +ds.d, 1, 15); saveS(); render(); },
  setChTime(ds) { S.chTime = clamp(S.chTime + 15 * +ds.d, 30, 180); saveS(); render(); },
  setTaboo(ds) { S.tabooMin = clamp(S.tabooMin + +ds.d, 1, 30); saveS(); render(); },
  sw(ds) { S[ds.k] = !S[ds.k]; saveS(); render(); },
  async resetUsed() {
    if (!(await confirmBox("清空出词记录?", "清空后,「你比我猜」之前出过的词可能会再出现。"))) return;
    for (const d of ["简单", "普通", "离谱", "混合"]) store.del("used.ch." + d);
    toast("已清空");
  },
  // 词库
  wtab(ds) { wordsTab = ds.k; render(); },
  async saveBank() {
    const text = document.getElementById("bank-ta").value;
    const items = itemsOf(wordsTab, text);
    const cnt = wordsTab === "charades" ? Object.values(items).flat().length : items.length;
    if (cnt < (wordsTab === "spy" ? 1 : 10)) return toast(wordsTab === "spy" ? "至少要 1 对词" : "至少要 10 个词");
    if (wordsTab === "charades" && !["简单", "普通", "离谱"].every((k) => items[k]?.length)) {
      if (!(await confirmBox("缺少难度分组", "比划词库没有「# 简单」「# 普通」「# 离谱」三个分组,缺的那档会选不了。仍然保存?", "仍然保存"))) return;
    }
    localBank[wordsTab] = text === BUILTIN_TEXT[wordsTab] ? undefined : text;
    if (localBank[wordsTab] === undefined) delete localBank[wordsTab];
    saveBank();
    const hr = hostedRoom();
    if (hr && wordsTab !== "charades") {
      const ok = await pushBank(hr);
      toast(ok ? `已保存,并同步到房间 ${hr}` : "已保存在本机,同步到房间失败");
    } else toast("已保存");
    render();
  },
  async resetBank() {
    if (!(await confirmBox("恢复内置词库?", `「${GAMES[wordsTab].name}」的自定义内容会被清掉。`, "恢复", "red"))) return;
    delete localBank[wordsTab];
    saveBank();
    const hr = hostedRoom();
    if (hr && wordsTab !== "charades") await pushBank(hr);
    toast("已恢复");
    render();
  },
  // 加入
  mode(ds) { G.mode = ds.k; render(); },
  randRoom() { G.room = String(1000 + Math.floor(Math.random() * 9000)); G.srv = null; G.bankVer = -1; G.roomBank = null; render(); poll(); },
  joinRound(ds) { G.round = clamp(G.round + +ds.d, 1, 9999); render(); },
  joinN(ds) { G.n = clamp(G.n + +ds.d, G.game === "spy" ? 4 : 3, 10); if (G.seat > G.n) G.seat = 0; render(); },
  seat(ds) {
    G.seat = +ds.s;
    const nm = roomNames()?.[G.seat];
    if (nm && !G.name) G.name = nm;
    render();
  },
  enter: () => enterRoom(),
  next: () => nextRound(),
  async editRound() {
    const v = await promptBox("改轮数", { type: "number", value: String(G.round), hint: "和大家对齐;同一轮数大家看到的词才一样", max: 4 });
    if (v && /^\d+$/.test(v) && +v >= 1) setRound(+v);
  },
  settle: () => openSettle(),
  // 我是谁
  async wrong() { setSt(G.seat, { wrong: Math.min(9, (st(G.seat).wrong || 0) + 1) }); sfx.bad(); buzz(60); toast("记下了:猜错 +1 口,结算时一起喝"); },
  async gotIt() {
    if (!(await confirmBox("确定猜对了?", "会揭晓你的词,并退出本轮。", "揭晓 🎉", "mint"))) return;
    setSt(G.seat, { out: true }); sfx.ok(); buzz([40, 60, 40]);
  },
  soloWrong(ds) { setSt(+ds.s, { wrong: Math.min(9, (st(+ds.s).wrong || 0) + 1) }); sfx.bad(); },
  async soloGot(ds) {
    if (!(await confirmBox(`${seatLabel(+ds.s)} 猜对了?`, "会在屏幕上揭晓他的词。", "揭晓", "mint"))) return;
    setSt(+ds.s, { out: true }); sfx.ok();
  },
  // 禁忌
  async caught() {
    if (!(await confirmBox("确定中招了?", "会揭晓你的禁忌,喝 1 口并出局。", "我认栽 😵", "red"))) return;
    setSt(G.seat, { out: true }); sfx.bad(); buzz([80, 60, 80]);
  },
  async soloCaught(ds) {
    if (!(await confirmBox(`${seatLabel(+ds.s)} 中招了?`, "会揭晓他的禁忌。", "中招", "red"))) return;
    setSt(+ds.s, { out: true }); sfx.bad();
  },
  async tStart() {
    const dur = S.tabooMin * 60;
    sfx.go();
    if (synced()) await op({ op: "timer", dur });
    else { G.local.timer = { end: Date.now() + dur * 1000, dur }; render(); }
  },
  async tReset() {
    if (!(await confirmBox("重置倒计时?", "所有手机的倒计时都会停下。", "重置", "red"))) return;
    if (synced()) await op({ op: "timer", dur: 0 });
    else { G.local.timer = null; render(); }
  },
  // 房主
  async hostMenu() {
    if (!synced()) return toast("连不上同步服务,房主功能暂时用不了");
    const h = G.srv.host;
    if (!h) {
      const ok = await confirmBox("认领房主?", "房主可以:<br>· 用自己手机上的词库(📝 词库 里编辑),同步给全房间<br>· 给某个人换词、直接改词<br>谁先认领谁就是,其他人看得到房主是几号。", "我来当房主", "pink");
      if (!ok) return;
      let tok = token();
      if (!tok) { tok = crypto.randomUUID().replace(/-/g, ""); store.set("tok." + G.room, tok); }
      if (await op({ op: "claim", seat: G.seat })) {
        store.set("host." + G.room, true);
        store.set("lastRoom", G.room);
        const custom = ["who", "taboo", "spy"].some((k) => localBank[k] != null);
        if (custom) { await pushBank(G.room); toast("你是房主了,已同步你的自定义词库"); }
        else toast("你是房主了 👑");
      }
      return;
    }
    if (!h.mine) return toast(`房主是 ${h.seat ? seatLabel(h.seat, roomNames()) : "别人"}`);
    sheet(`<h3>👑 房主</h3><p class="dim small">词库:${G.roomBank ? "房主自定义" : "内置"}</p>
      <div class="stack"><button class="btn amber" data-m="words">📝 编辑词库(同步给全房间)</button>
      ${G.roomBank ? `<button class="btn sm" data-m="builtin">改回内置词库</button>` : ""}
      <button class="btn ghost sm" data-m="unhost">让出房主</button></div>`, async (m) => {
      if (m === "_close") return;
      closeSheet();
      if (m === "words") { const t = { who: "who", taboo: "taboo", spy: "spy" }[G.game]; wordsTab = t; go("words"); }
      if (m === "builtin") { await op({ op: "bank", bank: null }); toast("房间改回内置词库"); }
      if (m === "unhost") { if (await op({ op: "unhost" })) { store.del("host." + G.room); toast("已让出房主"); } }
    });
  },
  async reroll(ds) {
    const s = +ds.s;
    const me = s === G.seat;
    if (!(await confirmBox(me ? "换掉你自己的词?" : `给 ${seatLabel(s, roomNames())} 换一个?`, "从词库里随机换一个,所有手机同步。", "换"))) return;
    await op({ op: "fix", seat: s });
  },
  async setWord(ds) {
    const s = +ds.s;
    const v = await promptBox(`给 ${seatLabel(s, roomNames())} 指定${G.game === "who" ? "词" : "禁忌"}`, { placeholder: "输入新的词", hint: "所有手机同步;只有 TA 自己看不到。" });
    if (v) await op({ op: "fix", seat: s, word: v });
  },
  // 卧底
  async voteOut(ds) {
    const s = +ds.s;
    const d = curDeal();
    if (st(s).out) return;
    if (!(await confirmBox(`投出 ${seatLabel(s, roomNames())}?`, "得票最多的人出局。", "投出", "red"))) return;
    setSt(s, { out: true });
    const x = d.seats[s - 1];
    const outs = Object.entries(rd().st).filter(([, v]) => v.out).map(([k]) => +k);
    const res = spyResult(d, outs);
    if (res) { sfx.end(); buzz([200, 100, 400]); }
    else { x.spy ? sfx.ok() : sfx.bad(); toast(`${s} 号出局 —— ${x.spy ? "🕵️ 是卧底!" : "是平民,游戏继续"}`, 3500); }
  },
  async spyUndo() {
    const outs = Object.entries(rd().st || {}).filter(([, v]) => v.out).map(([k]) => +k);
    const last = outs[outs.length - 1];
    if (!last) return;
    if (!(await confirmBox(`撤销 ${last} 号的出局?`))) return;
    setSt(last, { out: false });
  },
  async spyReroll() {
    if (!(await confirmBox("换一组词?", "所有人的词和卧底人选都会重新分配,让大家重新按住看词。", "换"))) return;
    await op({ op: "fix", seat: 0 });
  },
  async spySet() {
    const v = await promptBox("指定本轮词语", { placeholder: "平民词 / 卧底词", hint: "格式:牛奶 / 豆浆。你会知道答案,建议你这轮当法官不参与。", max: 61 });
    if (!v) return;
    const p = v.split(/\s*[\/|｜,，]\s*/).filter(Boolean);
    if (p.length < 2 || p[0] === p[1]) return toast("要两个不一样的词,用 / 隔开");
    await op({ op: "fix", seat: 0, word: p[0] + "|" + p[1] });
  },
  // 单机传看
  passShow() { G.pass.show = true; buzz(20); render(); },
  passNext() {
    if (G.pass.i >= G.n) { G.view = "play"; render(); window.scrollTo(0, 0); return; }
    G.pass = { i: G.pass.i + 1, show: false };
    render();
  },
  passSkip() { G.view = "play"; render(); },
  repass() { G.view = "pass"; G.pass = { i: 1, show: false }; render(); },
  // 你比我猜
  chDiff(ds) { CH.diff = ds.k; S.chDiff = ds.k; saveS(); render(); },
  chPerf(ds) { CH.performer = +ds.s; store.set("chPerformer", CH.performer); render(); },
  chReady() {
    if (!chPool(CH.diff).length) return toast("这一档没有词,去词库里加点");
    chStartCount();
  },
  chOk: () => chMark(true),
  chSkip: () => chMark(false),
  async chStop() { if (await confirmBox("提前结束本轮?", "", "结束", "red")) chFinish(); },
  chNextPerf() { CH.performer = (CH.performer % S.n) + 1; store.set("chPerformer", CH.performer); chStartCount(); },
  chSetup() { clearInterval(CH.iv); CH.view = "setup"; keepAwake(false); render(); },
};

async function pushBank(room) {
  const tok = store.get("tok." + room, null);
  if (!tok) return false;
  const bank = {};
  for (const k of ["who", "taboo", "spy"]) if (localBank[k] != null) bank[k] = localBank[k];
  const res = await api.op(room, { op: "bank", bank: Object.keys(bank).length ? bank : null }, tok);
  return !!res.data;
}

onRoute();
