// 「余一」音效 —— 全部用 Web Audio 现场合成,不加载任何音频文件。
// 旋律性的音都取五声音阶(宫商角徵羽),跟国风美术对齐。
//
// 三个必须处理的老坑(竹知了那边踩过):
//   1. 自动播放限制 —— AudioContext 必须在用户手势里创建/resume
//   2. iOS 17+ 静音拨键会压掉 Web Audio —— 要申请 playback 音频会话
//   3. 切后台不挂起会继续占着音频焦点 —— visibilitychange 里 suspend/resume

const PENTA = { 宫: 261.63, 商: 293.66, 角: 329.63, 徵: 392.0, 羽: 440.0 };

let ctx = null, master = null, noiseBuf = null;
let muted = localStorage.getItem("yuyi-muted") === "1";

function makeNoise(c) {
  const buf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** 在用户手势里调一次即可解锁;之后重复调用只做 resume */
export function ensure() {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = "playback"; } catch { /* 忽略 */ }
  }
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = makeNoise(ctx);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function isMuted() { return muted; }

export function setMuted(m) {
  muted = m;
  localStorage.setItem("yuyi-muted", m ? "1" : "0");
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.02);
}

// ---------- 基础发声块 ----------

function tone({ freq, to, type = "sine", dur = 0.25, gain = 0.3, at = 0, attack = 0.004 }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise({ dur = 0.09, freq = 2200, to, q = 1.1, gain = 0.3, at = 0 }) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  f.type = "bandpass"; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t); s.stop(t + dur + 0.02);
}

/** 磬:基频 + 两个非整数倍泛音,长衰减 */
function bell(freq, gain = 0.22, dur = 1.1, at = 0) {
  tone({ freq, type: "sine", dur, gain, at, attack: 0.002 });
  tone({ freq: freq * 2.76, type: "sine", dur: dur * 0.55, gain: gain * 0.34, at, attack: 0.002 });
  tone({ freq: freq * 5.4, type: "sine", dur: dur * 0.3, gain: gain * 0.16, at, attack: 0.002 });
}

// ---------- 对外音效 ----------

export const sfx = {
  /** 出牌:纸牌拍在毡面上 */
  play() {
    noise({ dur: 0.075, freq: 2600, to: 900, q: 0.8, gain: 0.34 });
    tone({ freq: 190, to: 70, type: "sine", dur: 0.09, gain: 0.2 });
  },

  /** 摸牌:抽纸的短促摩擦 */
  draw() {
    noise({ dur: 0.11, freq: 1400, to: 4200, q: 1.6, gain: 0.17 });
  },

  /** 发牌:n 张连着甩出去,间隔跟视觉的错开节奏对齐 */
  deal(n = 7) {
    for (let i = 0; i < Math.min(n, 10); i++) {
      noise({ dur: 0.07, freq: 1800, to: 3600, q: 1.5, gain: 0.14, at: i * 0.055 });
    }
  },

  /** +2 / +4 落桌:闷响一记 */
  slam() {
    tone({ freq: 130, to: 38, type: "sine", dur: 0.32, gain: 0.42 });
    noise({ dur: 0.16, freq: 900, to: 200, q: 0.7, gain: 0.3 });
  },

  /** 喊「余一」:印章砸落 —— 木头闷响 + 一记磬 */
  uno() {
    tone({ freq: 160, to: 48, type: "triangle", dur: 0.18, gain: 0.38 });
    noise({ dur: 0.09, freq: 1200, to: 300, q: 0.9, gain: 0.26 });
    bell(PENTA.羽 * 2, 0.2, 1.2, 0.06);
  },

  /** 被抓/吃罚牌:下行的一声「哎呀」 */
  penalty() {
    tone({ freq: PENTA.角, to: PENTA.宫 * 0.75, type: "triangle", dur: 0.34, gain: 0.26 });
    noise({ dur: 0.2, freq: 700, to: 180, q: 0.8, gain: 0.16, at: 0.03 });
  },

  /** 换色:清脆的磬 */
  chime() {
    bell(PENTA.徵 * 2, 0.18, 0.95);
  },

  /** 被禁止:一记闷断的「咚」,后面跟一声压住的短噪 */
  skip() {
    tone({ freq: 210, to: 60, type: "square", dur: 0.14, gain: 0.24 });
    noise({ dur: 0.13, freq: 600, to: 160, q: 1.2, gain: 0.22, at: 0.05 });
  },

  /** 掉头:一个来回的扫频,像风向倒转 */
  reverse() {
    noise({ dur: 0.22, freq: 500, to: 4000, q: 2.2, gain: 0.2 });
    noise({ dur: 0.26, freq: 4000, to: 400, q: 2.2, gain: 0.2, at: 0.2 });
    tone({ freq: PENTA.商 * 2, to: PENTA.羽 * 2, type: "sine", dur: 0.2, gain: 0.14 });
    tone({ freq: PENTA.羽 * 2, to: PENTA.商 * 2, type: "sine", dur: 0.24, gain: 0.14, at: 0.2 });
  },

  /** 轮到你:两声轻提示 */
  turn() {
    tone({ freq: PENTA.徵, type: "sine", dur: 0.11, gain: 0.16 });
    tone({ freq: PENTA.羽, type: "sine", dur: 0.16, gain: 0.16, at: 0.1 });
  },

  /** 本局/整场结束:五声音阶上行 */
  win() {
    [PENTA.宫, PENTA.商, PENTA.角, PENTA.徵, PENTA.羽].forEach((f, i) => {
      tone({ freq: f * 2, type: "sine", dur: 0.3, gain: 0.2, at: i * 0.1 });
    });
    bell(PENTA.宫 * 4, 0.16, 1.4, 0.5);
  },
};

// 手势解锁。不同浏览器/环境派发的事件不一样(有的只给 mousedown 不给 pointerdown),
// 所以几种都挂上;ensure() 幂等,重复调用只是 resume 一下,不能只挂 once。
// 真正保底的是游戏自己那几个按钮 —— init() 里会显式调 ensure()。
for (const ev of ["pointerdown", "mousedown", "touchstart", "keydown", "click"]) {
  window.addEventListener(ev, () => ensure(), { capture: true, passive: true });
}

// 切后台立即挂起,回前台恢复
document.addEventListener("visibilitychange", () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend();
  else if (!muted) ctx.resume();
});
