// FangshiRoom:一房一实例的 Durable Object,持有权威游戏状态。
// 客户端只发动作,规则校验与状态演进全在这里;每次变更落 storage,实例被回收也不丢局。
// 大富翁类玩法信息基本全公开(地契、现金、建筑都摆在明面上),所以广播不做按人裁剪。
import {
  BOARD, GROUPS, GO, JAIL, TO_GO, START_CASH, PASS_GO, BAIL, MAX_JAIL_TURNS,
  HOUSE_STOCK, HOTEL_STOCK, PLAYER_COLORS, PLAYER_TOKENS,
  EDICTS, RUMORS, shuffle, groupTiles, hasMonopoly, rentOf,
  mortgageValue, redeemCost, netWorth, maxRaisable,
} from "../public/js/shared/board.js";

const IDLE_WIPE_MS = 24 * 60 * 60 * 1000; // 闲置一天后清房
const BOT_NICKS = ["坊客·甲", "坊客·乙", "坊客·丙", "坊客·丁", "坊客·戊"];
const MAX_SEATS = 6;

export class FangshiRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.botTimer = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("game")) ?? null;
      this.scheduleBot(); // 实例休眠后被唤醒时,若正轮到机器人,续上它的回合
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
        code: url.searchParams.get("code"),
        phase: "lobby",
        hostToken,
        seats: [],
        tiles: null,
        turn: null,
        pending: null,
        edicts: [], edictAt: 0,
        rumors: [], rumorAt: 0,
        houses: HOUSE_STOCK,
        hotels: HOTEL_STOCK,
        log: [],
        winner: null,
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

  // ---------- 连接管理 ----------

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
    e.expected = true; // 预期内的规则拒绝,不打错误日志
    throw e;
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* 连接已断 */ } }

  broadcast() {
    const payload = JSON.stringify({ t: "state", g: this.g });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* 连接已断 */ }
    }
  }

  note(text) {
    this.g.log.push(text);
    if (this.g.log.length > 200) this.g.log.splice(0, this.g.log.length - 200);
  }

  // ---------- 动作分发 ----------

  async handle(ws, m) {
    if (!this.g) this.fail("房间不存在或已过期");

    if (m.t === "join") return this.join(ws, m);

    const seat = this.seatOf(ws);
    if (seat < 0) this.fail("你还没入座");

    const H = {
      chat: () => this.chat(seat, m),
      add_bot: () => this.addBot(seat),
      remove_bot: () => this.removeBot(seat, m.seat),
      start: () => this.start(seat),
      roll: () => this.roll(seat),
      buy: () => this.buy(seat),
      decline: () => this.decline(seat),
      bid: () => this.bid(seat, m.amount),
      bid_pass: () => this.bidPass(seat),
      build: () => this.build(seat, m.tile),
      sell_build: () => this.sellBuild(seat, m.tile),
      mortgage: () => this.mortgage(seat, m.tile),
      redeem: () => this.redeem(seat, m.tile),
      jail_pay: () => this.jailPay(seat),
      jail_card: () => this.jailCard(seat),
      trade_offer: () => this.tradeOffer(seat, m),
      trade_accept: () => this.tradeAccept(seat),
      trade_reject: () => this.tradeReject(seat),
      end_turn: () => this.endTurn(seat),
      give_up: () => this.giveUp(seat),
    };
    const fn = H[m.t];
    if (!fn) this.fail("不认识的动作");
    await fn();
  }

  // ---------- 大厅 ----------

  async join(ws, m) {
    const { token, nick } = m;
    if (!token) this.fail("缺少身份令牌");
    let i = this.g.seats.findIndex((s) => s.token === token);

    if (i < 0) {
      if (this.g.phase !== "lobby") this.fail("这局已经开始了,等下一局吧");
      if (this.g.seats.length >= MAX_SEATS) this.fail("房间满了(最多 6 人)");
      i = this.g.seats.length;
      this.g.seats.push(this.newSeat(token, (nick || "").trim().slice(0, 12) || `坊客${i + 1}`, false, i));
      this.note(`${this.g.seats[i].nick} 入了坊`);
    }
    ws.serializeAttachment({ token });
    this.g.seats[i].connected = true;
    await this.commit();
    this.send(ws, { t: "joined", code: this.g.code, seat: i });
    this.broadcast();
  }

  newSeat(token, nick, isBot, i) {
    return {
      token, nick, isBot, connected: !isBot,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      piece: PLAYER_TOKENS[i % PLAYER_TOKENS.length],
      cash: START_CASH,
      pos: 0,
      jailed: false,
      jailTurns: 0,
      pardons: 0,
      bankrupt: false,
    };
  }

  isHost(seat) { return this.g.seats[seat]?.token === this.g.hostToken; }

  async chat(seat, m) {
    const text = String(m.text ?? "").trim().slice(0, 120);
    if (!text) return;
    this.note(`${this.g.seats[seat].nick}:${text}`);
    await this.commit();
    this.broadcast();
  }

  async addBot(seat) {
    if (this.g.phase !== "lobby") this.fail("开局后不能加人");
    if (!this.isHost(seat)) this.fail("只有房主能加机器人");
    if (this.g.seats.length >= MAX_SEATS) this.fail("房间满了");
    const used = new Set(this.g.seats.map((s) => s.nick));
    const nick = BOT_NICKS.find((n) => !used.has(n)) ?? `坊客·${this.g.seats.length + 1}`;
    const i = this.g.seats.length;
    this.g.seats.push(this.newSeat(`bot:${crypto.randomUUID()}`, nick, true, i));
    this.note(`${nick} 入了坊`);
    await this.commit();
    this.broadcast();
  }

  async removeBot(seat, target) {
    if (this.g.phase !== "lobby") this.fail("开局后不能移除");
    if (!this.isHost(seat)) this.fail("只有房主能移除机器人");
    const s = this.g.seats[target];
    if (!s?.isBot) this.fail("只能移除机器人");
    this.g.seats.splice(target, 1);
    this.g.seats.forEach((x, i) => {
      x.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      x.piece = PLAYER_TOKENS[i % PLAYER_TOKENS.length];
    });
    this.note(`${s.nick} 离开了`);
    await this.commit();
    this.broadcast();
  }

  async start(seat) {
    if (this.g.phase !== "lobby") this.fail("已经开局了");
    if (!this.isHost(seat)) this.fail("只有房主能开局");
    if (this.g.seats.length < 2) this.fail("至少 2 人才能开局");

    this.g.phase = "play";
    this.g.tiles = BOARD.map(() => ({ owner: -1, level: 0, mortgaged: false }));
    this.g.edicts = shuffle(EDICTS.map((_, i) => i));
    this.g.rumors = shuffle(RUMORS.map((_, i) => i));
    this.g.edictAt = 0;
    this.g.rumorAt = 0;
    this.g.houses = HOUSE_STOCK;
    this.g.hotels = HOTEL_STOCK;
    this.g.turn = { seat: 0, doubles: 0, rolled: false, dice: null };
    this.note(`—— 开市!顺序:${this.g.seats.map((s) => s.nick).join(" → ")} ——`);
    this.note(`${this.g.seats[0].nick} 先行`);
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  // ---------- 回合 ----------

  cur() { return this.g.turn?.seat ?? -1; }

  mustBeTurn(seat) {
    if (this.g.phase !== "play") this.fail("现在不是对局中");
    if (this.cur() !== seat) this.fail("还没轮到你");
  }

  /** 下一个未破产的座位 */
  nextSeat(from) {
    const n = this.g.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!this.g.seats[i].bankrupt) return i;
    }
    return from;
  }

  async roll(seat) {
    this.mustBeTurn(seat);
    if (this.g.pending) this.fail("先把当前的事处理完");
    if (this.g.turn.rolled) this.fail("这一掷已经掷过了");

    const a = 1 + Math.floor(Math.random() * 6);
    const b = 1 + Math.floor(Math.random() * 6);
    const s = this.g.seats[seat];
    this.g.turn.dice = [a, b];
    const isDouble = a === b;

    // 在牢里:掷出双数才能出来
    if (s.jailed) {
      if (isDouble) {
        s.jailed = false;
        s.jailTurns = 0;
        this.note(`${s.nick} 掷出双 ${a},出狱`);
        this.g.turn.rolled = true;
        await this.step(seat, a + b, false); // 出狱这一掷不算双数续掷
        return;
      }
      s.jailTurns++;
      this.note(`${s.nick} 掷 ${a}+${b},没能出狱(第 ${s.jailTurns} 回合)`);
      if (s.jailTurns >= MAX_JAIL_TURNS) {
        this.note(`${s.nick} 蹲满三回合,须缴 ${BAIL} 贯赎身`);
        await this.pay(seat, -1, BAIL, "赎身");
        s.jailed = false;
        s.jailTurns = 0;
        if (!s.bankrupt) {
          this.g.turn.rolled = true;
          await this.step(seat, a + b, false);
          return;
        }
      }
      this.g.turn.rolled = true;
      await this.finishTurn(seat);
      return;
    }

    // 连续三次双数 → 直接入狱
    if (isDouble) {
      this.g.turn.doubles++;
      if (this.g.turn.doubles >= 3) {
        this.note(`${s.nick} 连掷三次双数,被差役盯上,押入大牢`);
        this.toJail(seat);
        await this.finishTurn(seat);
        return;
      }
    } else {
      this.g.turn.doubles = 0;
    }

    this.g.turn.rolled = true;
    this.note(`${s.nick} 掷出 ${a}+${b}=${a + b}${isDouble ? "(双数)" : ""}`);
    await this.step(seat, a + b, isDouble);
  }

  /** 前进 n 格并结算落点 */
  async step(seat, n, canRollAgain) {
    const s = this.g.seats[seat];
    const from = s.pos;
    s.pos = (s.pos + n) % BOARD.length;
    if (s.pos < from) {
      s.cash += PASS_GO;
      this.note(`${s.nick} 过明德门,领 ${PASS_GO} 贯`);
    }
    this.g.turn.canRollAgain = canRollAgain;
    await this.land(seat, n);
  }

  /** 直接移动到某格(诏令用);back=true 时不领过路钱 */
  async jumpTo(seat, to, { pay = true, dice = 0 } = {}) {
    const s = this.g.seats[seat];
    if (pay && to < s.pos) {
      s.cash += PASS_GO;
      this.note(`${s.nick} 过明德门,领 ${PASS_GO} 贯`);
    }
    s.pos = to;
    await this.land(seat, dice);
  }

  /** 结算落点 */
  async land(seat, dice, mult = 1) {
    const s = this.g.seats[seat];
    const i = s.pos;
    const cell = BOARD[i];
    const t = this.g.tiles[i];
    this.note(`${s.nick} 走到 ${cell.name}`);

    if (cell.t === "go" || cell.t === "jail" || cell.t === "free") {
      return this.afterLand(seat);
    }
    if (cell.t === "togo") {
      this.note(`${s.nick} 被差役拿下,押入大牢`);
      this.toJail(seat);
      return this.finishTurn(seat);
    }
    if (cell.t === "tax") {
      await this.pay(seat, -1, cell.amount, cell.name);
      return this.afterLand(seat);
    }
    if (cell.t === "edict") return this.drawCard(seat, "edict");
    if (cell.t === "rumor") return this.drawCard(seat, "rumor");

    // 地产格
    if (t.owner < 0) {
      if (s.cash >= cell.price) {
        this.g.pending = { t: "buy", seat, tile: i };
        await this.commit();
        this.broadcast();
        this.scheduleBot();
        return;
      }
      // 买不起 → 直接流拍进入拍卖
      this.note(`${s.nick} 无力承买 ${cell.name},转入拍卖`);
      return this.openAuction(i);
    }
    if (t.owner === seat) return this.afterLand(seat);
    if (t.mortgaged) {
      this.note(`${cell.name} 已抵押,免租`);
      return this.afterLand(seat);
    }
    const rent = rentOf(this.g, i, dice) * mult;
    const owner = this.g.seats[t.owner];
    this.note(`${s.nick} 付 ${owner.nick} ${rent} 贯${mult > 1 ? "(加倍)" : ""}`);
    await this.pay(seat, t.owner, rent, "租金");
    return this.afterLand(seat);
  }

  /** 落点结算完之后:还有双数就再掷,否则进入自由操作阶段 */
  async afterLand(seat) {
    if (this.g.seats[seat].bankrupt) return this.finishTurn(seat);
    if (this.g.turn.canRollAgain) {
      this.g.turn.rolled = false; // 双数,可以再掷一次
      this.g.turn.canRollAgain = false;
    }
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  toJail(seat) {
    const s = this.g.seats[seat];
    s.pos = JAIL;
    s.jailed = true;
    s.jailTurns = 0;
    this.g.turn.doubles = 0;
    this.g.turn.canRollAgain = false;
  }

  // ---------- 卡牌 ----------

  async drawCard(seat, kind) {
    const s = this.g.seats[seat];
    const deck = kind === "edict" ? this.g.edicts : this.g.rumors;
    const table = kind === "edict" ? EDICTS : RUMORS;
    const key = kind === "edict" ? "edictAt" : "rumorAt";
    if (this.g[key] >= deck.length) this.g[key] = 0;
    const card = table[deck[this.g[key]++]];
    this.note(`【${kind === "edict" ? "诏令" : "市井传闻"}】${card.text}`);

    switch (card.act) {
      case "move":
        return this.jumpTo(seat, card.to);
      case "moveBack": {
        const to = (s.pos - card.n + BOARD.length) % BOARD.length;
        return this.jumpTo(seat, to, { pay: false });
      }
      case "goJail":
        this.toJail(seat);
        return this.finishTurn(seat);
      case "pardon":
        s.pardons++;
        return this.afterLand(seat);
      case "cash":
        if (card.amount >= 0) s.cash += card.amount;
        else await this.pay(seat, -1, -card.amount, "诏令");
        return this.afterLand(seat);
      case "each": {
        for (const [j, o] of this.g.seats.entries()) {
          if (j === seat || o.bankrupt) continue;
          if (card.amount > 0) await this.pay(j, seat, card.amount, "分润");
          else await this.pay(seat, j, -card.amount, "摊派");
          if (s.bankrupt) break;
        }
        return this.afterLand(seat);
      }
      case "repair": {
        let owed = 0;
        for (let i = 0; i < BOARD.length; i++) {
          const t = this.g.tiles[i];
          if (t.owner !== seat) continue;
          if (t.level === 5) owed += card.hotel;
          else owed += t.level * card.house;
        }
        if (owed > 0) {
          this.note(`${s.nick} 缴修缮费 ${owed} 贯`);
          await this.pay(seat, -1, owed, "修缮");
        }
        return this.afterLand(seat);
      }
      case "nearestGate": {
        const to = this.nearestOf(s.pos, "gate");
        await this.jumpTo(seat, to, { pay: true });
        // land 已结算过一次;若是他人产业需再补一倍(合计双倍)
        const t = this.g.tiles[to];
        if (t.owner >= 0 && t.owner !== seat && !t.mortgaged) {
          const extra = rentOf(this.g, to, 0);
          this.note(`${s.nick} 因诏令再付 ${extra} 贯(合计双倍)`);
          await this.pay(seat, t.owner, extra, "加倍通行税");
        }
        return;
      }
      case "nearestCanal": {
        const to = this.nearestOf(s.pos, "canal");
        const d = 1 + Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6);
        const t = this.g.tiles[to];
        if (t.owner >= 0 && t.owner !== seat && !t.mortgaged) {
          await this.jumpTo(seat, to, { pay: true, dice: 0 }); // 先移动,不按常规收租
          this.note(`${s.nick} 掷出 ${d},按十倍缴水利钱`);
          await this.pay(seat, t.owner, d * 10, "水利钱");
          return;
        }
        return this.jumpTo(seat, to, { pay: true, dice: d });
      }
      default:
        return this.afterLand(seat);
    }
  }

  nearestOf(from, type) {
    for (let k = 1; k <= BOARD.length; k++) {
      const i = (from + k) % BOARD.length;
      if (BOARD[i].t === type) return i;
    }
    return from;
  }

  // ---------- 收付与破产 ----------

  /** seat 付给 to(-1 表示付给官府/银行)。付不起就自动变卖,仍不够则破产。 */
  async pay(seat, to, amount, reason) {
    const s = this.g.seats[seat];
    if (amount <= 0) return;

    if (s.cash < amount) {
      // 先看能不能通过变卖建筑 + 抵押凑够
      if (maxRaisable(this.g, seat) < amount) {
        this.note(`${s.nick} 资不抵债,${reason}付不出`);
        return this.bankrupt(seat, to);
      }
      this.autoRaise(seat, amount);
    }
    s.cash -= amount;
    if (to >= 0) this.g.seats[to].cash += amount;
  }

  /** 自动变卖:先拆建筑(半价),再抵押地产,直到够付 */
  autoRaise(seat, need) {
    const s = this.g.seats[seat];
    const mine = () => BOARD.map((_, i) => i).filter((i) => this.g.tiles[i].owner === seat);

    // 先拆建筑,从等级最高的拆(保持组内均衡)
    let guard = 0;
    while (s.cash < need && guard++ < 500) {
      const cand = mine().filter((i) => this.g.tiles[i].level > 0);
      if (!cand.length) break;
      cand.sort((a, b) => this.g.tiles[b].level - this.g.tiles[a].level);
      const i = cand[0];
      this.demolish(i);
      s.cash += Math.floor(GROUPS[BOARD[i].g].houseCost / 2);
    }
    // 再抵押,从最便宜的开始
    guard = 0;
    while (s.cash < need && guard++ < 500) {
      const cand = mine().filter((i) => !this.g.tiles[i].mortgaged && this.g.tiles[i].level === 0);
      if (!cand.length) break;
      cand.sort((a, b) => BOARD[a].price - BOARD[b].price);
      const i = cand[0];
      this.g.tiles[i].mortgaged = true;
      s.cash += mortgageValue(i);
      this.note(`${s.nick} 抵押 ${BOARD[i].name},得 ${mortgageValue(i)} 贯`);
    }
  }

  /** 拆掉一格上的一级建筑,把材料还回存量 */
  demolish(i) {
    const t = this.g.tiles[i];
    if (t.level === 5) { t.level = 4; this.g.hotels++; this.g.houses -= 4; }
    else if (t.level > 0) { t.level--; this.g.houses++; }
  }

  async bankrupt(seat, creditor) {
    const s = this.g.seats[seat];
    s.bankrupt = true;
    const owned = BOARD.map((_, i) => i).filter((i) => this.g.tiles[i].owner === seat);

    if (creditor >= 0) {
      // 欠玩家:建筑折现给债主,地契连同抵押状态一并转移
      let cashFromBuildings = 0;
      for (const i of owned) {
        while (this.g.tiles[i].level > 0) {
          this.demolish(i);
          cashFromBuildings += Math.floor(GROUPS[BOARD[i].g].houseCost / 2);
        }
        this.g.tiles[i].owner = creditor;
      }
      this.g.seats[creditor].cash += s.cash + cashFromBuildings;
      this.g.seats[creditor].pardons += s.pardons;
      this.note(`${s.nick} 破产,全部家当归 ${this.g.seats[creditor].nick}`);
    } else {
      // 欠官府:建筑收回,地契重新发卖
      for (const i of owned) {
        while (this.g.tiles[i].level > 0) this.demolish(i);
        this.g.tiles[i].owner = -1;
        this.g.tiles[i].mortgaged = false;
      }
      this.note(`${s.nick} 破产,名下 ${owned.length} 处产业收归官府,择日发卖`);
      this.g.reauction = owned;
    }
    s.cash = 0;
    s.pardons = 0;

    const alive = this.g.seats.filter((x) => !x.bankrupt);
    if (alive.length <= 1) {
      this.g.phase = "ended";
      this.g.winner = this.g.seats.findIndex((x) => !x.bankrupt);
      this.note(`🏆 ${this.g.seats[this.g.winner].nick} 独占长安!`);
    }
  }

  // ---------- 买地与拍卖 ----------

  async buy(seat) {
    const p = this.g.pending;
    if (p?.t !== "buy" || p.seat !== seat) this.fail("现在不能买地");
    const i = p.tile;
    const price = BOARD[i].price;
    const s = this.g.seats[seat];
    if (s.cash < price) this.fail("现银不够");
    s.cash -= price;
    this.g.tiles[i].owner = seat;
    this.note(`${s.nick} 以 ${price} 贯购下 ${BOARD[i].name}`);
    this.g.pending = null;
    await this.afterLand(seat);
  }

  async decline(seat) {
    const p = this.g.pending;
    if (p?.t !== "buy" || p.seat !== seat) this.fail("现在没有待决定的买地");
    const i = p.tile;
    this.g.pending = null;
    this.note(`${this.g.seats[seat].nick} 放弃承买 ${BOARD[i].name},转入拍卖`);
    await this.openAuction(i);
  }

  async openAuction(tile) {
    const bidders = this.g.seats.map((s, i) => (s.bankrupt ? -1 : i)).filter((i) => i >= 0);
    if (bidders.length === 0) return this.afterLand(this.cur());
    this.g.pending = {
      t: "auction",
      tile,
      high: 0,
      leader: -1,
      alive: bidders,
      at: 0, // alive 里的下标
    };
    this.note(`【发卖】${BOARD[tile].name} 起价 10 贯`);
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  async bid(seat, amount) {
    const p = this.g.pending;
    if (p?.t !== "auction") this.fail("现在没有拍卖");
    if (p.alive[p.at] !== seat) this.fail("还没轮到你出价");
    const amt = Math.floor(Number(amount) || 0);
    const min = p.high === 0 ? 10 : p.high + 1;
    if (amt < min) this.fail(`至少要出 ${min} 贯`);
    if (amt > this.g.seats[seat].cash) this.fail("出价不能超过现银");
    p.high = amt;
    p.leader = seat;
    this.note(`${this.g.seats[seat].nick} 出价 ${amt} 贯`);
    p.at = (p.at + 1) % p.alive.length;
    await this.settleAuction();
  }

  async bidPass(seat) {
    const p = this.g.pending;
    if (p?.t !== "auction") this.fail("现在没有拍卖");
    if (p.alive[p.at] !== seat) this.fail("还没轮到你");
    this.note(`${this.g.seats[seat].nick} 不加价`);
    p.alive.splice(p.at, 1);
    if (p.at >= p.alive.length) p.at = 0;
    await this.settleAuction();
  }

  async settleAuction() {
    const p = this.g.pending;
    // 只剩一人且他就是最高价 → 成交;一个都不剩 → 流拍
    if (p.alive.length === 0 || (p.alive.length === 1 && p.leader === p.alive[0])) {
      const i = p.tile;
      if (p.leader >= 0) {
        const s = this.g.seats[p.leader];
        s.cash -= p.high;
        this.g.tiles[i].owner = p.leader;
        this.note(`${s.nick} 以 ${p.high} 贯拍得 ${BOARD[i].name}`);
      } else {
        this.note(`${BOARD[i].name} 无人应价,仍归官府`);
      }
      this.g.pending = null;
      // 破产清算留下的待发卖队列,一件件卖完
      if (this.g.reauction?.length) {
        const next = this.g.reauction.shift();
        return this.openAuction(next);
      }
      this.g.reauction = null;
      const cur = this.cur();
      if (this.g.phase === "ended") { await this.commit(); this.broadcast(); return; }
      return this.afterLand(cur);
    }
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  // ---------- 建造与抵押 ----------

  /** 盖店/盖商号必须均衡:组内任意两格的等级差不得超过 1 */
  canBuild(seat, i) {
    const cell = BOARD[i];
    if (cell.t !== "ward") return "这里不能营造";
    const t = this.g.tiles[i];
    if (t.owner !== seat) return "不是你的地";
    if (t.mortgaged) return "已抵押的地不能营造";
    if (!hasMonopoly(this.g, seat, cell.g)) return "要先集齐整组才能营造";
    if (t.level >= 5) return "已经是商号了";
    const others = groupTiles(cell.g).filter((j) => j !== i);
    if (others.some((j) => this.g.tiles[j].level < t.level)) return "同组要均衡营造";
    if (t.level === 4) { if (this.g.hotels <= 0) return "商号存量已尽"; }
    else if (this.g.houses <= 0) return "店铺存量已尽";
    if (this.g.seats[seat].cash < GROUPS[cell.g].houseCost) return "现银不够";
    return null;
  }

  async build(seat, i) {
    this.mustBeTurn(seat);
    if (this.g.pending) this.fail("先把当前的事处理完");
    const why = this.canBuild(seat, i);
    if (why) this.fail(why);
    const cell = BOARD[i];
    const t = this.g.tiles[i];
    const cost = GROUPS[cell.g].houseCost;
    this.g.seats[seat].cash -= cost;
    if (t.level === 4) { t.level = 5; this.g.hotels--; this.g.houses += 4; }
    else { t.level++; this.g.houses--; }
    this.note(`${this.g.seats[seat].nick} 在 ${cell.name} 营造,现为${["空地", "一店", "二店", "三店", "四店", "商号"][t.level]}`);
    await this.commit();
    this.broadcast();
  }

  async sellBuild(seat, i) {
    this.mustBeTurn(seat);
    const t = this.g.tiles[i];
    if (t?.owner !== seat) this.fail("不是你的地");
    if (t.level <= 0) this.fail("这里没有建筑");
    const others = groupTiles(BOARD[i].g).filter((j) => j !== i);
    if (others.some((j) => this.g.tiles[j].level > t.level)) this.fail("同组要均衡拆除");
    if (t.level === 5 && this.g.houses < 4) this.fail("店铺存量不足,无法把商号拆回四店");
    this.demolish(i);
    this.g.seats[seat].cash += Math.floor(GROUPS[BOARD[i].g].houseCost / 2);
    this.note(`${this.g.seats[seat].nick} 拆了 ${BOARD[i].name} 的一级建筑`);
    await this.commit();
    this.broadcast();
  }

  async mortgage(seat, i) {
    this.mustBeTurn(seat);
    const t = this.g.tiles[i];
    if (t?.owner !== seat) this.fail("不是你的地");
    if (t.mortgaged) this.fail("已经抵押了");
    if (t.level > 0) this.fail("先拆掉建筑再抵押");
    if (groupTiles(BOARD[i].g ?? "").some((j) => this.g.tiles[j].level > 0)) {
      this.fail("同组还有建筑,先拆完");
    }
    t.mortgaged = true;
    this.g.seats[seat].cash += mortgageValue(i);
    this.note(`${this.g.seats[seat].nick} 抵押 ${BOARD[i].name},得 ${mortgageValue(i)} 贯`);
    await this.commit();
    this.broadcast();
  }

  async redeem(seat, i) {
    this.mustBeTurn(seat);
    const t = this.g.tiles[i];
    if (t?.owner !== seat) this.fail("不是你的地");
    if (!t.mortgaged) this.fail("这块地没抵押");
    const cost = redeemCost(i);
    if (this.g.seats[seat].cash < cost) this.fail("现银不够赎回");
    this.g.seats[seat].cash -= cost;
    t.mortgaged = false;
    this.note(`${this.g.seats[seat].nick} 以 ${cost} 贯赎回 ${BOARD[i].name}`);
    await this.commit();
    this.broadcast();
  }

  // ---------- 监狱 ----------

  async jailPay(seat) {
    this.mustBeTurn(seat);
    const s = this.g.seats[seat];
    if (!s.jailed) this.fail("你不在牢里");
    if (this.g.turn.rolled) this.fail("这一掷已经掷过了");
    await this.pay(seat, -1, BAIL, "赎身");
    if (s.bankrupt) return this.finishTurn(seat);
    s.jailed = false;
    s.jailTurns = 0;
    this.note(`${s.nick} 缴 ${BAIL} 贯赎身`);
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  async jailCard(seat) {
    this.mustBeTurn(seat);
    const s = this.g.seats[seat];
    if (!s.jailed) this.fail("你不在牢里");
    if (s.pardons <= 0) this.fail("你没有免罪金牌");
    s.pardons--;
    s.jailed = false;
    s.jailTurns = 0;
    this.note(`${s.nick} 用免罪金牌出狱`);
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  // ---------- 交易 ----------

  async tradeOffer(seat, m) {
    this.mustBeTurn(seat);
    if (this.g.pending) this.fail("先把当前的事处理完");
    const to = Number(m.to);
    const target = this.g.seats[to];
    if (!target || to === seat || target.bankrupt) this.fail("交易对象不对");

    const give = (m.giveTiles ?? []).map(Number);
    const want = (m.wantTiles ?? []).map(Number);
    const giveCash = Math.max(0, Math.floor(Number(m.giveCash) || 0));
    const wantCash = Math.max(0, Math.floor(Number(m.wantCash) || 0));
    const givePardon = Math.max(0, Math.floor(Number(m.givePardon) || 0));
    const wantPardon = Math.max(0, Math.floor(Number(m.wantPardon) || 0));

    // 有建筑的地不能交易;必须确实属于对应的人
    for (const i of give) {
      if (this.g.tiles[i]?.owner !== seat) this.fail("你拿不出这块地");
      if (this.g.tiles[i].level > 0) this.fail(`${BOARD[i].name} 上有建筑,要先拆掉`);
    }
    for (const i of want) {
      if (this.g.tiles[i]?.owner !== to) this.fail("对方没有这块地");
      if (this.g.tiles[i].level > 0) this.fail(`${BOARD[i].name} 上有建筑,对方要先拆掉`);
    }
    if (giveCash > this.g.seats[seat].cash) this.fail("你的现银不够");
    if (wantCash > target.cash) this.fail("对方现银不够");
    if (givePardon > this.g.seats[seat].pardons) this.fail("你没那么多免罪金牌");
    if (wantPardon > target.pardons) this.fail("对方没那么多免罪金牌");
    if (!give.length && !want.length && !giveCash && !wantCash && !givePardon && !wantPardon) {
      this.fail("空的交易");
    }

    this.g.pending = { t: "trade", from: seat, to, give, want, giveCash, wantCash, givePardon, wantPardon };
    this.note(`${this.g.seats[seat].nick} 向 ${target.nick} 提出交易`);
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  async tradeAccept(seat) {
    const p = this.g.pending;
    if (p?.t !== "trade" || p.to !== seat) this.fail("没有等你回应的交易");
    const a = this.g.seats[p.from], b = this.g.seats[p.to];
    // 再校验一次(提出后到接受前,状态可能变了)
    for (const i of p.give) if (this.g.tiles[i].owner !== p.from || this.g.tiles[i].level > 0) this.fail("交易已失效");
    for (const i of p.want) if (this.g.tiles[i].owner !== p.to || this.g.tiles[i].level > 0) this.fail("交易已失效");
    if (p.giveCash > a.cash || p.wantCash > b.cash) this.fail("交易已失效:现银不足");
    if (p.givePardon > a.pardons || p.wantPardon > b.pardons) this.fail("交易已失效");

    for (const i of p.give) this.g.tiles[i].owner = p.to;
    for (const i of p.want) this.g.tiles[i].owner = p.from;
    a.cash -= p.giveCash; b.cash += p.giveCash;
    b.cash -= p.wantCash; a.cash += p.wantCash;
    a.pardons -= p.givePardon; b.pardons += p.givePardon;
    b.pardons -= p.wantPardon; a.pardons += p.wantPardon;

    this.note(`${a.nick} 与 ${b.nick} 成交`);
    this.g.pending = null;
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  async tradeReject(seat) {
    const p = this.g.pending;
    if (p?.t !== "trade" || (p.to !== seat && p.from !== seat)) this.fail("没有你能回绝的交易");
    this.note(`${this.g.seats[seat].nick} 回绝了交易`);
    this.g.pending = null;
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  // ---------- 结束回合 ----------

  async endTurn(seat) {
    this.mustBeTurn(seat);
    if (this.g.pending) this.fail("先把当前的事处理完");
    if (!this.g.turn.rolled) this.fail("还没掷骰");
    if (this.g.turn.canRollAgain) this.fail("掷出了双数,要再掷一次");
    await this.finishTurn(seat);
  }

  async finishTurn(seat) {
    if (this.g.phase === "ended") {
      await this.commit();
      this.broadcast();
      return;
    }
    const next = this.nextSeat(seat);
    this.g.turn = { seat: next, doubles: 0, rolled: false, dice: null, canRollAgain: false };
    this.g.pending = null;
    await this.commit();
    this.broadcast();
    this.scheduleBot();
  }

  async giveUp(seat) {
    if (this.g.phase !== "play") this.fail("现在不能认输");
    const s = this.g.seats[seat];
    if (s.bankrupt) this.fail("你已经出局了");
    this.note(`${s.nick} 认输离场`);
    await this.bankrupt(seat, -1);
    this.g.reauction = null; // 认输不触发发卖,直接收归官府
    if (this.cur() === seat) return this.finishTurn(seat);
    await this.commit();
    this.broadcast();
  }

  // ---------- 机器人(占位:下一步实现) ----------

  scheduleBot() {
    clearTimeout(this.botTimer);
    this.botTimer = null;
  }
}
