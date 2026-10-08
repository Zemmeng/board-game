// 发词一致性 & 不重复回归:模拟多部手机各自计算,断言结果一致
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as D from "../public/js/deal.js";
const require = createRequire(import.meta.url);
globalThis.window = {};
for (const f of ["who", "charades", "taboo", "spy"]) require(`../public/data/${f}.js`);
const W = globalThis.window;

const who = Object.entries(W.WORDS_WHO).flatMap(([c, ws]) => ws.map((w) => ({ w, c })));
const taboo = W.WORDS_TABOO.map((w) => ({ w, c: "" }));
const spy = W.WORDS_SPY;

// 词库规模
const ch = Object.values(W.WORDS_CHARADES).flat();
for (const [name, n, uniq] of [["我是谁", who.length, new Set(who.map((x) => x.w)).size], ["禁忌", taboo.length, new Set(W.WORDS_TABOO).size],
  ["比划", ch.length, new Set(ch).size], ["卧底", spy.length, new Set(spy.map((p) => p.join("|"))).size]]) {
  assert.ok(n >= 150, `${name} 词库不足 150:${n}`);
  assert.equal(n, uniq, `${name} 词库有重复`);
  console.log(`✓ ${name} 词库 ${n} 条,无重复`);
}

// 文本往返:编辑器里的文本格式解析回来要和内置一致(决定了发词结果一致)
const whoRT = Object.entries(D.parseGroups(D.groupsToText(W.WORDS_WHO))).flatMap(([c, ws]) => ws.map((w) => ({ w, c })));
assert.deepEqual(whoRT, who);
assert.deepEqual(D.parsePairs(D.pairsToText(spy)), spy);
assert.deepEqual(D.parseList(D.listToText(W.WORDS_TABOO)), W.WORDS_TABOO);
console.log("✓ 词库文本往返一致");

// 两部「手机」各自计算(用 JSON 深拷贝模拟独立数据),结果必须一致
const phone = (items) => JSON.parse(JSON.stringify(items));
for (const room of ["1234", "0420", "9999"]) {
  for (let round = 1; round <= 40; round++) {
    for (const n of [5, 3, 8]) {
      const a = D.dealEach("who", phone(who), room, round, n), b = D.dealEach("who", phone(who), room, round, n);
      assert.deepEqual(a, b);
      assert.equal(new Set(a.map((x) => x.w)).size, n, "同一轮出现重复词");
      const t1 = D.dealEach("taboo", phone(taboo), room, round, n), t2 = D.dealEach("taboo", phone(taboo), room, round, n);
      assert.deepEqual(t1, t2);
      const s1 = D.dealSpy(phone(spy), room, round, n), s2 = D.dealSpy(phone(spy), room, round, n);
      assert.deepEqual(s1, s2);
      assert.equal(s1.spies.length, D.spyCountFor(n));
      assert.equal(s1.seats.filter((x) => x.spy).length, D.spyCountFor(n));
      assert.notEqual(s1.civ, s1.spy);
    }
  }
}
console.log("✓ 3 个房间 × 40 轮 × 3 种人数:各手机发词完全一致");

// 同一房间前 N 轮不重复(5 人局:我是谁 179/5=35 轮,禁忌 156/5=31 轮)
for (const [tag, items] of [["who", who], ["taboo", taboo]]) {
  const R = Math.floor(items.length / 5);
  const seen = new Set();
  for (let r = 1; r <= R; r++) for (const x of D.dealEach(tag, items, "1234", r, 5)) {
    assert.ok(!seen.has(x.w), `${tag} 第 ${r} 轮重复出现 ${x.w}`);
    seen.add(x.w);
  }
  console.log(`✓ ${tag}:5 人局连续 ${R} 轮不重复`);
}
const spySeen = new Set();
for (let r = 1; r <= spy.length; r++) { const d = D.dealSpy(spy, "1234", r, 5); const k = [d.civ, d.spy].sort().join("|"); assert.ok(!spySeen.has(k)); spySeen.add(k); }
console.log(`✓ 卧底:连续 ${spy.length} 轮不重复`);

// 不同房间 / 不同轮数发的词不一样
assert.notDeepEqual(D.dealEach("who", who, "1234", 1, 5), D.dealEach("who", who, "1235", 1, 5));
assert.notDeepEqual(D.dealEach("who", who, "1234", 1, 5), D.dealEach("who", who, "1234", 2, 5));

// 房主换词 / 改词
const base = D.dealEach("who", who, "1234", 3, 5);
const re = D.dealEach("who", who, "1234", 3, 5, { 2: { n: 1 } });
assert.notEqual(re[1].w, base[1].w);
assert.deepEqual([re[0], ...re.slice(2)], [base[0], ...base.slice(2)]);
assert.ok(!base.some((x, i) => i !== 1 && x.w === re[1].w), "换来的词和别人撞了");
const fx = D.dealEach("who", who, "1234", 3, 5, { "4": { n: 0, word: "自定义词" } });
assert.equal(fx[3].w, "自定义词");
const sp = D.dealSpy(spy, "1234", 3, 5, { "0": { word: "猫|狗" } });
assert.deepEqual([sp.civ, sp.spy].sort(), ["狗", "猫"]);
console.log("✓ 房主换词 / 指定词");

// 卧底胜负
const sd = D.dealSpy(spy, "1234", 1, 5);
const civs = [1, 2, 3, 4, 5].filter((s) => !sd.spies.includes(s));
assert.equal(D.spyResult(sd, []), null);
assert.equal(D.spyResult(sd, sd.spies), "civ");
assert.equal(D.spyResult(sd, civs.slice(0, 3)), "spy"); // 剩 1 平民 1 卧底
assert.equal(D.spyResult(sd, civs.slice(0, 2)), null);  // 剩 2 平民 1 卧底
console.log("✓ 卧底胜负判定");

// 自定义文本解析
assert.deepEqual(D.parsePairs("牛奶 / 豆浆\n可乐|雪碧\n 猫，狗 \n坏行\n同/同"), [["牛奶", "豆浆"], ["可乐", "雪碧"], ["猫", "狗"]]);
assert.deepEqual(D.parseGroups("# 动物\n猫、狗\n\n# 食物\n火锅\n猫"), { 动物: ["猫", "狗"], 食物: ["火锅"] });
console.log("✓ 自定义词库解析\n全部通过");
