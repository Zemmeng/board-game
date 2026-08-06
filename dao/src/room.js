// GameRoom:一房一实例的 Durable Object,持有权威游戏状态
// 客户端只发动作,这里校验规则、演进状态、按人广播(自己看手牌明细,别人只看张数)
// WebSocket Hibernation + 每次变更落 storage:实例被回收也不丢局
import {
  RES_KEYS, COSTS, BUILD_NAMES, PIECE_LIMIT, BANK_PER_RES,
  PLAYER_COLORS, COLOR_NAMES, DEV_INFO, RES,
  generateBoard, makeDevDeck, shuffle,
  VERTICES, EDGES, VERTEX_EDGES, TILE_VERTICES, tilesOfVertex,
  buildingAt, roadOwner, canPay, legalVillages, legalRoads,
  longestRoadLen, publicVP, totalVP,
} from "../public/js/shared/rules.js";

const IDLE_WIPE_MS = 24 * 60 * 60 * 1000; // 闲置一天后清房

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("game")) ?? null;
    });
  }

  async commit() {
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
        winVP: 10,
        seats: [],
        board: null,
        bank: null,
        deck: [],
        setup: null,
        turn: null,
        longest: { holder: null, len: 0 },
        army: { holder: null },
        log: [],
        winner: null,
        result: null,
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
      this.fail("游戏尚未开始");
    }
    if (g.phase === "ended") this.fail("对局已结束");

    // 有待处理事项时,只放行对应动作
    const p = g.turn?.pending;
    if (p?.t === "discard") {
      if (msg.t !== "discard") this.fail("等待玩家弃牌中");
      return this.onDiscard(seat, msg);
    }
    if (p?.t === "robber") {
      if (msg.t !== "robber" || seat !== g.turn.seat) this.fail("等待当前玩家移动强盗");
      return this.onRobber(seat, msg);
    }

    if (g.phase === "setup") {
      if (msg.t !== "place") this.fail("开局放置阶段");
      return this.onPlace(seat, msg);
    }

    // phase === "play"
    if (seat !== g.turn.seat) this.fail("还没轮到你");
    switch (msg.t) {
      case "roll": return this.onRoll(seat);
      case "build": return this.onBuild(seat, msg);
      case "buy_dev": return this.onBuyDev(seat);
      case "play_dev": return this.onPlayDev(seat, msg);
      case "bank_trade": return this.onBankTrade(seat, msg);
      case "end": return this.onEnd(seat);
      default: this.fail("未知操作");
    }
  }

  // ---------- 大厅 ----------

  async onJoin(ws, msg) {
    const g = this.g;
    const token = String(msg.token ?? "");
    const nick = String(msg.nick ?? "").trim().slice(0, 12) || "无名氏";
    if (!token) this.fail("缺少身份令牌");

    let i = g.seats.findIndex((s) => s.token === token);
    if (i < 0 && g.phase !== "lobby") {
      // 断线换了浏览器标签页等场景:同昵称认领掉线座位
      i = g.seats.findIndex((s) => !s.connected && s.nick === nick);
      if (i >= 0) g.seats[i].token = token;
    }
    if (i < 0) {
      if (g.phase !== "lobby") this.fail("对局已开始,无法中途加入");
      if (g.seats.length >= 4) this.fail("房间已满(最多 4 人)");
      if (g.seats.some((s) => s.nick === nick)) this.fail("昵称和房内玩家重复,换一个吧");
      i = g.seats.length;
      g.seats.push({
        token, nick,
        color: PLAYER_COLORS[i], colorName: COLOR_NAMES[i],
        connected: true,
        res: Object.fromEntries(RES_KEYS.map((k) => [k, 0])),
        devs: [], knights: 0,
        roads: [], villages: [], cities: [],
      });
      this.log(`${nick} 加入了房间`);
    }
    g.seats[i].connected = true;
    ws.serializeAttachment({ token });
    this.send(ws, { t: "joined", seat: i, code: g.code });
    await this.commit();
    this.broadcast();
  }

  async onStart(seat, msg) {
    const g = this.g;
    if (g.seats[seat].token !== g.hostToken) this.fail("只有房主能开始游戏");
    if (g.seats.length < 2) this.fail("至少需要 2 名玩家");
    g.winVP = msg.winVP === 8 ? 8 : 10;

    g.seats = shuffle(g.seats); // 随机行动顺序(等价于官方掷骰定序)
    g.board = generateBoard();
    g.bank = Object.fromEntries(RES_KEYS.map((k) => [k, BANK_PER_RES]));
    g.deck = makeDevDeck();
    g.phase = "setup";
    const n = g.seats.length;
    const seq = [...Array(n).keys(), ...[...Array(n).keys()].reverse()]; // 蛇形
    g.setup = { seq, idx: 0, need: "village", lastVillage: null };
    this.log(`对局开始!目标 ${g.winVP} 分,行动顺序:${g.seats.map((s) => s.nick).join(" → ")}`);
    this.log(`${this.nick(0)} 请放置第一座村庄`);
    await this.commit();
    this.broadcast();
  }

  // ---------- 开局放置 ----------

  async onPlace(seat, msg) {
    const g = this.g;
    const st = g.setup;
    if (st.seq[st.idx] !== seat) this.fail("还没轮到你放置");
    const s = g.seats[seat];

    if (st.need === "village") {
      if (!legalVillages(g, seat).includes(msg.id)) this.fail("这里不能放村庄(注意间隔规则)");
      s.villages.push(msg.id);
      st.lastVillage = msg.id;
      st.need = "road";
      // 第二轮的村庄立刻获得周围地格资源
      if (st.idx >= g.seats.length) {
        const gained = [];
        for (const tk of tilesOfVertex(msg.id)) {
          const tile = g.board.tiles.find((t) => t.k === tk);
          if (tile.kind === "desert") continue;
          if (g.bank[tile.kind] > 0) {
            g.bank[tile.kind]--;
            s.res[tile.kind]++;
            gained.push(RES[tile.kind].name);
          }
        }
        this.log(`${s.nick} 放置了第二座村庄,获得 ${gained.join("、") || "(无资源)"}`);
      } else {
        this.log(`${s.nick} 放置了村庄`);
      }
    } else {
      if (!legalRoads(g, seat).includes(msg.id)) this.fail("道路必须贴着刚放置的村庄");
      s.roads.push(msg.id);
      st.need = "village";
      st.idx++;
      if (st.idx >= st.seq.length) {
        g.phase = "play";
        g.setup = null;
        g.turn = { seat: 0, n: 1, rolled: false, dice: null, devPlayed: false, pending: null, freeRoads: 0 };
        this.log(`开局放置完毕,${this.nick(0)} 的回合,请掷骰`);
      } else {
        this.log(`${s.nick} 铺设了道路,轮到 ${this.nick(st.seq[st.idx])}`);
      }
    }
    await this.commit();
    this.broadcast();
  }

  // ---------- 回合:产出 ----------

  async onRoll(seat) {
    const g = this.g;
    if (g.turn.rolled) this.fail("本回合已经掷过骰子");
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const roll = d1 + d2;
    g.turn.dice = [d1, d2];
    g.turn.rolled = true;
    this.log(`${this.nick(seat)} 掷出 ${d1} + ${d2} = ${roll}`);

    if (roll === 7) {
      // 弃一半(发展卡不计入手牌数)
      const need = {};
      g.seats.forEach((s, i) => {
        const total = RES_KEYS.reduce((a, k) => a + s.res[k], 0);
        if (total > 7) need[i] = Math.floor(total / 2);
      });
      if (Object.keys(need).length > 0) {
        g.turn.pending = { t: "discard", need };
        this.log(`手牌超过 7 张的玩家需要弃掉一半:${Object.keys(need).map((i) => this.nick(+i)).join("、")}`);
      } else {
        g.turn.pending = { t: "robber" };
        this.log(`${this.nick(seat)} 请移动强盗`);
      }
    } else {
      this.produce(roll);
      this.checkWin(seat);
    }
    await this.commit();
    this.broadcast();
  }

  produce(roll) {
    const g = this.g;
    // 汇总需求:村 1 张、城 2 张;强盗所在格不产出
    const demand = g.seats.map(() => Object.fromEntries(RES_KEYS.map((k) => [k, 0])));
    for (const tile of g.board.tiles) {
      if (tile.num !== roll || tile.k === g.board.robber) continue;
      for (const vid of TILE_VERTICES.get(tile.k)) {
        const b = buildingAt(g, vid);
        if (b) demand[b.seat][tile.kind] += b.type === "city" ? 2 : 1;
      }
    }
    // 银行短缺规则:某资源不够分且多人都要 → 谁都不发;仅一人要 → 发剩余
    for (const k of RES_KEYS) {
      const total = demand.reduce((a, d) => a + d[k], 0);
      if (total === 0) continue;
      const takers = demand.filter((d) => d[k] > 0).length;
      if (g.bank[k] < total && takers > 1) {
        this.log(`银行的${RES[k].name}不够分,本次无人获得`);
        demand.forEach((d) => { d[k] = 0; });
      }
    }
    g.seats.forEach((s, i) => {
      const gained = [];
      for (const k of RES_KEYS) {
        const n = Math.min(demand[i][k], g.bank[k]);
        if (n > 0) {
          g.bank[k] -= n;
          s.res[k] += n;
          gained.push(`${RES[k].name}×${n}`);
        }
      }
      if (gained.length) this.log(`${s.nick} 获得 ${gained.join("、")}`);
    });
  }

  // ---------- 掷 7:弃牌与强盗 ----------

  async onDiscard(seat, msg) {
    const g = this.g;
    const need = g.turn.pending.need;
    if (!(seat in need)) this.fail("你不需要弃牌");
    const give = msg.give ?? {};
    const s = g.seats[seat];
    let sum = 0;
    for (const [k, n] of Object.entries(give)) {
      if (!RES_KEYS.includes(k) || !Number.isInteger(n) || n < 0) this.fail("弃牌数据不合法");
      if (n > s.res[k]) this.fail("弃牌数量超过持有量");
      sum += n;
    }
    if (sum !== need[seat]) this.fail(`需要正好弃掉 ${need[seat]} 张`);
    for (const [k, n] of Object.entries(give)) {
      s.res[k] -= n;
      g.bank[k] += n;
    }
    this.log(`${s.nick} 弃掉了 ${sum} 张手牌`);
    delete need[seat];
    if (Object.keys(need).length === 0) {
      g.turn.pending = { t: "robber" };
      this.log(`${this.nick(g.turn.seat)} 请移动强盗`);
    }
    await this.commit();
    this.broadcast();
  }

  async onRobber(seat, msg) {
    const g = this.g;
    const tile = g.board.tiles.find((t) => t.k === msg.tile);
    if (!tile) this.fail("请选择一个地格");
    if (tile.k === g.board.robber) this.fail("强盗必须移动到新的地格");
    g.board.robber = tile.k;

    // 该格有建筑且有手牌的对手,必须偷其一
    const victims = [];
    for (const vid of TILE_VERTICES.get(tile.k)) {
      const b = buildingAt(g, vid);
      if (b && b.seat !== seat && !victims.includes(b.seat)) {
        if (RES_KEYS.some((k) => g.seats[b.seat].res[k] > 0)) victims.push(b.seat);
      }
    }
    const tileName = tile.kind === "desert" ? "荒漠" : RES[tile.kind].tile;
    if (victims.length === 0) {
      this.log(`${this.nick(seat)} 把强盗移到了${tileName},无人可偷`);
    } else {
      const victim = msg.victim;
      if (!victims.includes(victim)) this.fail("必须从该格有建筑的玩家中选择偷取对象");
      const v = g.seats[victim];
      const pool = [];
      for (const k of RES_KEYS) for (let i = 0; i < v.res[k]; i++) pool.push(k);
      const stolen = pool[Math.floor(Math.random() * pool.length)];
      v.res[stolen]--;
      g.seats[seat].res[stolen]++;
      this.log(`${this.nick(seat)} 把强盗移到了${tileName},从 ${v.nick} 那里偷走 1 张牌`);
    }
    g.turn.pending = null;
    await this.commit();
    this.broadcast();
  }

  // ---------- 建造 ----------

  spendOrFail(seat, cost) {
    const s = this.g.seats[seat];
    if (!canPay(s.res, cost)) {
      const missing = Object.entries(cost)
        .filter(([k, n]) => s.res[k] < n)
        .map(([k, n]) => `${RES[k].name}×${n - s.res[k]}`);
      this.fail(`资源不足,还差 ${missing.join("、")}`);
    }
    for (const [k, n] of Object.entries(cost)) {
      s.res[k] -= n;
      this.g.bank[k] += n;
    }
  }

  async onBuild(seat, msg) {
    const g = this.g;
    const s = g.seats[seat];
    const kind = msg.kind;
    const free = kind === "road" && g.turn.freeRoads > 0;
    if (!g.turn.rolled && !free) this.fail("请先掷骰");

    if (kind === "road") {
      if (s.roads.length >= PIECE_LIMIT.road) this.fail("道路棋子用完了(上限 15)");
      if (!legalRoads(g, seat).includes(msg.id)) this.fail("道路必须连接你的路网或建筑");
      if (free) g.turn.freeRoads--;
      else this.spendOrFail(seat, COSTS.road);
      s.roads.push(msg.id);
      this.log(`${s.nick} 修建了道路${free ? "(筑路卡免费)" : ""}`);
      this.updateLongest(seat);
    } else if (kind === "village") {
      if (s.villages.length >= PIECE_LIMIT.village) this.fail("村庄棋子用完了(上限 5,升级城邑可腾出)");
      if (!legalVillages(g, seat).includes(msg.id)) this.fail("村庄要建在自己路上,且与任何建筑至少隔 2 条棱");
      this.spendOrFail(seat, COSTS.village);
      s.villages.push(msg.id);
      this.log(`${s.nick} 建立了村庄`);
      this.updateLongest(seat); // 建村可能截断别人的最长路
    } else if (kind === "city") {
      if (s.cities.length >= PIECE_LIMIT.city) this.fail("城邑棋子用完了(上限 4)");
      const vi = s.villages.indexOf(msg.id);
      if (vi < 0) this.fail("只能把自己的村庄升级为城邑");
      this.spendOrFail(seat, COSTS.city);
      s.villages.splice(vi, 1);
      s.cities.push(msg.id);
      this.log(`${s.nick} 把村庄升级为城邑`);
    } else {
      this.fail("未知建造类型");
    }
    this.checkWin(seat);
    await this.commit();
    this.broadcast();
  }

  // ---------- 发展卡 ----------

  async onBuyDev(seat) {
    const g = this.g;
    if (!g.turn.rolled) this.fail("请先掷骰");
    if (g.deck.length === 0) this.fail("发展卡已经卖完了");
    this.spendOrFail(seat, COSTS.dev);
    const card = g.deck.pop();
    g.seats[seat].devs.push({ c: card, t: g.turn.n });
    this.log(`${this.nick(seat)} 购买了 1 张发展卡(剩 ${g.deck.length} 张)`);
    this.checkWin(seat); // 买到胜利点卡可能直接达标
    await this.commit();
    this.broadcast();
  }

  async onPlayDev(seat, msg) {
    const g = this.g;
    const s = g.seats[seat];
    if (g.turn.devPlayed) this.fail("每回合只能打出 1 张发展卡");
    const di = s.devs.findIndex((d) => d.c === msg.card && d.t < g.turn.n);
    if (msg.card === "vp") this.fail("胜利点卡无需打出,达到目标分会自动亮出");
    if (di < 0) this.fail("没有可打出的这张卡(当回合购买的不能打)");

    const card = msg.card;
    if (card === "knight") {
      s.devs.splice(di, 1);
      s.knights++;
      this.log(`${s.nick} 打出「骑士」(累计 ${s.knights} 名)`);
      this.updateArmy(seat);
      g.turn.pending = { t: "robber" };
    } else if (card === "monopoly") {
      if (!RES_KEYS.includes(msg.res)) this.fail("请选择要垄断的资源");
      s.devs.splice(di, 1);
      let got = 0;
      g.seats.forEach((o, i) => {
        if (i === seat) return;
        got += o.res[msg.res];
        s.res[msg.res] += o.res[msg.res];
        o.res[msg.res] = 0;
      });
      this.log(`${s.nick} 打出「垄断」,收走所有人的${RES[msg.res].name},共 ${got} 张`);
    } else if (card === "invent") {
      const picks = [msg.res, msg.res2];
      if (!picks.every((k) => RES_KEYS.includes(k))) this.fail("请选择要拿取的 2 张资源");
      const needBank = {};
      picks.forEach((k) => { needBank[k] = (needBank[k] ?? 0) + 1; });
      for (const [k, n] of Object.entries(needBank)) {
        if (g.bank[k] < n) this.fail(`银行的${RES[k].name}不足`);
      }
      s.devs.splice(di, 1);
      picks.forEach((k) => { g.bank[k]--; s.res[k]++; });
      this.log(`${s.nick} 打出「丰收」,获得 ${picks.map((k) => RES[k].name).join("、")}`);
    } else if (card === "roads") {
      if (s.roads.length >= PIECE_LIMIT.road) this.fail("道路棋子已用完");
      if (legalRoads(g, seat).length === 0) this.fail("当前没有可以修路的位置");
      s.devs.splice(di, 1);
      g.turn.freeRoads = 2;
      this.log(`${s.nick} 打出「筑路」,可免费修建 2 条道路`);
    } else {
      this.fail("未知发展卡");
    }
    g.turn.devPlayed = true;
    this.checkWin(seat);
    await this.commit();
    this.broadcast();
  }

  // ---------- 交换与回合流转 ----------

  async onBankTrade(seat, msg) {
    const g = this.g;
    if (!g.turn.rolled) this.fail("请先掷骰");
    const { give, get } = msg;
    if (!RES_KEYS.includes(give) || !RES_KEYS.includes(get) || give === get) this.fail("交换参数不合法");
    const s = g.seats[seat];
    if (s.res[give] < 4) this.fail(`4:1 交换需要 4 张${RES[give].name}`);
    if (g.bank[get] < 1) this.fail(`银行没有${RES[get].name}了`);
    s.res[give] -= 4;
    g.bank[give] += 4;
    g.bank[get]--;
    s.res[get]++;
    this.log(`${s.nick} 用 4 张${RES[give].name}换了 1 张${RES[get].name}`);
    await this.commit();
    this.broadcast();
  }

  async onEnd(seat) {
    const g = this.g;
    if (!g.turn.rolled) this.fail("掷骰后才能结束回合");
    g.turn.seat = (seat + 1) % g.seats.length;
    g.turn.n++;
    g.turn.rolled = false;
    g.turn.devPlayed = false;
    g.turn.freeRoads = 0;
    g.turn.pending = null;
    this.log(`轮到 ${this.nick(g.turn.seat)} 的回合`);
    await this.commit();
    this.broadcast();
  }

  // ---------- 称号与胜负 ----------

  updateArmy(seat) {
    const g = this.g;
    const a = g.army;
    const k = g.seats[seat].knights;
    if (a.holder === null && k >= 3) {
      a.holder = seat;
      this.log(`⚔️ ${this.nick(seat)} 获得「最大军团」(+2 分)`);
    } else if (a.holder !== null && a.holder !== seat && k > g.seats[a.holder].knights) {
      this.log(`⚔️「最大军团」从 ${this.nick(a.holder)} 转移给 ${this.nick(seat)}`);
      a.holder = seat;
    }
  }

  updateLongest(actor) {
    const g = this.g;
    const lens = g.seats.map((_, i) => longestRoadLen(g, i));
    const L = g.longest;
    const prev = L.holder;
    if (prev !== null && lens[prev] >= 5) {
      // 现任保持,除非有人严格更长
      const challengers = g.seats.map((_, i) => i).filter((i) => lens[i] > lens[prev]);
      if (challengers.length > 0) {
        L.holder = challengers.includes(actor) ? actor : challengers[0];
      }
    } else {
      // 无人持有,或现任被截断跌破 5:唯一的 ≥5 最长者获得,否则空缺
      const max = Math.max(...lens);
      const cands = g.seats.map((_, i) => i).filter((i) => lens[i] === max);
      L.holder = max >= 5 && cands.length === 1 ? cands[0] : null;
    }
    L.len = L.holder !== null ? lens[L.holder] : 0;
    if (L.holder !== prev) {
      if (L.holder === null) this.log(`🛤️ 最长路被截断,「最长路」称号暂时空缺`);
      else if (prev === null) this.log(`🛤️ ${this.nick(L.holder)} 获得「最长路」(${L.len} 段,+2 分)`);
      else this.log(`🛤️「最长路」从 ${this.nick(prev)} 转移给 ${this.nick(L.holder)}(${L.len} 段)`);
    }
  }

  checkWin(seat) {
    const g = this.g;
    if (g.phase !== "play" || seat !== g.turn.seat) return;
    if (totalVP(g, seat) < g.winVP) return;
    g.phase = "ended";
    g.winner = seat;
    g.result = g.seats.map((s, i) => ({
      nick: s.nick,
      color: s.color,
      vp: totalVP(g, i),
      villages: s.villages.length,
      cities: s.cities.length,
      vpCards: s.devs.filter((d) => d.c === "vp").length,
      longest: g.longest.holder === i,
      army: g.army.holder === i,
    }));
    const vpCards = g.seats[seat].devs.filter((d) => d.c === "vp").length;
    this.log(`🏆 ${this.nick(seat)} 达到 ${totalVP(g, seat)} 分获胜!` +
      (vpCards ? `(亮出 ${vpCards} 张胜利点卡)` : ""));
  }

  // ---------- 广播(按人裁剪) ----------

  personalize(viewerSeat) {
    const g = this.g;
    return {
      code: g.code,
      phase: g.phase,
      winVP: g.winVP,
      you: viewerSeat,
      hostSeat: g.seats.findIndex((s) => s.token === g.hostToken),
      seats: g.seats.map((s, i) => {
        const base = {
          nick: s.nick, color: s.color, colorName: s.colorName,
          connected: s.connected,
          roads: s.roads, villages: s.villages, cities: s.cities,
          knights: s.knights,
          resCount: RES_KEYS.reduce((a, k) => a + s.res[k], 0),
          devCount: s.devs.length,
        };
        if (i === viewerSeat || g.phase === "ended") {
          base.res = s.res;
          base.devs = s.devs;
        }
        return base;
      }),
      board: g.board,
      bank: g.bank,
      deckCount: g.deck.length,
      setup: g.setup,
      turn: g.turn,
      longest: g.longest,
      army: g.army,
      log: g.log,
      winner: g.winner,
      result: g.result,
    };
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatOf(ws);
      this.send(ws, { t: "state", g: this.personalize(seat) });
    }
  }
}
