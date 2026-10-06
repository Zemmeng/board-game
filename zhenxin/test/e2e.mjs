// 三人整轮:建房 → 加入 → 提问 → 匿名作答 → 猜 → 揭晓,并断言揭晓前不泄露作者
const BASE = process.env.BASE || "http://127.0.0.1:8790";
const wsBase = BASE.replace(/^http/, "ws");
const host = crypto.randomUUID();
const { code } = await (await fetch(BASE + "/api/create", { method: "POST", body: JSON.stringify({ hostToken: host }) })).json();
function client(token, nick) {
  const ws = new WebSocket(`${wsBase}/ws?room=${code}`);
  const c = { ws, g: null, waiters: [] };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "err") console.log(nick, "ERR", m.msg); if (m.t === "state") { c.g = m.g; c.waiters = c.waiters.filter((w) => !w()); } };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (f) => new Promise((r) => { if (c.g && f(c.g)) return r(); c.waiters.push(() => (c.g && f(c.g) ? (r(), true) : false)); });
  return new Promise((r) => (ws.onopen = () => { c.send({ t: "join", token, nick }); r(c); }));
}
const A = await client(host, "甲"), B = await client(crypto.randomUUID(), "乙"), C = await client(crypto.randomUUID(), "丙");
await A.until((g) => g.players.length === 3);
A.send({ t: "start" });
await A.until((g) => g.phase === "ask");
const all = [A, B, C], asker = all.find((x) => x.g.me === x.g.askerId), others = all.filter((x) => x !== asker);
asker.send({ t: "ask", text: "测试问题?" });
await asker.until((g) => g.phase === "answer");
others.forEach((o, i) => o.send({ t: "answer", text: "回答" + i }));
await asker.until((g) => g.phase === "guess");
const leak = JSON.stringify(asker.g).includes('"by"');
console.log("guess 阶段作者泄露:", leak);
for (const a of asker.g.answers) asker.send({ t: "guess", aid: a.id, pid: asker.g.answerers[asker.g.answers.indexOf(a)] });
await asker.until((g) => Object.keys(g.guesses).length === g.answers.length);
asker.send({ t: "confirm" });
await asker.until((g) => g.phase === "reveal");
console.log("揭晓:", asker.g.history[0].items.map((i) => `${i.text}=${i.by} 猜${i.guess} ${i.ok}`).join(" | "));
console.log("分数:", asker.g.players.map((p) => p.nick + p.score).join(" "));
asker.send({ t: "next" });
await asker.until((g) => g.phase === "ask" && g.round === 2);
console.log("第二轮提问者:", asker.g.players.find((p) => p.id === asker.g.askerId).nick, leak ? "FAIL" : "OK");
process.exit(leak ? 1 : 0);
