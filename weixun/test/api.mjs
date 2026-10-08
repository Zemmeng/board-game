// 房间备忘录接口回归:BASE=https://weixun.wawazhiliao.com node test/api.mjs 可测线上
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://127.0.0.1:8792";
const room = String(1000 + Math.floor(Math.random() * 9000));
const tokA = crypto.randomUUID().replace(/-/g, ""), tokB = crypto.randomUUID().replace(/-/g, "");
const get = async (q = "", tok = "") => (await fetch(`${BASE}/api/room/${room}${q}`, { headers: { "x-token": tok } })).json();
const post = async (body, tok = "") => {
  const r = await fetch(`${BASE}/api/room/${room}`, { method: "POST", headers: { "content-type": "application/json", "x-token": tok }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};

let s = await get("?k=who:1");
assert.equal(s.host, null);
assert.equal(s.bankVer, 0);

assert.equal((await post({ op: "name", seat: 2, name: "小王" })).status, 200);
assert.equal((await post({ op: "claim", seat: 1 }, tokA)).status, 200);
assert.equal((await post({ op: "claim", seat: 3 }, tokB)).status, 409, "第二个人不能抢房主");
assert.equal((await get("", tokA)).host.mine, true);
assert.equal((await get("", tokB)).host.mine, false);
console.log("✓ 认领房主 / 不能被抢");

assert.equal((await post({ op: "bank", bank: { who: "# 测试\n甲\n乙" } }, tokB)).status, 403, "非房主不能改词库");
assert.equal((await post({ op: "bank", bank: { who: "# 测试\n甲\n乙", spy: "猫/狗" } }, tokA)).status, 200);
const b = await (await fetch(`${BASE}/api/room/${room}/bank`)).json();
assert.equal(b.bankVer, 1);
assert.equal(b.bank.spy, "猫/狗");
console.log("✓ 房主同步词库");

assert.equal((await post({ op: "fix", k: "who:1", seat: 3 }, tokB)).status, 403);
await post({ op: "fix", k: "who:1", seat: 3 }, tokA);
await post({ op: "fix", k: "who:1", seat: 4, word: "奥特曼" }, tokA);
s = await get("?k=who:1");
assert.deepEqual(s.r.fix, { 3: { n: 1 }, 4: { n: 0, word: "奥特曼" } });
console.log("✓ 房主换词 / 改词");

await post({ op: "st", k: "who:1", seat: 2, wrong: 1 });
await post({ op: "st", k: "who:1", seat: 2, out: true });
s = await get("?k=who:1");
assert.deepEqual(s.r.st[2], { wrong: 1, out: true });
assert.deepEqual((await get("?k=who:2")).r.st, {}, "新一轮应是空的");
console.log("✓ 出局 / 猜错同步,轮与轮隔离");

const t0 = Date.now();
s = (await post({ op: "timer", k: "taboo:1", dur: 600 })).data;
assert.ok(Math.abs(s.r.timer.end - (s.now + 600000)) < 2000);
assert.ok(Math.abs(s.now - t0) < 60000);
s = (await post({ op: "timer", k: "taboo:1", dur: 0 })).data;
assert.equal(s.r.timer, null);
console.log("✓ 共享倒计时");

assert.equal((await fetch(`${BASE}/api/room/12a4`)).status, 404);
assert.equal((await post({ op: "st", k: "bad:1", seat: 1 })).status, 400);
assert.equal((await post({ op: "unhost" }, tokA)).status, 200);
assert.equal((await get()).host, null);
console.log("✓ 参数校验 / 让出房主\n全部通过");
