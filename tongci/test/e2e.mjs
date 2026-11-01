// 两人整局 + 第三人被拒 + 刷新恢复,并断言揭晓前对方的词从没下发过
// 先起 wrangler dev(端口 8793);BASE=https://tongci.wawazhiliao.com 可测线上
const BASE = process.env.BASE || "http://127.0.0.1:8793";
const wsBase = BASE.replace(/^http/, "ws");
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const { code } = await (await fetch(BASE + "/api/create", { method: "POST" })).json();
check("创建房间,4 位房间号", /^\d{4}$/.test(code), code);
const page = await fetch(`${BASE}/r/${code}`);
check("/r/房间号 能打开页面", page.ok && (await page.text()).includes("同词相遇"));

function client(token, nick) {
  const ws = new WebSocket(`${wsBase}/ws?room=${code}`);
  const c = { ws, token, g: null, raw: [], msgs: [], waiters: [] };
  ws.onmessage = (e) => {
    c.raw.push(String(e.data));
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    if (m.t === "state") c.g = m;
    c.waiters = c.waiters.filter((w) => !w());
  };
  c.closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.until = (f, label = "") => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${nick} 等待超时: ${label}`)), 5000);
    const w = () => { try { if (f(c)) { clearTimeout(t); res(); return true; } } catch {} return false; };
    if (!w()) c.waiters.push(w);
  });
  return new Promise((r) => (ws.onopen = () => { c.send({ t: "join", token, nick }); r(c); }));
}
const st = (c, f) => (x) => x.g && f(x.g);
const sawWord = (c, w) => c.raw.some((s) => s.includes(w));

const tA = crypto.randomUUID(), tB = crypto.randomUUID();
const A = await client(tA, "甲");
await A.until(st(A, (g) => g.phase === "wait"), "甲进房");
check("第一个人进房,等待对方", A.g.phase === "wait");

// 没带昵称的新人会被要求填昵称
const N = await client(crypto.randomUUID(), "");
await N.until((c) => c.msgs.some((m) => m.t === "need-nick"), "need-nick");
check("没昵称时要求填昵称,并告诉是谁在等", N.msgs.find((m) => m.t === "need-nick").other === "甲");
N.ws.close();

let B = await client(tB, "乙");
await A.until(st(A, (g) => g.phase === "play" && g.players.length === 2), "开局");
check("第二个人加入后开局", B.g?.phase === "play" || (await B.until(st(B, (g) => g.phase === "play")), true));
check("对方在线状态", A.g.players.every((p) => p.online));

const C = await client(crypto.randomUUID(), "丙");
const cCode = await C.closed;
check("第三人被拒:房间已满", C.msgs.some((m) => m.t === "full") && !C.msgs.some((m) => m.t === "state"), `close=${cCode}`);

// 第 1 轮:甲交、撤回、改词;乙始终看不到甲的词
A.send({ t: "submit", word: "苹果" });
await B.until(st(B, (g) => g.players.find((p) => p.nick === "甲").ready), "乙看到甲已写好");
check("对方「已写好」实时显示", true);
check("揭晓前对方的词没下发(看 Network 也看不到)", !sawWord(B, "苹果"));
await A.until(st(A, (g) => g.mine === "苹果"), "甲看到自己的词");
check("自己能看到自己交的词", A.g.mine === "苹果");
A.send({ t: "withdraw" });
await B.until(st(B, (g) => !g.players.find((p) => p.nick === "甲").ready), "撤回");
check("撤回后对方看到「未写好」", true);
A.send({ t: "submit", word: "香蕉" });
await B.until(st(B, (g) => g.players.find((p) => p.nick === "甲").ready));
check("撤回改词后,撤掉的和新交的都没泄露给对方", !sawWord(B, "苹果") && !sawWord(B, "香蕉"));
B.send({ t: "submit", word: "猴子" });
await A.until(st(A, (g) => g.round === 2), "第 1 轮揭晓");
check("两人都交后同时揭晓,进入第 2 轮", A.g.history[0].words[A.g.me] === "香蕉" && B.g.history?.[0]?.words[B.g.me] === "猴子" || (await B.until(st(B, (g) => g.round === 2)), B.g.history[0].words[B.g.me] === "猴子"));
check("揭晓结果两人一致", JSON.stringify(A.g.history) === JSON.stringify(B.g.history));

// 第 2 轮:用过的词被拒;标点空格大小写不同也算同一个词
A.send({ t: "submit", word: "香 蕉!" });
await A.until((c) => c.msgs.at(-1).t === "err", "重复词被拒");
check("这局出现过的词不能再用", /出现过/.test(A.msgs.at(-1).msg));
A.send({ t: "submit", word: "Yellow" });
B.send({ t: "submit", word: " yellow!! " });
await A.until(st(A, (g) => g.phase === "won"), "相遇");
check("忽略空格/标点/大小写判定相同,第 2 轮相遇", A.g.phase === "won" && A.g.round === 2 && A.g.history.at(-1).hit);
check("战绩:已相遇 1 次、最快 2 轮", A.g.played === 1 && A.g.best === 2);

// 刷新恢复:乙断线 → 甲看到离线 → 乙拿同一个 token、不带昵称重连 → 回到原局
B.ws.close();
await A.until(st(A, (g) => !g.players.find((p) => p.nick === "乙").online), "乙离线");
check("对方离线状态实时显示", true);
B = await client(tB, "");
await B.until(st(B, (g) => g.phase === "won"), "乙恢复");
check("刷新后凭 playerId 回到原房间、恢复当前局", B.g.history.length === 2 && B.g.round === 2);
await A.until(st(A, (g) => g.players.every((p) => p.online)));
check("重连后对方看到在线", true);

// 再来一局
B.send({ t: "again" });
await A.until(st(A, (g) => g.phase === "play" && g.round === 1 && g.history.length === 0), "再来一局");
check("再来一局:回到第 1 轮,记录清空,战绩保留", A.g.played === 1);

// 中途刷新也能恢复已交的词
A.send({ t: "submit", word: "月亮" });
await A.until(st(A, (g) => g.mine === "月亮"));
A.ws.close();
const A2 = await client(tA, "");
await A2.until(st(A2, (g) => g.phase === "play"));
check("提交后刷新,自己交的词还在", A2.g.mine === "月亮");
check("对方始终没收到「月亮」", !sawWord(B, "月亮"));

// 不存在的房间
const ghost = new WebSocket(`${wsBase}/ws?room=0001`);
const gm = await new Promise((r) => {
  ghost.onopen = () => ghost.send(JSON.stringify({ t: "join", token: "x", nick: "x" }));
  ghost.onmessage = (e) => r(JSON.parse(e.data));
});
check("不存在的房间提示过期", gm.t === "gone");
ghost.close();

for (const c of [A2, B]) c.ws.close();
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
