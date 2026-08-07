// UnoRoom:「余一」房间 Durable Object,持有权威牌局状态
// 牌编码:颜色 r/y/g/b + 面值 0-9|s(禁)|r(转)|d(+2);万能牌 "w"(换色) / "W"(+4换色)
// 规则对齐 UNO 官方基础版:108 张、首翻牌处理、摸牌可打、2人反转=跳过、
// 余一漏喊罚 2、+4 仅限无同色时打出、质疑成功对方自摸 4/失败摸 6、计分 500 制

const COLORS = ["r", "y", "g", "b"];
export const COLOR_INFO = {
  r: { name: "赤" }, y: { name: "金" }, g: { name: "翠" }, b: { name: "黛" },
};
const VALUES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "s", "r", "d"];
const PLAYER_COLORS = ["#d94a4a", "#3d7edb", "#e8912d", "#8e63c9", "#3aa88a", "#c9b23f"];
const BOT_NICKS = ["牌手·甲", "牌手·乙", "牌手·丙", "牌手·丁", "牌手·戊"];
const IDLE_WIPE_MS = 24 * 60 * 60 * 1000;
const MAX_SEATS = 6;

export const isWild = (c) => c === "w" || c === "W";
export const colorOf = (c) => (isWild(c) ? null : c[0]);
export const valOf = (c) => (isWild(c) ? c : c.slice(1));

export function cardPoints(c) {
  if (isWild(c)) return 50;
  const v = valOf(c);
  return "srd".includes(v) ? 20 : Number(v);
}

// 顶牌是万能牌时只看当前颜色;否则颜色或面值任一匹配
export function playable(card, top, color) {
  if (isWild(card)) return true;
  if (colorOf(card) === color) return true;
  return !isWild(top) && valOf(card) === valOf(top);
}

function buildDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push(c + "0");
    for (const v of VALUES) d.push(c + v, c + v);
  }
  for (let i = 0; i < 4; i++) d.push("w", "W");
  return d;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class UnoRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("game")) ?? null;
      this.scheduleBot();
    });
  }

  async commit() {
    this.g.v = (this.g.v ?? 0) + 1;
    await this.ctx.storage.put("game", this.g);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
  }

  async alarm() {
    this.g = null;
    await this.ctx.storage.deleteAll();
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "room expired");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/claim") {
      if (this.g && this.g.phase !== "ended") return new Response("room exists", { status: 409 });
      const { hostToken } = JSON.parse(await request.text());
      this.g = {
        v: 0,
        code: url.searchParams.get("code"),
        phase: "lobby",
        hostToken,
        target: 500,
        seats: [],
        deck: [], pile: [], color: null, dir: 1,
        turn: null, pending: null, vulnerable: null,
        round: 0, startSeat: 0,
        log: [], winner: null, result: null,
      };
      await this.commit();
      return new Response("ok");
    }
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  // ---------- 连接与基础 ----------

  seatOf(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.token || !this.g) return -1;
    return this.g.seats.findIndex((s) => s.token === att.token);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    try {
      await this.handle(ws, msg);
    } catch (e) {
      this.send(ws, { t: "err", msg: e?.expected ? e.message : "服务器开小差了:" + (e?.message ?? e) });
      if (!e?.expected) console.error(e);
    }
  }

  async webSocketClose(ws) {
    const i = this.seatOf(ws);
    if (i >= 0) {
      this.g.seats[i].connected = this.ctx.getWebSockets()
        .some((w) => w !== ws && w.deserializeAttachment()?.token === this.g.seats[i].token);
      await this.commit();
      this.broadcast();
    }
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  fail(msg) {
    const e = new Error(msg);
    e.expected = true;
    throw e;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  log(text) {
    this.g.log.push(text);
    if (this.g.log.length > 80) this.g.log.splice(0, this.g.log.length - 80);
  }

  nick(i) { return this.g.seats[i].nick; }

  // ---------- 消息分发 ----------

  async handle(ws, msg) {
    const g = this.g;
    if (!g) this.fail("房间不存在或已过期");
    if (msg.t === "join") return this.onJoin(ws, msg);
    const seat = this.seatOf(ws);
    if (seat < 0) this.fail("请先加入房间");

    if (msg.t === "chat") {
      const text = String(msg.text ?? "").slice(0, 120).trim();
      if (text) { this.log(`💬 ${this.nick(seat)}:${text}`); await this.commit(); this.broadcast(); }
      return;
    }

    if (g.phase === "lobby") {
      if (msg.t === "start") return this.onStart(seat, msg);
      if (msg.t === "add_bot") return this.onAddBot(seat);
      if (msg.t === "remove_bot") return this.onRemoveBot(seat, msg);
      this.fail("游戏尚未开始");
    }
    if (g.phase === "ended") this.fail("对局已结束");

    // 抓「没喊余一」和补喊,任何时刻都可以
    if (msg.t === "catch") return this.onCatch(seat);
    if (msg.t === "uno_late") return this.onUnoLate(seat);

    const p = g.pending;
    if (p?.t === "drawn") {
      if (msg.t !== "play_drawn" || seat !== p.seat) this.fail("等待摸牌玩家决定");
      return this.onPlayDrawn(seat, msg);
    }
    if (p?.t === "challenge") {
      if (msg.t !== "challenge" || seat !== p.victim) this.fail("等待被 +4 的玩家决定是否质疑");
      return this.onChallenge(seat, msg);
    }
    if (p?.t === "firstcolor") {
      if (msg.t !== "color" || seat !== p.seat) this.fail("等待首位玩家选择颜色");
      return this.onFirstColor(seat, msg);
    }
    if (p?.t === "round") {
      if (msg.t !== "next_round") this.fail("等待房主开始下一局");
      if (g.seats[seat].token !== g.hostToken) this.fail("只有房主能开始下一局");
      return this.onNextRound();
    }

    if (seat !== g.turn.seat) this.fail("还没轮到你");
    if (msg.t === "play") return this.onPlay(seat, msg);
    if (msg.t === "draw") return this.onDraw(seat);
    this.fail("未知操作");
  }

  // ---------- 大厅 ----------

  async onJoin(ws, msg) {
    const g = this.g;
    const token = String(msg.token ?? "");
    const nick = String(msg.nick ?? "").trim().slice(0, 12) || "无名氏";
    if (!token) this.fail("缺少身份令牌");
    let i = g.seats.findIndex((s) => s.token === token);
    if (i < 0 && g.phase !== "lobby") {
      i = g.seats.findIndex((s) => !s.isBot && !s.connected && s.nick === nick);
      if (i >= 0) g.seats[i].token = token;
    }
    if (i < 0) {
      if (g.phase !== "lobby") this.fail("对局已开始,无法中途加入");
      if (g.seats.length >= MAX_SEATS) this.fail(`房间已满(最多 ${MAX_SEATS} 人)`);
      if (g.seats.some((s) => s.nick === nick)) this.fail("昵称和房内玩家重复,换一个吧");
      i = g.seats.length;
      g.seats.push({
        token, nick, isBot: false, connected: true,
        color: PLAYER_COLORS[i],
        hand: [], score: 0,
      });
      this.log(`${nick} 加入了房间`);
    }
    g.seats[i].connected = true;
    ws.serializeAttachment({ token });
    this.send(ws, { t: "joined", seat: i, code: g.code });
    await this.commit();
    this.broadcast();
  }

  async onAddBot(seat) {
    const g = this.g;
    if (g.seats[seat].token !== g.hostToken) this.fail("只有房主能添加机器人");
    if (g.seats.length >= MAX_SEATS) this.fail("房间已满");
    const nick = BOT_NICKS.find((n) => !g.seats.some((s) => s.nick === n));
    g.seats.push({
      token: "bot:" + crypto.randomUUID(), nick, isBot: true, connected: true,
      color: PLAYER_COLORS[g.seats.length],
      hand: [], score: 0,
    });
    this.log(`🤖 ${nick} 加入了房间`);
    await this.commit();
    this.broadcast();
  }

  async onRemoveBot(seat, msg) {
    const g = this.g;
    if (g.seats[seat].token !== g.hostToken) this.fail("只有房主能移除机器人");
    if (!g.seats[msg.seat]?.isBot) this.fail("只能移除机器人");
    this.log(`🤖 ${g.seats[msg.seat].nick} 离开了房间`);
    g.seats.splice(msg.seat, 1);
    g.seats.forEach((s, j) => { s.color = PLAYER_COLORS[j]; });
    await this.commit();
    this.broadcast();
  }

  async onStart(seat, msg) {
    const g = this.g;
    if (g.seats[seat].token !== g.hostToken) this.fail("只有房主能开始游戏");
    if (g.seats.length < 2) this.fail("至少需要 2 名玩家");
    g.target = [0, 200, 500].includes(msg.target) ? msg.target : 500;
    g.seats = shuffle(g.seats);
    g.seats.forEach((s, j) => { s.color = PLAYER_COLORS[j]; });
    g.phase = "play";
    g.round = 1;
    g.startSeat = 0;
    this.log(`对局开始!${g.target === 0 ? "单局定胜负" : `先攒到 ${g.target} 分获胜`},顺序:${g.seats.map((s) => s.nick).join(" → ")}`);
    this.startRound();
    await this.commit();
    this.broadcast();
  }

  // ---------- 发牌与回合 ----------

  startRound() {
    const g = this.g;
    g.deck = shuffle(buildDeck());
    g.pile = [];
    g.dir = 1;
    g.vulnerable = null;
    g.pending = null;
    for (const s of g.seats) s.hand = [];
    for (let i = 0; i < 7; i++) for (const s of g.seats) s.hand.push(g.deck.pop());

    // 翻首牌:+4 塞回去重翻;功能牌效果作用于首位玩家
    let first;
    while (true) {
      first = g.deck.pop();
      if (first !== "W") break;
      g.deck.splice(Math.floor(Math.random() * g.deck.length), 0, first);
    }
    g.pile.push(first);
    g.color = colorOf(first);
    const s0 = g.startSeat;
    g.turn = { seat: s0, n: (g.turn?.n ?? 0) + 1 };
    this.log(`—— 第 ${g.round} 局开始,翻出 ${this.cardName(first)} ——`);
    const v = valOf(first);
    if (first === "w") {
      g.pending = { t: "firstcolor", seat: s0 };
      this.log(`${this.nick(s0)} 请选择起始颜色`);
    } else if (v === "s") {
      this.log(`${this.nick(s0)} 开局即被跳过`);
      g.turn.seat = this.nextActive(s0, 1);
    } else if (v === "r") {
      g.dir = -1;
      this.log("方向反转!");
    } else if (v === "d") {
      this.drawCards(s0, 2);
      this.log(`${this.nick(s0)} 开局摸 2 张并被跳过`);
      g.turn.seat = this.nextActive(s0, 1);
    }
  }

  nextActive(from, steps) {
    const n = this.g.seats.length;
    let idx = from;
    for (let i = 0; i < steps; i++) idx = (idx + this.g.dir + n) % n;
    return idx;
  }

  drawCards(seat, count) {
    const g = this.g;
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (g.deck.length === 0) {
        // 弃牌堆只留顶牌,其余洗回摸牌堆
        const top = g.pile.pop();
        g.deck = shuffle(g.pile);
        g.pile = [top];
      }
      if (g.deck.length === 0) break; // 牌全在手里的极端情况
      g.seats[seat].hand.push(g.deck.pop());
      n++;
    }
    return n;
  }

  cardName(card) {
    if (card === "w") return "「换色」";
    if (card === "W") return "「+4换色」";
    const cn = COLOR_INFO[colorOf(card)].name;
    const v = valOf(card);
    return `${cn}${v === "s" ? "禁" : v === "r" ? "转" : v === "d" ? "+2" : v}`;
  }

  clearVulnerable() {
    this.g.vulnerable = null;
  }

  // ---------- 出牌 ----------

  async onPlay(seat, msg) {
    this.clearVulnerable(); // 下家已行动,抓人窗口关闭
    const g = this.g;
    const s = g.seats[seat];
    const card = msg.card;
    const idx = s.hand.indexOf(card);
    if (idx < 0) this.fail("你没有这张牌");
    if (!playable(card, g.pile.at(-1), g.color)) this.fail("这张牌现在不能出(要对上颜色或数字/符号)");
    s.hand.splice(idx, 1);
    await this.resolvePlay(seat, card, msg);
  }

  async onPlayDrawn(seat, msg) {
    const g = this.g;
    const p = g.pending;
    g.pending = null;
    if (!msg.play) {
      g.turn.seat = this.nextActive(seat, 1);
      g.turn.n++;
      this.log(`${this.nick(seat)} 留下了摸到的牌`);
      await this.commit();
      this.broadcast();
      return;
    }
    const s = g.seats[seat];
    const idx = s.hand.indexOf(p.card);
    if (idx < 0) this.fail("摸到的牌不见了"); // 不应发生
    s.hand.splice(idx, 1);
    await this.resolvePlay(seat, p.card, msg);
  }

  // 出牌统一结算(msg 携带 color/uno)
  async resolvePlay(seat, card, msg) {
    const g = this.g;
    const s = g.seats[seat];
    const prevColor = g.color; // +4 合法性按打出前的颜色判定
    g.pile.push(card);
    this.log(`${this.nick(seat)} 打出 ${this.cardName(card)}`);

    if (isWild(card)) {
      if (!COLORS.includes(msg.color)) { // 不合法就顶回去
        g.pile.pop(); s.hand.push(card);
        this.fail("万能牌需要指定颜色");
      }
      g.color = msg.color;
      this.log(`指定颜色:${COLOR_INFO[msg.color].name}`);
    } else {
      g.color = colorOf(card);
    }

    // 喊「余一」
    if (s.hand.length === 1) {
      if (msg.uno) this.log(`❗ ${s.nick} 喊出「余一」!`);
      else g.vulnerable = { seat, botTried: false };
    }

    if (card === "W") {
      // +4:仅当手里没有打出前颜色的牌才算合法打出
      const legal = !s.hand.some((c) => colorOf(c) === prevColor);
      g.pending = { t: "challenge", victim: this.nextActive(seat, 1), by: seat, legal };
      this.log(`${this.nick(g.pending.victim)} 可以选择质疑或认摸 4 张`);
      await this.commit();
      this.broadcast();
      return;
    }

    if (s.hand.length === 0) return this.endRound(seat);

    const v = valOf(card);
    let steps = 1;
    if (v === "s") {
      steps = 2;
      this.log(`${this.nick(this.nextActive(seat, 1))} 被跳过`);
    } else if (v === "r") {
      g.dir = -g.dir;
      steps = g.seats.length === 2 ? 2 : 1;
      this.log(g.seats.length === 2 ? "反转 = 再来一回合!" : "方向反转!");
    } else if (v === "d") {
      const victim = this.nextActive(seat, 1);
      this.drawCards(victim, 2);
      this.log(`${this.nick(victim)} 摸 2 张并被跳过`);
      steps = 2;
    }
    g.turn.seat = this.nextActive(seat, steps);
    g.turn.n++;
    await this.commit();
    this.broadcast();
  }

  async onChallenge(victim, msg) {
    const g = this.g;
    const p = g.pending;
    g.pending = null;
    const offender = p.by;
    if (msg.accept) {
      this.drawCards(victim, 4);
      this.log(`${this.nick(victim)} 认了,摸 4 张并被跳过`);
      g.turn.seat = this.nextActive(victim, 1);
    } else if (p.legal) {
      this.drawCards(victim, 6);
      this.log(`🔍 质疑失败!${this.nick(offender)} 确实没有同色牌,${this.nick(victim)} 摸 6 张并被跳过`);
      g.turn.seat = this.nextActive(victim, 1);
    } else {
      this.drawCards(offender, 4);
      this.log(`🔍 质疑成功!${this.nick(offender)} 藏着同色牌,自摸 4 张,${this.nick(victim)} 正常出牌`);
      g.turn.seat = victim;
    }
    g.turn.n++;
    if (g.seats[offender].hand.length === 0) return this.endRound(offender);
    await this.commit();
    this.broadcast();
  }

  async onFirstColor(seat, msg) {
    const g = this.g;
    if (!COLORS.includes(msg.c)) this.fail("请选择颜色");
    g.color = msg.c;
    g.pending = null;
    this.log(`${this.nick(seat)} 指定起始颜色:${COLOR_INFO[msg.c].name}`);
    await this.commit();
    this.broadcast();
  }

  async onDraw(seat) {
    this.clearVulnerable();
    const g = this.g;
    const n = this.drawCards(seat, 1);
    if (n === 0) { // 摸不到牌,只能过
      g.turn.seat = this.nextActive(seat, 1);
      g.turn.n++;
      this.log(`${this.nick(seat)} 无牌可摸,跳过`);
    } else {
      const card = g.seats[seat].hand.at(-1);
      if (playable(card, g.pile.at(-1), g.color)) {
        g.pending = { t: "drawn", seat, card };
        this.log(`${this.nick(seat)} 摸了 1 张,考虑要不要打出…`);
      } else {
        g.turn.seat = this.nextActive(seat, 1);
        g.turn.n++;
        this.log(`${this.nick(seat)} 摸了 1 张,过`);
      }
    }
    await this.commit();
    this.broadcast();
  }

  async onCatch(seat) {
    const g = this.g;
    const vul = g.vulnerable;
    if (!vul || vul.seat === seat) this.fail("现在没有可以抓的人");
    this.drawCards(vul.seat, 2);
    this.log(`🫵 ${this.nick(seat)} 抓住 ${this.nick(vul.seat)} 没喊「余一」,罚摸 2 张!`);
    g.vulnerable = null;
    await this.commit();
    this.broadcast();
  }

  async onUnoLate(seat) {
    const g = this.g;
    if (g.vulnerable?.seat !== seat) this.fail("不需要补喊");
    g.vulnerable = null;
    this.log(`❗ ${this.nick(seat)} 补喊「余一」!`);
    await this.commit();
    this.broadcast();
  }

  // ---------- 计分与局间 ----------

  async endRound(winnerSeat) {
    const g = this.g;
    g.vulnerable = null;
    let points = 0;
    for (const [i, s] of g.seats.entries()) {
      if (i === winnerSeat) continue;
      points += s.hand.reduce((a, c) => a + cardPoints(c), 0);
    }
    g.seats[winnerSeat].score += points;
    this.log(`🏁 第 ${g.round} 局结束:${this.nick(winnerSeat)} 清空手牌,+${points} 分(累计 ${g.seats[winnerSeat].score})`);

    if (g.target === 0 || g.seats[winnerSeat].score >= g.target) {
      g.phase = "ended";
      g.winner = winnerSeat;
      g.result = g.seats.map((s) => ({ nick: s.nick, color: s.color, score: s.score, isBot: s.isBot }));
      this.log(`🏆 ${this.nick(winnerSeat)} 获得最终胜利!`);
    } else {
      g.pending = { t: "round", winner: winnerSeat, points };
    }
    await this.commit();
    this.broadcast();
  }

  async onNextRound() {
    const g = this.g;
    g.pending = null;
    g.round++;
    g.startSeat = (g.startSeat + 1) % g.seats.length;
    this.startRound();
    await this.commit();
    this.broadcast();
  }

  // ---------- 机器人 ----------

  botNeeded() {
    const g = this.g;
    if (!g || g.phase !== "play") return false;
    const p = g.pending;
    if (p?.t === "drawn") return g.seats[p.seat]?.isBot;
    if (p?.t === "challenge") return g.seats[p.victim]?.isBot;
    if (p?.t === "firstcolor") return g.seats[p.seat]?.isBot;
    if (p?.t === "round") return false; // 下一局由房主(人类)点
    if (g.vulnerable && !g.vulnerable.botTried &&
        !g.seats[g.vulnerable.seat]?.isBot && g.seats.some((s) => s.isBot)) return true;
    return !p && g.seats[g.turn.seat]?.isBot;
  }

  scheduleBot() {
    if (this.botTimer || !this.botNeeded()) return;
    this.botTimer = setTimeout(async () => {
      this.botTimer = null;
      try {
        await this.botStep();
      } catch (e) {
        console.error("bot step failed:", e?.message);
        try {
          const g = this.g;
          if (g?.phase === "play" && !g.pending && g.seats[g.turn.seat]?.isBot) {
            await this.onDraw(g.turn.seat);
          }
        } catch {}
      }
    }, 600 + Math.random() * 500);
  }

  mostColor(hand) {
    const count = { r: 0, y: 0, g: 0, b: 0 };
    for (const c of hand) if (colorOf(c)) count[colorOf(c)]++;
    return COLORS.sort((a, b) => count[b] - count[a])[0] ?? "r";
  }

  async botStep() {
    const g = this.g;
    if (!this.botNeeded()) return;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const p = g.pending;

    // 抓没喊余一的人类(五五开,像个偶尔走神的真人)
    if (g.vulnerable && !g.vulnerable.botTried && !g.seats[g.vulnerable.seat].isBot) {
      g.vulnerable.botTried = true;
      const bot = g.seats.findIndex((s, i) => s.isBot && i !== g.vulnerable.seat);
      if (bot >= 0 && Math.random() < 0.5) return this.onCatch(bot);
      await this.commit();
      this.broadcast();
      return;
    }

    if (p?.t === "firstcolor") {
      return this.onFirstColor(p.seat, { c: this.mostColor(g.seats[p.seat].hand) });
    }
    if (p?.t === "challenge") {
      return this.onChallenge(p.victim, { accept: Math.random() > 0.3 });
    }
    if (p?.t === "drawn") {
      const s = g.seats[p.seat];
      return this.onPlayDrawn(p.seat, {
        play: true,
        color: isWild(p.card) ? this.mostColor(s.hand.filter((c) => c !== p.card)) : undefined,
        uno: s.hand.length === 2 && Math.random() < 0.85,
      });
    }

    const seat = g.turn.seat;
    const s = g.seats[seat];
    const top = g.pile.at(-1);
    let cands = s.hand.filter((c) => playable(c, top, g.color));
    // 官方规则:手里还有当前颜色时不打 +4
    if (s.hand.some((c) => colorOf(c) === g.color)) cands = cands.filter((c) => c !== "W");
    if (cands.length === 0) return this.onDraw(seat);

    const nextS = g.seats[this.nextActive(seat, 1)];
    let card;
    if (nextS.hand.length <= 2) {
      // 下家快赢了,优先招呼功能牌
      card = cands.find((c) => valOf(c) === "d") ?? cands.find((c) => c === "W") ??
             cands.find((c) => valOf(c) === "s") ?? pick(cands);
    } else {
      const nonWild = cands.filter((c) => !isWild(c));
      card = nonWild.length ? pick(nonWild) : pick(cands); // 万能牌留后手
    }
    return this.onPlay(seat, {
      card,
      color: isWild(card) ? this.mostColor(s.hand.filter((c) => c !== card)) : undefined,
      uno: s.hand.length === 2 && Math.random() < 0.85,
    });
  }

  // ---------- 广播(按人裁剪) ----------

  personalize(viewer) {
    const g = this.g;
    let pending = g.pending;
    if (pending?.t === "challenge") {
      pending = { t: "challenge", victim: pending.victim, by: pending.by }; // 不泄露合法性
    } else if (pending?.t === "drawn" && pending.seat !== viewer) {
      pending = { t: "drawn", seat: pending.seat }; // 不泄露摸到的牌
    }
    return {
      v: g.v,
      code: g.code,
      phase: g.phase,
      target: g.target,
      you: viewer,
      hostSeat: g.seats.findIndex((s) => s.token === g.hostToken),
      round: g.round,
      dir: g.dir,
      color: g.color,
      pileTop: g.pile.at(-1) ?? null,
      deckCount: g.deck.length,
      turn: g.turn,
      pending,
      vulnerable: g.vulnerable ? { seat: g.vulnerable.seat } : null,
      seats: g.seats.map((s, i) => {
        const base = {
          nick: s.nick, color: s.color, isBot: s.isBot, connected: s.connected,
          score: s.score, handCount: s.hand.length,
        };
        if (i === viewer || g.phase === "ended") base.hand = s.hand;
        return base;
      }),
      log: g.log,
      winner: g.winner,
      result: g.result,
    };
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: "state", g: this.personalize(this.seatOf(ws)) });
    }
    this.scheduleBot();
  }
}
