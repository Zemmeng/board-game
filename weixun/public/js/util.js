// 杂项:本地存储、音效、震动、屏幕常亮、弹层、网络

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- 本地存储(隐私模式/禁用存储时静默失效,不影响游戏) ----------
export const store = {
  get(k, d) {
    try { const v = localStorage.getItem("wx." + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem("wx." + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem("wx." + k); } catch {} },
};

// ---------- 音效(Web Audio 现场合成,零素材) ----------
export const cfg = { sound: true, vib: true };
let ac = null;
export function unlockAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === "suspended") ac.resume();
  } catch {}
}
function tone(freq, dur, at = 0, type = "sine", vol = 0.25) {
  if (!cfg.sound || !ac) return;
  const t = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
export const sfx = {
  tick: () => tone(880, 0.08, 0, "square", 0.12),
  ok: () => { tone(660, 0.12); tone(990, 0.18, 0.09); },
  skip: () => tone(220, 0.18, 0, "triangle", 0.2),
  go: () => { tone(523, 0.1); tone(784, 0.2, 0.1); },
  bad: () => { tone(300, 0.15, 0, "sawtooth", 0.15); tone(200, 0.25, 0.12, "sawtooth", 0.15); },
  end: () => {
    [0, 0.28, 0.56].forEach((at) => { tone(1046, 0.22, at, "square", 0.2); tone(784, 0.22, at + 0.12, "square", 0.16); });
    tone(523, 0.6, 0.9, "triangle", 0.3);
  },
};
export function buzz(pattern) {
  if (!cfg.vib) return;
  try { navigator.vibrate?.(pattern); } catch {}
}

// ---------- 屏幕常亮 ----------
let lock = null, wantLock = false;
export async function keepAwake(on) {
  wantLock = on;
  if (on) {
    if (lock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; });
    } catch {}
  } else if (lock) {
    lock.release().catch(() => {});
    lock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (wantLock && document.visibilityState === "visible") keepAwake(true);
});

// ---------- 弹层 ----------
let modalEl = null;
export function closeSheet() { modalEl?.remove(); modalEl = null; }
export function sheet(html, onAct) {
  closeSheet();
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.addEventListener("click", (e) => {
    if (e.target === m) { closeSheet(); onAct?.("_close"); return; }
    const b = e.target.closest("[data-m]");
    if (b) onAct?.(b.dataset.m, b);
  });
  document.body.appendChild(m);
  modalEl = m;
  return m;
}
export const isSheetOpen = () => !!modalEl;

export function confirmBox(title, body = "", ok = "确定", cls = "amber") {
  return new Promise((res) => {
    sheet(
      `<h3>${esc(title)}</h3>${body ? `<p class="dim">${body}</p>` : ""}
       <div class="stack mt"><button class="btn ${cls}" data-m="ok">${esc(ok)}</button>
       <button class="btn ghost" data-m="no">取消</button></div>`,
      (a) => { if (a === "ok" || a === "no" || a === "_close") { closeSheet(); res(a === "ok"); } }
    );
  });
}

export function promptBox(title, { placeholder = "", value = "", hint = "", type = "text", max = 30 } = {}) {
  return new Promise((res) => {
    const m = sheet(
      `<h3>${esc(title)}</h3>${hint ? `<p class="dim small">${hint}</p>` : ""}
       <input class="inp" id="pb-inp" type="${type}" maxlength="${max}" placeholder="${esc(placeholder)}" value="${esc(value)}"
         ${type === "number" ? 'inputmode="numeric"' : ""} autocomplete="off">
       <div class="stack mt"><button class="btn amber" data-m="ok">确定</button>
       <button class="btn ghost" data-m="no">取消</button></div>`,
      (a) => {
        if (a === "ok") { const v = m.querySelector("#pb-inp").value.trim(); closeSheet(); res(v); }
        else if (a === "no" || a === "_close") { closeSheet(); res(null); }
      }
    );
    const inp = m.querySelector("#pb-inp");
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") m.querySelector('[data-m="ok"]').click(); });
    setTimeout(() => inp.focus(), 60);
  });
}

let toastT = 0;
export function toast(msg, ms = 2200) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), ms);
}

// ---------- 网络(房间备忘录;连不上就返回 null,前端走本地模式) ----------
async function call(path, opts = {}) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(path, { ...opts, signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) return { offline: true };
    const data = await res.json();
    if (!res.ok) return { error: data.error || "出错了" };
    return { data };
  } catch {
    return { offline: true };
  }
}
export const api = {
  state: (code, k, token) => call(`/api/room/${code}${k ? `?k=${encodeURIComponent(k)}` : ""}`, { headers: { "x-token": token || "" } }),
  bank: (code) => call(`/api/room/${code}/bank`),
  op: (code, body, token) =>
    call(`/api/room/${code}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-token": token || "" },
      body: JSON.stringify(body),
    }),
};
