// 确定性发词:同一个「房间码 + 轮数 + 人数 + 词库」在任何手机上算出的结果都一样
// 不依赖后端;前端和 test/ 里的 node 脚本共用这一份

// cyrb53 的 32 位版本,字符串 → 无符号整数
export function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// mulberry32
export function rng(seed) {
  let a = hashStr(String(seed));
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, seed) {
  const a = list.slice();
  const r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 校验码:把发词结果压成 3 个字符,大家对一眼就知道是否同步
const CK = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function checksum(obj) {
  let h = hashStr(JSON.stringify(obj));
  let s = "";
  for (let i = 0; i < 3; i++) { s += CK[h % CK.length]; h = Math.floor(h / CK.length); }
  return s;
}

// ---------- 词库文本 <-> 数据 ----------
// 文本格式(编辑器里用):一行一个词;「# 类别」开头的行是分组标题;
// 也接受用逗号、顿号隔开写在一行里

const SPLIT = /[,，、;；\n]+/;

export function parseList(text) {
  const out = [], seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;
    for (const w0 of t.split(SPLIT)) {
      const w = w0.trim().slice(0, 30);
      if (w && !seen.has(w)) { seen.add(w); out.push(w); }
    }
  }
  return out;
}

// 分组的词库(我是谁 / 比划):返回 { 组名: [词...] }
export function parseGroups(text, defaultGroup = "自定义") {
  const groups = {}, seen = new Set();
  let cur = defaultGroup;
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    if (t.startsWith("#")) { cur = t.replace(/^#+/, "").trim() || defaultGroup; continue; }
    for (const w0 of t.split(SPLIT)) {
      const w = w0.trim().slice(0, 30);
      if (w && !seen.has(w)) { seen.add(w); (groups[cur] ||= []).push(w); }
    }
  }
  return groups;
}

// 卧底词对:一行一对,用 / | 空格 逗号 隔开
export function parsePairs(text) {
  const out = [], seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;
    const parts = t.split(/\s*[\/|｜,，、\s]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2 || parts[0] === parts[1]) continue;
    const a = parts[0].slice(0, 30), b = parts[1].slice(0, 30);
    const k = [a, b].sort().join("|");
    if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
  }
  return out;
}

export const groupsToText = (g) => Object.entries(g).map(([k, ws]) => `# ${k}\n${ws.join("\n")}`).join("\n\n");
export const listToText = (l) => l.join("\n");
export const pairsToText = (p) => p.map(([a, b]) => `${a} / ${b}`).join("\n");

// ---------- 发词 ----------

// 「我是谁」「禁忌动作」:每人一个词,自己看不到
// items: [{ w, c }],c 是类别(可空)
// 同一房间内不重复:用房间码洗一副「整副词库」,第 r 轮取第 r 段;用完一整副再换一副洗法
// fixes: { 座位号: { n: 换了几次, word?: 房主指定的词 } }
export function dealEach(tag, items, room, round, n, fixes = {}) {
  if (items.length < n) throw new Error(`词库只有 ${items.length} 个词,不够 ${n} 个人分`);
  const R = Math.floor(items.length / n);
  const cycle = Math.floor((round - 1) / R), k = (round - 1) % R;
  const perm = shuffle(items, `${tag}|${room}|c${cycle}`);
  const out = perm.slice(k * n, k * n + n);
  for (let s = 1; s <= n; s++) {
    const f = fixes[s];
    if (!f) continue;
    if (f.word) { out[s - 1] = { w: f.word, c: "房主指定" }; continue; }
    if (f.n > 0) {
      const used = new Set(out.map((x) => x.w));
      const alt = shuffle(items, `${tag}|${room}|r${round}|s${s}|n${f.n}`).find((x) => !used.has(x.w));
      if (alt) out[s - 1] = alt;
    }
  }
  return out;
}

export const spyCountFor = (n) => (n >= 7 ? 2 : 1);

// 「谁是卧底」:大部分人平民词,1~2 人卧底词;每人只看到自己的
// fixes[0] 是整轮级别的:{ n: 换了几组 } 或 { word: "平民词|卧底词" }
export function dealSpy(pairs, room, round, n, fixes = {}) {
  if (!pairs.length) throw new Error("卧底词库是空的");
  const cycle = Math.floor((round - 1) / pairs.length), k = (round - 1) % pairs.length;
  let pair = shuffle(pairs, `spy|${room}|c${cycle}`)[k];
  const f = fixes[0];
  if (f && f.word && f.word.includes("|")) pair = f.word.split("|").slice(0, 2);
  else if (f && f.n > 0) pair = shuffle(pairs, `spy|${room}|r${round}|n${f.n}`).find((p) => p !== pair) || pair;
  const salt = f ? JSON.stringify(f) : "";
  const r = rng(`spy|${room}|r${round}|roles|${salt}`);
  const flip = r() < 0.5;
  const civ = flip ? pair[1] : pair[0], spy = flip ? pair[0] : pair[1];
  const spyCount = spyCountFor(n);
  const order = shuffle([...Array(n).keys()], `spy|${room}|r${round}|seats|${salt}`);
  const spies = new Set(order.slice(0, spyCount).map((i) => i + 1));
  const seats = [];
  for (let s = 1; s <= n; s++) seats.push({ w: spies.has(s) ? spy : civ, spy: spies.has(s) });
  const start = 1 + Math.floor(r() * n);
  return { civ, spy, seats, spies: [...spies].sort((a, b) => a - b), start };
}

// 胜负判定:卧底全出局 → 平民胜;存活平民 ≤ 存活卧底 → 卧底胜
export function spyResult(deal, outSeats) {
  const out = new Set(outSeats);
  let civ = 0, spy = 0;
  deal.seats.forEach((x, i) => { if (!out.has(i + 1)) x.spy ? spy++ : civ++; });
  if (spy === 0) return "civ";
  if (civ <= spy) return "spy";
  return null;
}
