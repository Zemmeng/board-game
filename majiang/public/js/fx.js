// 动效层。
//
// 遵循余一立的规矩:**所有特效都由「新旧 state 对比」驱动,不去解析服务端日志文本**。
// 日志是给人看的字符串,措辞一改特效就全哑了,太脆。
// 这里只认视图里的字段变化:discards 变长、melds 变多、won 翻转、score 变化……

import { tileSvg } from "./tileface.js?v=2";

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const layer = () => {
  let el = document.getElementById("fx-layer");
  if (!el) {
    el = document.createElement("div");
    el.id = "fx-layer";
    document.body.appendChild(el);
  }
  return el;
};

const rectOf = (el) => el?.getBoundingClientRect();

/** 座位在屏幕上的锚点:0 自己(下) 1 右 2 上 3 左 —— 传的是相对座位 */
export function seatAnchor(rel) {
  if (rel === 0) return document.getElementById("my-hand");
  return document.getElementById("opp-" + rel);
}

/** 一张牌从 A 飞到 B,落地时轻微弹一下 */
export function flyTile(tile, fromEl, toEl, { spin = true, ms = 380 } = {}) {
  if (reduce || !fromEl || !toEl) return;
  const a = rectOf(fromEl), b = rectOf(toEl);
  if (!a || !b) return;
  const node = document.createElement("div");
  node.className = "fx-fly";
  node.innerHTML = tileSvg(tile, { w: 40 });
  layer().appendChild(node);

  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
  const x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  node.animate([
    { transform: `translate(${x0}px,${y0}px) translate(-50%,-50%) scale(1.25) rotate(0deg)`, opacity: 1 },
    { transform: `translate(${x1}px,${y1}px) translate(-50%,-50%) scale(1) rotate(${spin ? 360 : 0}deg)`, opacity: 1 },
  ], { duration: ms, easing: "cubic-bezier(.24,.9,.3,1)" }).onfinish = () => node.remove();
  setTimeout(() => node.remove(), ms + 60);
}

/** 屏幕中央砸一行大字(碰 / 杠 / 胡 / 定缺…) */
export function shout(text, { color = "#ffd95e", ms = 1000, sub = "" } = {}) {
  const node = document.createElement("div");
  node.className = "fx-shout";
  node.innerHTML = `<b style="color:${color}">${text}</b>${sub ? `<i>${sub}</i>` : ""}`;
  layer().appendChild(node);
  if (reduce) { setTimeout(() => node.remove(), ms); return; }
  node.animate([
    { transform: "translate(-50%,-50%) scale(.4) rotate(-8deg)", opacity: 0 },
    { transform: "translate(-50%,-50%) scale(1.12) rotate(2deg)", opacity: 1, offset: 0.28 },
    { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.72 },
    { transform: "translate(-50%,-58%) scale(.94)", opacity: 0 },
  ], { duration: ms, easing: "cubic-bezier(.2,1.4,.4,1)" }).onfinish = () => node.remove();
  setTimeout(() => node.remove(), ms + 80);
}

/** 分数变化飘字 */
export function floatScore(el, delta) {
  if (!el || !delta) return;
  const r = rectOf(el);
  if (!r) return;
  const node = document.createElement("div");
  node.className = "fx-score " + (delta > 0 ? "up" : "down");
  node.textContent = (delta > 0 ? "+" : "") + delta;
  node.style.left = r.left + r.width / 2 + "px";
  node.style.top = r.top + "px";
  layer().appendChild(node);
  if (reduce) { setTimeout(() => node.remove(), 900); return; }
  node.animate([
    { transform: "translate(-50%,0) scale(.7)", opacity: 0 },
    { transform: "translate(-50%,-14px) scale(1.15)", opacity: 1, offset: 0.3 },
    { transform: "translate(-50%,-44px) scale(1)", opacity: 0 },
  ], { duration: 1100, easing: "ease-out" }).onfinish = () => node.remove();
  setTimeout(() => node.remove(), 1200);
}

/** 给某个元素加一次性动画类 */
export function pulse(el, cls, ms = 700) {
  if (!el || reduce) return;
  el.classList.remove(cls);
  void el.offsetWidth;              // 强制重排,动画才能重放
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/** 手机震一下(轮到我 / 胡牌) */
export function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* 不支持就算了 */ }
}

/**
 * 对比新旧视图,算出这一帧该放哪些特效。
 * 返回的是描述,不直接播 —— 播放交给 app.js,方便它同时配音效。
 */
export function diff(prev, cur, mySeat) {
  const out = [];
  if (!prev || !cur) return out;
  if (prev.phase !== cur.phase) out.push({ t: "phase", from: prev.phase, to: cur.phase });

  for (let i = 0; i < cur.seats.length; i++) {
    const a = prev.seats[i], b = cur.seats[i];
    if (!a || !b) continue;

    // 打出去的牌变多 → 有人出牌
    if (b.discards.length > a.discards.length) {
      out.push({ t: "discard", seat: i, tile: b.discards[b.discards.length - 1] });
    }
    // 副露变多 → 碰或杠(杠是 4 张,碰是 3 张)
    if (b.melds.length > a.melds.length) {
      const m = b.melds[b.melds.length - 1];
      out.push({ t: "meld", seat: i, kind: m.kind, tile: m.tile });
    } else if (b.melds.length === a.melds.length) {
      // 补杠:副露数不变,但某一副从 peng 变成了 bu
      for (let k = 0; k < b.melds.length; k++) {
        if (a.melds[k] && a.melds[k].kind === "peng" && b.melds[k].kind === "bu") {
          out.push({ t: "meld", seat: i, kind: "bu", tile: b.melds[k].tile });
        }
      }
    }
    if (!a.won && b.won) out.push({ t: "win", seat: i, fan: b.winFan });
    if (a.score !== b.score) out.push({ t: "score", seat: i, delta: b.score - a.score });
    if (a.lack < 0 && b.lack >= 0 && i === mySeat) out.push({ t: "lack", seat: i, suit: b.lack });
  }

  // 轮到我(排除「我已经胡了」和「正在等别人表态」)
  const mineNow = cur.phase === "play" && !cur.pending && cur.turn === mySeat && !cur.seats[mySeat]?.won;
  const minePrev = prev.phase === "play" && !prev.pending && prev.turn === mySeat && !prev.seats[mySeat]?.won;
  if (mineNow && !minePrev) out.push({ t: "myturn" });

  // 该我表态(有人打了张我能吃的牌)
  if (cur.pending?.mine && !prev.pending?.mine) out.push({ t: "claim", tile: cur.pending.tile });

  // 自己摸了一张(手牌数涨了,且不是因为碰杠)
  const ha = prev.hand?.reduce((x, y) => x + y, 0) ?? 0;
  const hb = cur.hand?.reduce((x, y) => x + y, 0) ?? 0;
  if (hb === ha + 1 && cur.lastDrawn >= 0) out.push({ t: "draw", tile: cur.lastDrawn });

  return out;
}
