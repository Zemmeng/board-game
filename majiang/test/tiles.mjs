// 牌理回归。核心手段:再写一个**又慢又笨但显然正确**的胡牌判定,
// 拿它跟正式那个递归版对拍几万手随机牌。牌理错了一处,整个游戏都是错的。
import {
  TILE_KINDS, COPIES, fullWall, toCounts, countsToTiles, tileName, suitOf,
  canWin, isStandardWin, isSevenPairs, tingTiles, isTing, fanOf, multiplierOf,
} from "../public/js/shared/tiles.js";

let fail = 0;
const bad = (m) => { console.error("❌ " + m); fail++; };
const ok_ = (cond, m) => { if (!cond) bad(m); };

// "123m 99s 456p" -> counts。m=万 s=条 p=筒
function H(str) {
  const c = new Array(TILE_KINDS).fill(0);
  for (const grp of str.trim().split(/\s+/)) {
    const suit = { m: 0, s: 1, p: 2 }[grp.at(-1)];
    if (suit === undefined) throw new Error("花色写错了: " + grp);
    for (const ch of grp.slice(0, -1)) c[suit * 9 + (+ch - 1)]++;
  }
  return c;
}
const show = (c) => countsToTiles(c).map(tileName).join(" ");

// ---------- 1. 笨办法:穷举所有拆法 ----------
function bruteStandard(counts, need) {
  if (need === 0) return counts.every((x) => x === 0);
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] >= 3) {                       // 刻子
      counts[t] -= 3;
      const r = bruteStandard(counts, need - 1);
      counts[t] += 3;
      if (r) return true;
    }
    const rank = (t % 9) + 1;
    if (rank <= 7 && counts[t] && counts[t + 1] && counts[t + 2]) {   // 顺子
      counts[t]--; counts[t + 1]--; counts[t + 2]--;
      const r = bruteStandard(counts, need - 1);
      counts[t]++; counts[t + 1]++; counts[t + 2]++;
      if (r) return true;
    }
  }
  return false;
}
function bruteWin(counts, melded) {
  for (let t = 0; t < TILE_KINDS; t++) {
    if (counts[t] < 2) continue;
    counts[t] -= 2;
    const r = bruteStandard(counts, 4 - melded);
    counts[t] += 2;
    if (r) return true;
  }
  return false;
}

// ---------- 2. 已知牌型 ----------
ok_(canWin(H("123456789m 123s 99p")), "标准胡没认出来");
ok_(canWin(H("111222333444m 99m")), "全刻子没认出来");
ok_(isSevenPairs(H("1188m 2299s 3377p 55p")), "七对没认出来");
ok_(canWin(H("1188m 2299s 3377p 55p")), "七对不算胡");
ok_(!canWin(H("123456789m 123s 89p")), "缺一张将却判成胡");
ok_(!canWin(H("123456789m 1234s 99p")), "多了一张还判胡");
// 顺子不许跨门:这手只有把 8万9万1条 当顺子才凑得齐,所以必须判不胡
ok_(!canWin(H("111222333m 44m 89m 1s")), "跨门顺子(8万9万1条)被当成了合法牌型");
// 对对胡的将不在最小那张上(改 bug 前会误判)
{
  const c = H("222333444555s 66s");
  ok_(canWin(c), "222333444555s66s 应该能胡");
  const r = fanOf(c, []);
  ok_(r.names.some((n) => n.includes("清对") || n.includes("对对胡")),
      "222333444555s66s 应判对对胡类,实际:" + r.names.join("+"));
}

// ---------- 3. 定缺:手里有缺门牌绝对不能胡 ----------
{
  const c = H("123456789m 123s 99p");
  ok_(canWin(c, [], -1), "不定缺时该能胡");
  ok_(!canWin(c, [], 1), "手里有条,定缺条却还能胡");
  ok_(!canWin(c, [], 2), "手里有筒,定缺筒却还能胡");
  ok_(canWin(c, [], 0) === false, "手里有万,定缺万却还能胡");
}

// ---------- 4. 听牌 ----------
{
  const c = H("123456789m 123s 9p");     // 单吊 9p
  const t = tingTiles(c, []);
  ok_(t.length === 1 && tileName(t[0]) === "9筒", "单吊听错了:" + t.map(tileName));
}
{
  const c = H("123456789m 123s 9p");
  ok_(!isTing(c, [], 2), "定缺筒时不该还听 9 筒");
}

// ---------- 5. 对拍:随机手牌,快慢两版结论必须一致 ----------
{
  let rs = 123456789;
  const rnd = () => (rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let checked = 0, wins = 0;
  for (let iter = 0; iter < 40000; iter++) {
    const melded = iter % 5 === 0 ? 1 : 0;                 // 偶尔带一个碰
    const handSize = 13 - melded * 3 + 1;                  // 摸牌后的张数
    const wall = fullWall();
    for (let i = wall.length - 1; i > 0; i--) {            // 洗
      const j = (rnd() * (i + 1)) | 0;
      [wall[i], wall[j]] = [wall[j], wall[i]];
    }
    const c = toCounts(wall.slice(0, handSize));

    const fast = melded === 0 ? (isSevenPairs(c) || isStandardWin(c, 0)) : isStandardWin(c, melded);
    const slow = (melded === 0 && isSevenPairs(c)) || bruteWin(c.slice(), melded);
    if (fast !== slow) {
      bad(`对拍不一致(melds=${melded}) 快=${fast} 慢=${slow}  ${show(c)}`);
      if (fail > 4) break;
    }
    checked++; if (fast) wins++;
  }
  console.log(`   对拍 ${checked} 手随机牌,快慢两版结论一致;其中天然成胡 ${wins} 手`);

  // 随机十四张正好成胡的概率大约万分之几,拿「随机牌里必须出现胡牌」当断言太靠运气。
  // 真正该压的是:**照着规则拼出来的胡牌,一定要判得出来**。
  let built = 0;
  for (let iter = 0; iter < 5000; iter++) {
    const left = new Array(TILE_KINDS).fill(COPIES);
    const c = new Array(TILE_KINDS).fill(0);
    const take = (t, n) => { left[t] -= n; c[t] += n; };
    let okBuild = true;
    for (let k = 0; k < 4 && okBuild; k++) {          // four melds
      let placed = false;
      for (let tryN = 0; tryN < 60 && !placed; tryN++) {
        const t = (rnd() * TILE_KINDS) | 0;
        const rank = (t % 9) + 1;
        if (rnd() < 0.5) {
          if (left[t] >= 3) { take(t, 3); placed = true; }
        } else if (rank <= 7 && left[t] && left[t + 1] && left[t + 2]) {
          take(t, 1); take(t + 1, 1); take(t + 2, 1); placed = true;
        }
      }
      okBuild = placed;
    }
    if (!okBuild) continue;
    let paired = false;                                // plus a pair
    for (let tryN = 0; tryN < 60 && !paired; tryN++) {
      const t = (rnd() * TILE_KINDS) | 0;
      if (left[t] >= 2) { take(t, 2); paired = true; }
    }
    if (!paired) continue;
    built++;
    if (!canWin(c)) bad("拼出来的胡牌却判不胡: " + show(c));
  }
  console.log(`   另外拼了 ${built} 手必胡的牌,全部判定成功`);
  ok_(built > 4000, `构造的胡牌太少(${built}),测试没压到量`);
}

// ---------- 6. 番种 ----------
const fanOfH = (s, melds = [], opt = {}) => fanOf(H(s), melds, opt);
{
  const r = fanOfH("123456789m 123s 99p");
  ok_(r.fan === 0, "平胡该 0 番,实际 " + r.fan + " " + r.names);
}
{
  const r = fanOfH("111222333444m 99m");   // 全刻子同门 = 清对。注意这手每种只有 3 张,没有根
  ok_(r.names.includes("清对"), "清对没认出来:" + r.names);
  ok_(!r.names.some((n) => n.includes("根")), "每种只有三张,不该算根:" + r.names);
}
{
  // 根要「四张相同」。手上 11 张 + 一个暗杠,杠的那张凑满四张,算 1 根
  const r = fanOf(H("222333444m 99m"), [{ kind: "an", tile: 0 }]);
  ok_(r.names.some((n) => n.includes("根")), "带杠却没算根:" + r.names);
}
{
  // 碰碰胡:四副全碰出去、手上单吊。亮出去之后手里剩的是将牌那一对(2 张),不是 1 张
  const melds = [{ kind: "peng", tile: 0 }, { kind: "peng", tile: 10 },
                 { kind: "peng", tile: 11 }, { kind: "peng", tile: 20 }];
  const r = fanOf(H("99m"), melds);
  ok_(r.names.includes("碰碰胡"), "碰碰胡(全碰单吊)没认出来:" + r.names);
  ok_(r.names.includes("大对"), "碰碰胡同时也该是大对:" + r.names);
  ok_(multiplierOf(r.fan) === 4, "大对×2 叠碰碰胡×2 该是 ×4,实际 ×" + multiplierOf(r.fan));
  // 只碰了三副、手上还捏着一副的,不算碰碰胡
  const r2 = fanOf(H("777m 99m"), melds.slice(0, 3));
  ok_(!r2.names.includes("碰碰胡"), "没全碰出去却算了碰碰胡:" + r2.names);
}
{
  const r = fanOfH("1188m 2299s 3377p 55p");
  ok_(r.names.includes("七对"), "七对没认出来:" + r.names);
}
{
  const r = fanOfH("1111 2222 3333 44m".replace(/ /g, "") + "m");  // 龙七对(四个四张)
  ok_(r.names.some((n) => n.includes("七对")), "龙七对没认出来:" + r.names);
}
{
  const a = fanOfH("123456789m 123s 99p", [], {});
  const b = fanOfH("123456789m 123s 99p", [], { zimo: true });
  ok_(b.fan === a.fan + 1, "自摸没加番");
}
ok_(multiplierOf(0) === 1 && multiplierOf(3) === 8 && multiplierOf(9, 5) === 32, "倍数或封顶算错");

if (fail) { console.error(`\n❌ ${fail} 项不通过`); process.exit(1); }
console.log("✅ 牌理全部通过");
