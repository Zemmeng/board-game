// 牌面 SVG。
//
// 这里刻意**不用 AI 出图**:一筒到九筒是圆点、一条到九条是竹节,数量必须一张不差,
// 而图像模型数不准点数,27 张牌面必然出现点错和风格漂移,缩到手牌大小还会糊。
// 手画 SVG 反而张张精确、任意尺寸都锐利,体积也小得多。
// 可灵留给真正吃质感的地方:桌面毡布、牌背、封面。

const RED = "#c0392b", GREEN = "#1f7a4d", BLUE = "#20548c", INK = "#2b2118";

const HAN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 筒:圆点的摆位(每种点数一套坐标),坐标系 0~100 */
const DOT_LAYOUT = {
  1: [[50, 50]],
  2: [[50, 30], [50, 70]],
  3: [[28, 26], [50, 50], [72, 74]],
  4: [[32, 30], [68, 30], [32, 70], [68, 70]],
  5: [[30, 28], [70, 28], [50, 50], [30, 72], [70, 72]],
  6: [[32, 24], [68, 24], [32, 50], [68, 50], [32, 76], [68, 76]],
  7: [[50, 18], [32, 38], [68, 38], [32, 60], [68, 60], [32, 82], [68, 82]],
  8: [[32, 20], [68, 20], [32, 40], [68, 40], [32, 60], [68, 60], [32, 80], [68, 80]],
  9: [[28, 24], [50, 24], [72, 24], [28, 50], [50, 50], [72, 50], [28, 76], [50, 76], [72, 76]],
};

/** 条:竹节的摆位,跟筒同构但画成竖棍 */
const BAM_LAYOUT = {
  1: [[50, 50]],
  2: [[50, 30], [50, 70]],
  3: [[50, 24], [34, 68], [66, 68]],
  4: [[34, 30], [66, 30], [34, 70], [66, 70]],
  5: [[32, 26], [68, 26], [50, 50], [32, 74], [68, 74]],
  6: [[32, 26], [50, 26], [68, 26], [32, 74], [50, 74], [68, 74]],
  7: [[50, 20], [32, 50], [50, 50], [68, 50], [32, 80], [50, 80], [68, 80]],
  8: [[32, 22], [50, 22], [68, 22], [32, 50], [68, 50], [32, 78], [50, 78], [68, 78]],
  9: [[32, 22], [50, 22], [68, 22], [32, 50], [50, 50], [68, 50], [32, 78], [50, 78], [68, 78]],
};

const dot = (x, y, c) =>
  `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${c}" stroke-width="4"/>`
  + `<circle cx="${x}" cy="${y}" r="4.2" fill="${c}"/>`;

const bam = (x, y, c) =>
  `<rect x="${x - 4.6}" y="${y - 13}" width="9.2" height="26" rx="4.4" fill="${c}"/>`
  + `<rect x="${x - 7}" y="${y - 3}" width="14" height="3" rx="1.5" fill="rgba(255,255,255,.55)"/>`;

/** 一条画成雀鸟(麻将的老规矩),这里简化成一只圆头小鸟 */
function sparrow() {
  return `<g>
    <ellipse cx="50" cy="58" rx="15" ry="20" fill="${GREEN}"/>
    <circle cx="50" cy="33" r="9.5" fill="${GREEN}"/>
    <circle cx="53" cy="31" r="2" fill="#fff"/>
    <path d="M58 34 L68 37 L58 40 Z" fill="${RED}"/>
    <path d="M50 76 L42 88 M50 76 L58 88" stroke="${RED}" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M38 54 Q30 62 36 72" stroke="${GREEN}" stroke-width="5" fill="none" stroke-linecap="round"/>
  </g>`;
}

/**
 * 生成一张牌面的 SVG 内容(不含外框)。
 * @param suit 0 万 1 条 2 筒
 * @param rank 1~9
 */
export function faceSvg(suit, rank) {
  if (suit === 0) {
    // 万:上面汉字数字,下面一个「万」
    return `<text x="50" y="45" font-size="40" text-anchor="middle" fill="${INK}"
              font-family="'PingFang SC','Songti SC',serif" font-weight="600">${HAN[rank]}</text>
            <text x="50" y="88" font-size="34" text-anchor="middle" fill="${RED}"
              font-family="'PingFang SC','Songti SC',serif" font-weight="700">万</text>`;
  }
  if (suit === 2) {
    const c = rank === 1 ? BLUE : (rank % 2 ? BLUE : GREEN);
    return DOT_LAYOUT[rank].map(([x, y]) => dot(x, y, rank === 5 ? (x === 50 ? RED : BLUE) : c)).join("");
  }
  // 条
  if (rank === 1) return sparrow();
  return BAM_LAYOUT[rank].map(([x, y], i) => {
    const c = rank === 5 && i === 2 ? RED : (rank % 3 === 0 && i % 2 ? BLUE : GREEN);
    return bam(x, y, c);
  }).join("");
}

// ---------- 可灵素材 ----------
// img/tiles.json 在的话就改用图片牌面(牌坯 + 图案都是可灵出的),
// 拿不到就继续用下面手画的 SVG —— 素材没就位也不至于开天窗。
let artSet = null;
const SUIT_CODE = ["m", "s", "p"];        // 万 / 条 / 筒

export async function loadTileArt() {
  try {
    const res = await fetch("img/tiles.json", { cache: "no-cache" });
    if (!res.ok) return false;
    artSet = new Set(await res.json());
    return artSet.size > 0;
  } catch { return false; }
}

const artName = (t) => SUIT_CODE[(t / 9) | 0] + ((t % 9) + 1);

/** 一整张牌(含牌身、圆角、高光)。size 是宽度,高按 1.38 比例 */
export function tileSvg(tileIndex, { w = 46, dim = false, mark = "" } = {}) {
  const suit = (tileIndex / 9) | 0, rank = (tileIndex % 9) + 1;
  const h = Math.round(w * 1.38);

  const key = artName(tileIndex);
  if (artSet?.has(key)) {
    return `<img class="tile-img" src="img/tiles/${key}.jpg" width="${w}" height="${h}"
      alt="${rank}${["万","条","筒"][suit]}" draggable="false"
      style="${dim ? "filter:brightness(.62)" : ""}">`;
  }

  return `<svg class="tile-svg" width="${w}" height="${h}" viewBox="0 0 100 138"
      xmlns="http://www.w3.org/2000/svg" aria-label="${rank}${["万","条","筒"][suit]}">
    <rect x="1.5" y="1.5" width="97" height="135" rx="12" fill="#f7f2e4" stroke="#b9ac90" stroke-width="2.4"/>
    <rect x="5" y="5" width="90" height="121" rx="9" fill="#fffdf6"/>
    <g transform="translate(0 9) scale(1 0.88)">${faceSvg(suit, rank)}</g>
    ${mark ? `<circle cx="82" cy="118" r="11" fill="${RED}"/>
      <text x="82" y="123" font-size="15" text-anchor="middle" fill="#fff" font-weight="700">${mark}</text>` : ""}
    ${dim ? `<rect x="1.5" y="1.5" width="97" height="135" rx="12" fill="rgba(20,14,8,.42)"/>` : ""}
  </svg>`;
}

/** 牌背(别人的手牌) */
export function backSvg({ w = 46 } = {}) {
  const h = Math.round(w * 1.38);
  return `<svg class="tile-svg" width="${w}" height="${h}" viewBox="0 0 100 138" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="97" height="135" rx="12" fill="#2e7d52" stroke="#1d5537" stroke-width="2.4"/>
    <rect x="8" y="8" width="84" height="122" rx="8" fill="#37946" opacity="0"/>
    <rect x="10" y="10" width="80" height="118" rx="8" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="3"/>
    <circle cx="50" cy="69" r="21" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="4"/>
    <circle cx="50" cy="69" r="8" fill="rgba(255,255,255,.28)"/>
  </svg>`;
}

/** 横放的牌(用于别人打出的牌河也可以直接用竖的,这里给碰杠副露用) */
export const tileName = (t) => `${(t % 9) + 1}${["万", "条", "筒"][(t / 9) | 0]}`;
