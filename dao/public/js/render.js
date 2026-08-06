// SVG 棋盘渲染:地格、数字签、棋子、强盗、可点高亮
import {
  RES, DESERT_COLOR, VERTICES, EDGES, TILE_VERTICES, hexCenter,
} from "./shared/rules.js";

const NS = "http://www.w3.org/2000/svg";
const SIZE = 50; // 一格的"半径"像素

let svg = null;
let layers = {};

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

const px = (v) => ({ x: v.x * SIZE, y: v.y * SIZE });

export function initBoard(svgEl, board) {
  svg = svgEl;
  svg.innerHTML = "";
  svg.setAttribute("viewBox", "-235 -225 470 450");
  layers = {};
  for (const name of ["tiles", "pieces", "robber", "hl"]) {
    layers[name] = el("g", { class: "layer-" + name }, svg);
  }

  for (const tile of board.tiles) {
    const pts = TILE_VERTICES.get(tile.k)
      .map((vid) => { const p = px(VERTICES.get(vid)); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; })
      .join(" ");
    const g = el("g", {}, layers.tiles);
    el("polygon", {
      points: pts,
      fill: tile.kind === "desert" ? DESERT_COLOR : RES[tile.kind].color,
      class: "tile",
    }, g);
    const c = hexCenter(tile.k);
    const cx = c.x * SIZE, cy = c.y * SIZE;
    const name = el("text", { x: cx, y: cy - 16, class: "tile-name" }, g);
    name.textContent = tile.kind === "desert" ? "荒漠" : RES[tile.kind].tile;
    if (tile.num) {
      el("circle", { cx, cy: cy + 8, r: 15.5, class: "disc" }, g);
      const red = tile.num === 6 || tile.num === 8;
      const t = el("text", { x: cx, y: cy + 12.5, class: "disc-num" + (red ? " red" : "") }, g);
      t.textContent = tile.num;
      const pips = 6 - Math.abs(7 - tile.num); // 出现频率点数
      for (let i = 0; i < pips; i++) {
        el("circle", {
          cx: cx - (pips - 1) * 2.1 + i * 4.2, cy: cy + 18.2, r: 1.3,
          class: "pip" + (red ? " red" : ""),
        }, g);
      }
    }
  }
}

function drawHouse(vid, color, isCity, parent) {
  const p = px(VERTICES.get(vid));
  const shape = isCity
    ? "-13,9 -13,-2 -5.5,-9 2,-2 2,1 13,1 13,9"   // 城邑:主楼带侧翼
    : "-10,8 -10,-1 0,-10 10,-1 10,8";            // 村庄:小房子
  el("polygon", {
    points: shape,
    transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`,
    fill: color,
    class: "building",
  }, parent);
}

export function updatePieces(g) {
  layers.pieces.innerHTML = "";
  layers.robber.innerHTML = "";

  for (const seat of g.seats) {
    for (const eid of seat.roads) {
      const [a, b] = EDGES.get(eid).v.map((v) => px(VERTICES.get(v)));
      // 两端各缩进一段,别盖住顶点上的建筑
      const x1 = a.x + (b.x - a.x) * 0.18, y1 = a.y + (b.y - a.y) * 0.18;
      const x2 = a.x + (b.x - a.x) * 0.82, y2 = a.y + (b.y - a.y) * 0.82;
      el("line", { x1, y1, x2, y2, class: "road-outline" }, layers.pieces);
      el("line", { x1, y1, x2, y2, stroke: seat.color, class: "road" }, layers.pieces);
    }
  }
  for (const seat of g.seats) {
    for (const vid of seat.villages) drawHouse(vid, seat.color, false, layers.pieces);
    for (const vid of seat.cities) drawHouse(vid, seat.color, true, layers.pieces);
  }

  if (g.board?.robber) {
    const c = hexCenter(g.board.robber);
    const cx = c.x * SIZE, cy = c.y * SIZE + 8;
    const grp = el("g", { class: "robber", transform: `translate(${cx} ${cy})` }, layers.robber);
    el("circle", { cx: 0, cy: -6, r: 5, class: "robber-body" }, grp);
    el("path", { d: "M -7,10 Q -7,-2 0,-2 Q 7,-2 7,10 Z", class: "robber-body" }, grp);
  }
}

export function clearHighlights() {
  if (layers.hl) layers.hl.innerHTML = "";
}

// type: "vertex" | "edge" | "tile";点击回调 cb(id)
export function showHighlights(ids, type, cb) {
  clearHighlights();
  for (const id of ids) {
    let node;
    if (type === "vertex") {
      const p = px(VERTICES.get(id));
      node = el("circle", { cx: p.x, cy: p.y, r: 9, class: "hl hl-vertex" }, layers.hl);
    } else if (type === "edge") {
      const [a, b] = EDGES.get(id).v.map((v) => px(VERTICES.get(v)));
      const x1 = a.x + (b.x - a.x) * 0.2, y1 = a.y + (b.y - a.y) * 0.2;
      const x2 = a.x + (b.x - a.x) * 0.8, y2 = a.y + (b.y - a.y) * 0.8;
      node = el("line", { x1, y1, x2, y2, class: "hl hl-edge" }, layers.hl);
    } else {
      const pts = TILE_VERTICES.get(id)
        .map((vid) => { const p = px(VERTICES.get(vid)); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; })
        .join(" ");
      node = el("polygon", { points: pts, class: "hl hl-tile" }, layers.hl);
    }
    node.addEventListener("click", () => cb(id));
  }
}
