// TruthRoom:「匿名真心话」房间 Durable Object,持有权威状态
// 一轮流程:setup(房主点提问者和猜的人)→ ask(出题)→ answer(除猜的人外全员匿名作答,提问者也答)
//        → guess(猜的人给每条配作者)→ vote(全员投票是否公布作者,过半才公布)→ reveal
// 不公布的轮次:只公开「猜中几条」,回答者不加分也不记骗过/被猜中——否则分数变化会暴露身份
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

const newStats = () => ({ asked: 0, guessed: 0, hit: 0, guessTotal: 0, answered: 0, fooled: 0, caught: 0 });

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
        guesserId: null,
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
      case "pick": return this.onPick(me, msg);
      case "ask": return this.onAsk(me, msg);
      case "skip": return this.onSkip(me);
      case "answer": return this.onAnswer(me, msg);
      case "force": return this.onForce(me);
      case "guess": return this.onGuess(me, msg);
      case "confirm": return this.onConfirm(me);
      case "next": return this.onNext(me);
      case "vote": return this.onVote(me, msg);
      case "endvote": return this.onEndVote(me);
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
      p = {
        id: shortId(), token, nick, connected: true, score: 0, stats: newStats(),
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
    if (g.phase === "vote") {
      g.voters = g.voters.filter((x) => x !== id);
      delete g.votes[id];
      return this.maybeVoteDone();
    }
    if (g.players.length < 2) return this.toLobby();
    if (g.phase === "setup") return;
    // 猜的人走了这轮就没法玩;提问者在出题前走了也一样
    if (g.guesserId === id || (g.phase === "ask" && g.askerId === id)) return this.toSetup();

    g.answerers = g.answerers.filter((x) => x !== id);
    const mine = g.answers.find((a) => a.by === id);
    g.answers = g.answers.filter((a) => a.by !== id);
    if (g.phase === "answer") {
      if (!g.answerers.length) return this.toSetup();
      this.maybeAllAnswered();
    } else if (g.phase === "guess") {
      if (!g.answers.length) return this.toSetup();
      if (mine) delete g.guesses[mine.id];
      for (const [aid, pid] of Object.entries(g.guesses)) if (pid === id) delete g.guesses[aid];
    }
  }

  clearRound() {
    const g = this.g;
    g.question = null;
    g.answerers = [];
    g.answers = [];
    g.guesses = {};
    g.result = null;
    g.voters = [];
    g.votes = {};
    g.published = null;
  }

  toLobby() {
    this.g.phase = "lobby";
    this.g.askerId = null;
    this.g.guesserId = null;
    this.clearRound();
  }

  // 回到「房主点人」环节;askerId/guesserId 保留上一轮的,方便前端默认选中
  toSetup() {
    this.g.phase = "setup";
    this.clearRound();
  }

  // ---------- 轮次 ----------

  async onStart(me) {
    const g = this.g;
    if (g.phase !== "lobby") this.fail("游戏已经开始了");
    if (!this.isHost(me)) this.fail("只有房主能开始");
    if (g.players.length < 2) this.fail("至少要 2 个人才能玩(3 人以上更好猜)");
    this.toSetup();
    await this.save();
  }

  // 房主点名:谁提问、谁来猜(可以是同一个人)
  async onPick(me, msg) {
    const g = this.g;
    if (g.phase !== "setup") this.fail("现在不是点人的时候");
    if (!this.isHost(me)) this.fail("只有房主能点人");
    const asker = this.byId(msg.asker), guesser = this.byId(msg.guesser);
    if (!asker || !guesser) this.fail("请选好提问的人和猜的人");
    if (g.players.length - 1 < 1) this.fail("除了猜的人,至少还要有 1 个人回答");
    g.round++;
    g.askerId = asker.id;
    g.guesserId = guesser.id;
    this.clearRound();
    g.phase = "ask";
    await this.save();
  }

  async onAsk(me, msg) {
    const g = this.g;
    if (g.phase !== "ask") this.fail("现在不是提问环节");
    if (me.id !== g.askerId) this.fail("这一轮不是你提问");
    const text = String(msg.text ?? "").trim().slice(0, Q_MAX);
    if (!text) this.fail("问题不能是空的");
    g.question = text;
    me.stats.asked++;
    // 除了猜的人,所有人都答(提问者也答)
    g.answerers = g.players.filter((p) => p.id !== g.guesserId).map((p) => p.id);
    g.answers = [];
    g.phase = "answer";
    await this.save();
  }

  async onSkip(me) {
    const g = this.g;
    if (g.phase !== "ask" && g.phase !== "answer") this.fail("现在不能重新点人");
    if (!this.isHost(me)) this.fail("只有房主能重新点人");
    g.round--;
    this.toSetup();
    await this.save();
  }

  async onAnswer(me, msg) {
    const g = this.g;
    if (g.phase !== "answer") this.fail("现在不是回答环节");
    if (!g.answerers.includes(me.id)) {
      this.fail(me.id === g.guesserId ? "猜的人不用回答,等着猜就好" : "这一轮开始后才进来的,下一轮再答吧");
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
    if (me.id !== g.guesserId && !this.isHost(me)) this.fail("只有猜的人或房主能提前收卷");
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
    if (me.id !== g.guesserId) this.fail("这一轮不是你猜");
    const aid = String(msg.aid ?? "");
    if (!g.answers.some((a) => a.id === aid)) this.fail("没有这条回答");
    const pid = msg.pid == null ? null : String(msg.pid);
    if (pid === null) {
      delete g.guesses[aid];
    } else {
      if (!g.answerers.includes(pid)) this.fail("这个人没有参与本轮回答");
      for (const [k, v] of Object.entries(g.guesses)) if (v === pid) delete g.guesses[k];
      g.guesses[aid] = pid;
    }
    await this.save();
  }

  async onConfirm(me) {
    const g = this.g;
    if (g.phase !== "guess") this.fail("现在不是猜的环节");
    if (me.id !== g.guesserId) this.fail("只有猜的人能揭晓");
    if (g.answers.some((a) => !g.guesses[a.id])) this.fail("每条回答都要猜一个人");
    g.result = g.answers.map((a) => ({ aid: a.id, by: a.by, guess: g.guesses[a.id], ok: g.guesses[a.id] === a.by }));
    const hits = g.result.filter((r) => r.ok).length;
    me.score += hits;
    me.stats.guessed++;
    me.stats.hit += hits;
    me.stats.guessTotal += g.result.length;
    for (const r of g.result) { const au = this.byId(r.by); if (au) au.stats.answered++; }
    g.voters = g.players.map((p) => p.id);
    g.votes = {};
    g.phase = "vote";
    await this.save();
  }

  async onVote(me, msg) {
    const g = this.g;
    if (g.phase !== "vote") this.fail("现在不是投票环节");
    if (!g.voters.includes(me.id)) this.fail("投票开始后才进来的,这次不能投");
    g.votes[me.id] = !!msg.yes;
    this.maybeVoteDone();
    await this.save();
  }

  async onEndVote(me) {
    if (this.g.phase !== "vote") this.fail("现在不是投票环节");
    if (!this.isHost(me)) this.fail("只有房主能结束投票");
    this.finishVote();
    await this.save();
  }

  // 赞成票过半立刻公布;赞成票已不可能过半(或全员投完)就不公布
  maybeVoteDone() {
    const g = this.g;
    const n = g.voters.length;
    const yes = Object.values(g.votes).filter(Boolean).length;
    const no = Object.values(g.votes).length - yes;
    if (yes * 2 > n || (n - no) * 2 <= n) this.finishVote();
  }

  finishVote() {
    const g = this.g;
    const yes = Object.values(g.votes).filter(Boolean).length;
    const pub = yes * 2 > g.voters.length;
    if (pub) {
      for (const r of g.result) {
        const au = this.byId(r.by);
        if (!au) continue;
        if (r.ok) au.stats.caught++;
        else { au.stats.fooled++; au.score++; }
      }
    }
    const text = Object.fromEntries(g.answers.map((a) => [a.id, a.text]));
    g.history.unshift({
      round: g.round, asker: this.byId(g.askerId)?.nick ?? "?", guesser: this.byId(g.guesserId)?.nick ?? "?",
      question: g.question, published: pub, yes, total: g.voters.length,
      hits: g.result.filter((r) => r.ok).length,
      items: g.result.map((r) => pub
        ? { text: text[r.aid], by: this.byId(r.by)?.nick ?? "?", guess: this.byId(r.guess)?.nick ?? "?", ok: r.ok }
        : { text: text[r.aid] }),
    });
    if (g.history.length > MAX_HISTORY) g.history.length = MAX_HISTORY;
    g.published = pub;
    g.phase = "reveal";
  }

  async onNext(me) {
    const g = this.g;
    if (g.phase !== "reveal") this.fail("还没揭晓呢");
    if (!this.isHost(me)) this.fail("由房主开下一轮");
    if (g.players.length < 2) this.toLobby();
    else this.toSetup();
    await this.save();
  }

  // ---------- 广播:按人裁剪 ----------

  view(me) {
    const g = this.g;
    const isGuesser = me?.id === g.guesserId;
    const pub = g.phase === "reveal" && g.published;
    const showAnswers = ["guess", "vote", "reveal"].includes(g.phase);
    const res = g.result ? Object.fromEntries(g.result.map((r) => [r.aid, r])) : {};
    return {
      v: g.v,
      code: g.code,
      phase: g.phase,
      me: me?.id ?? null,
      hostId: g.players.find((p) => p.token === g.hostToken)?.id ?? null,
      players: g.players.map((p) => ({
        id: p.id, nick: p.nick, connected: p.connected, score: p.score, color: p.color, stats: p.stats,
      })),
      round: g.round,
      askerId: g.askerId,
      guesserId: g.guesserId,
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
          ...(pub ? { by: a.by, guess: res[a.id]?.guess, ok: res[a.id]?.ok } : {}),
        }))
        : [],
      // 猜的过程只有猜的人自己看得到,不然不公布时也会泄露
      guesses: g.phase === "guess" && isGuesser ? g.guesses : {},
      hits: g.result ? g.result.filter((r) => r.ok).length : null,
      voters: g.voters ?? [],
      voted: Object.keys(g.votes ?? {}),
      yes: Object.values(g.votes ?? {}).filter(Boolean).length,
      myVote: g.votes?.[me?.id] ?? null,
      published: g.published ?? null,
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
