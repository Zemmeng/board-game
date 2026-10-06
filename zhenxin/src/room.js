// TruthRoom:「匿名真心话」房间 Durable Object,持有权威状态
// 一轮流程:ask(提问者出题)→ answer(其他人匿名作答)→ guess(提问者猜每条是谁写的)→ reveal(揭晓)
// 匿名性全靠服务端:揭晓前,回答的作者只存在这里,从不下发给任何客户端

const PLAYER_COLORS = [
  "#e2566b", "#3d7edb", "#e8912d", "#8e63c9", "#3aa88a", "#c9a23f",
  "#d0609e", "#4bb0c9", "#7a9a3a", "#b0603a", "#6b6fd6", "#9a9a9a",
];
const IDLE_WIPE_MS = 24 * 60 * 60 * 1000;
const MAX_PLAYERS = 12;
const MAX_HISTORY = 30;
const Q_MAX = 120;
const A_MAX = 300;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const shortId = () => crypto.randomUUID().slice(0, 8);

export class TruthRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.blockConcurrencyWhile(async () => {
      this.g = (await this.ctx.storage.get("game")) ?? null;
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
      if (this.g) return new Response("room exists", { status: 409 });
      const { hostToken } = JSON.parse(await request.text());
      this.g = {
        v: 0,
        code: url.searchParams.get("code"),
        phase: "lobby",
        hostToken,
        players: [],
        round: 0,
        askerId: null,
        question: null,
        answerers: [],
        answers: [],
        guesses: {},
        history: [],
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

  playerOf(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.token || !this.g) return null;
    return this.g.players.find((p) => p.token === att.token) ?? null;
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
    const p = this.playerOf(ws);
    if (p) {
      p.connected = this.ctx.getWebSockets()
        .some((w) => w !== ws && w.deserializeAttachment()?.token === p.token);
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

  isHost(p) { return p.token === this.g.hostToken; }
  byId(id) { return this.g.players.find((p) => p.id === id); }

  // ---------- 消息分发 ----------

  async handle(ws, msg) {
    const g = this.g;
    if (!g) this.fail("房间不存在或已过期");
    if (msg.t === "join") return this.onJoin(ws, msg);
    const me = this.playerOf(ws);
    if (!me) this.fail("请先加入房间");

    switch (msg.t) {
      case "leave": return this.onLeave(ws, me);
      case "kick": return this.onKick(me, msg);
      case "start": return this.onStart(me);
      case "ask": return this.onAsk(me, msg);
      case "skip": return this.onSkip(me);
      case "answer": return this.onAnswer(me, msg);
      case "force": return this.onForce(me);
      case "guess": return this.onGuess(me, msg);
      case "confirm": return this.onConfirm(me);
      case "next": return this.onNext(me);
    }
    this.fail("未知操作");
  }

  async save() {
    await this.commit();
    this.broadcast();
  }

  // ---------- 进出房间 ----------

  async onJoin(ws, msg) {
    const g = this.g;
    const token = String(msg.token ?? "");
    const nick = String(msg.nick ?? "").trim().slice(0, 12);
    if (!token) this.fail("缺少身份令牌");
    let p = g.players.find((x) => x.token === token);
    if (!p) {
      if (!nick) this.fail("先起个昵称吧");
      if (g.players.length >= MAX_PLAYERS) this.fail(`房间已满(最多 ${MAX_PLAYERS} 人)`);
      if (g.players.some((x) => x.nick === nick)) this.fail("昵称和房里的人重复了,换一个吧");
      const used = new Set(g.players.map((x) => x.color));
      // 中途加入的人从「已提问次数」的最小值起算,免得一进来就连着当提问者
      const minAsked = g.players.length ? Math.min(...g.players.map((x) => x.asked)) : 0;
      p = {
        id: shortId(), token, nick, connected: true, score: 0, asked: minAsked,
        color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
      };
      g.players.push(p);
      // 房主令牌失效(房主已离开)时,第一个进来的人接任
      if (!g.players.some((x) => x.token === g.hostToken)) g.hostToken = token;
    }
    p.connected = true;
    ws.serializeAttachment({ token });
    this.send(ws, { t: "joined", id: p.id, code: g.code });
    await this.save();
  }

  async onLeave(ws, me) {
    this.removePlayer(me.id);
    ws.serializeAttachment(null);
    this.send(ws, { t: "left" });
    await this.save();
  }

  async onKick(me, msg) {
    if (!this.isHost(me)) this.fail("只有房主能请人离开");
    const target = this.byId(msg.id);
    if (!target) this.fail("没有这个人");
    if (target === me) this.fail("不能请自己离开");
    this.removePlayer(target.id);
    for (const w of this.ctx.getWebSockets()) {
      if (w.deserializeAttachment()?.token === target.token) {
        this.send(w, { t: "kicked" });
        w.serializeAttachment(null);
      }
    }
    await this.save();
  }

  // 有人离开:按当前阶段把他从这一轮里摘干净
  removePlayer(id) {
    const g = this.g;
    const idx = g.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [gone] = g.players.splice(idx, 1);
    if (gone.token === g.hostToken) {
      const heir = g.players.find((p) => p.connected) ?? g.players[0];
      g.hostToken = heir?.token ?? null;
    }
    if (g.phase === "lobby" || g.phase === "reveal") return;
    if (g.players.length < 2) return this.toLobby();
    if (g.askerId === id) return this.newRound();

    g.answerers = g.answerers.filter((x) => x !== id);
    const mine = g.answers.find((a) => a.by === id);
    g.answers = g.answers.filter((a) => a.by !== id);
    if (g.phase === "answer") {
      if (!g.answerers.length) return this.newRound();
      this.maybeAllAnswered();
    } else if (g.phase === "guess") {
      if (!g.answers.length) return this.newRound();
      if (mine) delete g.guesses[mine.id];
      for (const [aid, pid] of Object.entries(g.guesses)) if (pid === id) delete g.guesses[aid];
    }
  }

  toLobby() {
    const g = this.g;
    g.phase = "lobby";
    g.askerId = null;
    g.question = null;
    g.answerers = [];
    g.answers = [];
    g.guesses = {};
  }

  // ---------- 轮次 ----------

  async onStart(me) {
    const g = this.g;
    if (g.phase !== "lobby") this.fail("游戏已经开始了");
    if (!this.isHost(me)) this.fail("只有房主能开始");
    if (g.players.length < 2) this.fail("至少要 2 个人才能玩(3 人以上更好猜)");
    this.newRound();
    await this.save();
  }

  // 下一位提问者:在线的人里提问次数最少的,同数按座次;尽量不连庄
  pickAsker() {
    const g = this.g;
    let pool = g.players.filter((p) => p.connected);
    if (!pool.length) pool = g.players;
    if (pool.length > 1) pool = pool.filter((p) => p.id !== g.askerId);
    return pool.reduce((best, p) => (p.asked < best.asked ? p : best));
  }

  newRound() {
    const g = this.g;
    const asker = this.pickAsker();
    asker.asked++;
    g.round++;
    g.phase = "ask";
    g.askerId = asker.id;
    g.question = null;
    g.answerers = [];
    g.answers = [];
    g.guesses = {};
  }

  async onAsk(me, msg) {
    const g = this.g;
    if (g.phase !== "ask") this.fail("现在不是提问环节");
    if (me.id !== g.askerId) this.fail("这一轮不是你提问");
    const text = String(msg.text ?? "").trim().slice(0, Q_MAX);
    if (!text) this.fail("问题不能是空的");
    g.question = text;
    g.answerers = g.players.filter((p) => p.id !== me.id).map((p) => p.id);
    g.answers = [];
    g.phase = "answer";
    await this.save();
  }

  async onSkip(me) {
    const g = this.g;
    if (g.phase !== "ask") this.fail("只能在出题时换人");
    if (me.id !== g.askerId && !this.isHost(me)) this.fail("只有提问者或房主能换人");
    this.newRound();
    await this.save();
  }

  async onAnswer(me, msg) {
    const g = this.g;
    if (g.phase !== "answer") this.fail("现在不是回答环节");
    if (!g.answerers.includes(me.id)) {
      this.fail(me.id === g.askerId ? "提问的人不用回答,等着猜就好" : "这一轮开始后才进来的,下一轮再答吧");
    }
    const text = String(msg.text ?? "").trim().slice(0, A_MAX);
    if (!text) this.fail("回答不能是空的");
    const mine = g.answers.find((a) => a.by === me.id);
    if (mine) mine.text = text;
    else g.answers.push({ id: shortId(), by: me.id, text });
    this.maybeAllAnswered();
    await this.save();
  }

  maybeAllAnswered() {
    const g = this.g;
    if (g.answerers.length && g.answerers.every((id) => g.answers.some((a) => a.by === id))) {
      this.toGuess();
    }
  }

  async onForce(me) {
    const g = this.g;
    if (g.phase !== "answer") this.fail("现在不是回答环节");
    if (me.id !== g.askerId && !this.isHost(me)) this.fail("只有提问者或房主能提前收卷");
    if (!g.answers.length) this.fail("还没有人交答案");
    this.toGuess();
    await this.save();
  }

  // 收卷:没交的人退出本轮候选;答案打乱顺序,免得按交卷先后猜出是谁
  toGuess() {
    const g = this.g;
    g.answerers = g.answerers.filter((id) => g.answers.some((a) => a.by === id));
    g.answers = shuffle(g.answers);
    g.guesses = {};
    g.phase = "guess";
  }

  async onGuess(me, msg) {
    const g = this.g;
    if (g.phase !== "guess") this.fail("现在不是猜的环节");
    if (me.id !== g.askerId) this.fail("只有提问者能猜");
    const aid = String(msg.aid ?? "");
    if (!g.answers.some((a) => a.id === aid)) this.fail("没有这条回答");
    const pid = msg.pid == null ? null : String(msg.pid);
    if (pid === null) {
      delete g.guesses[aid];
    } else {
      if (!g.answerers.includes(pid)) this.fail("这个人没有参与本轮回答");
      // 一人只写了一条:把同一个人从别的回答上挪过来
      for (const [k, v] of Object.entries(g.guesses)) if (v === pid) delete g.guesses[k];
      g.guesses[aid] = pid;
    }
    await this.save();
  }

  async onConfirm(me) {
    const g = this.g;
    if (g.phase !== "guess") this.fail("现在不是猜的环节");
    if (me.id !== g.askerId) this.fail("只有提问者能揭晓");
    if (g.answers.some((a) => !g.guesses[a.id])) this.fail("每条回答都要猜一个人");
    const asker = this.byId(g.askerId);
    const items = g.answers.map((a) => {
      const ok = g.guesses[a.id] === a.by;
      if (ok) asker.score++;
      else { const au = this.byId(a.by); if (au) au.score++; }
      return {
        text: a.text,
        by: this.byId(a.by)?.nick ?? "?",
        guess: this.byId(g.guesses[a.id])?.nick ?? "?",
        ok,
      };
    });
    g.history.unshift({ round: g.round, asker: asker.nick, question: g.question, items });
    if (g.history.length > MAX_HISTORY) g.history.length = MAX_HISTORY;
    g.phase = "reveal";
    await this.save();
  }

  async onNext(me) {
    const g = this.g;
    if (g.phase !== "reveal") this.fail("还没揭晓呢");
    if (me.id !== g.askerId && !this.isHost(me)) this.fail("由提问者或房主开下一轮");
    if (g.players.length < 2) { this.toLobby(); await this.save(); return; }
    this.newRound();
    await this.save();
  }

  // ---------- 广播:按人裁剪 ----------

  view(me) {
    const g = this.g;
    const reveal = g.phase === "reveal";
    const showAnswers = g.phase === "guess" || reveal;
    return {
      v: g.v,
      code: g.code,
      phase: g.phase,
      me: me?.id ?? null,
      hostId: g.players.find((p) => p.token === g.hostToken)?.id ?? null,
      players: g.players.map((p) => ({
        id: p.id, nick: p.nick, connected: p.connected, score: p.score, color: p.color,
      })),
      round: g.round,
      askerId: g.askerId,
      question: g.question,
      answerers: g.answerers,
      // 回答阶段只公开「谁交了」,不公开内容
      answered: g.answers.map((a) => a.by).filter((id) => g.answerers.includes(id)),
      myAnswer: g.answers.find((a) => a.by === me?.id)?.text ?? null,
      answers: showAnswers
        ? g.answers.map((a) => ({
          id: a.id,
          text: a.text,
          mine: a.by === me?.id,
          ...(reveal ? { by: a.by } : {}),
        }))
        : [],
      guesses: showAnswers ? g.guesses : {},
      history: g.history,
    };
  }

  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att?.token) continue;
      const me = this.g?.players.find((p) => p.token === att.token);
      if (!me) continue;
      this.send(ws, { t: "state", g: this.view(me) });
    }
  }
}
