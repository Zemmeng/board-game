// 声音:全部 Web Audio 现场合成,零素材文件。
//
// 麻将的音色很有辨识度 —— 牌磕在桌面上是「脆而短、带一点木头共振」,
// 洗牌是一片沙沙。这类声音用「噪声 + 带通滤波 + 极快包络」比找采样更好调,
// 而且改一个数就能从「塑料牌」变成「玉牌」。

let ctx = null, master = null, musicGain = null;
let musicOn = false, sfxOn = true, musicTimer = 0;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicGain.connect(master);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** 浏览器要求用户先交互过才让出声,任何一次点击后调一下这个 */
export function unlock() { ac(); }
export function setSfx(on) { sfxOn = on; }
export function isMusicOn() { return musicOn; }

// ---------- 基础音色 ----------

/** 一段白噪声 buffer,做敲击类音效的原料 */
let noiseBuf = null;
function noise() {
  const c = ac();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

/**
 * 敲击声:噪声过带通,配一个几十毫秒的包络。
 * freq 越高越「脆」,q 越大越「有调」,decay 越短越「硬」。
 */
function knock(freq, decay = 0.075, gain = 0.5, q = 6) {
  if (!sfxOn) return;
  const c = ac(), t = c.currentTime;
  const src = noise();
  const bp = c.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(bp).connect(g).connect(master);
  src.start(t); src.stop(t + decay + 0.02);

  // 叠一个短促的木头共振,声音才不像单纯的「噗」
  const o = c.createOscillator(), og = c.createGain();
  o.type = "triangle"; o.frequency.setValueAtTime(freq * 0.5, t);
  o.frequency.exponentialRampToValueAtTime(freq * 0.32, t + decay);
  og.gain.setValueAtTime(gain * 0.5, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.9);
  o.connect(og).connect(master);
  o.start(t); o.stop(t + decay + 0.02);
}

/** 音调声:用于胡牌、提示 */
function tone(freq, dur = 0.3, gain = 0.22, type = "sine", delay = 0) {
  if (!sfxOn) return;
  const c = ac(), t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

// ---------- 对外的音效 ----------

export const sfx = {
  draw:    () => knock(1500, 0.045, 0.26, 9),                    // 摸牌:轻轻一提
  discard: () => knock(950, 0.09, 0.62, 4),                      // 打牌:啪
  peng:    () => { knock(880, 0.09, 0.6, 4); setTimeout(() => knock(760, 0.11, 0.55, 4), 70); },
  gang:    () => { [0, 65, 130].forEach((d, i) => setTimeout(() => knock(900 - i * 70, 0.1, 0.6, 4), d)); },
  select:  () => knock(2200, 0.03, 0.16, 12),                    // 点牌
  // 胡牌:五声音阶往上跑一串,喜庆但不吵
  hu: () => { [523.25, 587.33, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.5, 0.2, "triangle", i * 0.075)); },
  win: () => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.8, 0.24, "sine", i * 0.1)); },
  lose: () => { [392, 349.23, 293.66].forEach((f, i) => tone(f, 0.6, 0.18, "sine", i * 0.12)); },
  turn: () => tone(880, 0.16, 0.13, "sine"),                     // 轮到你了
  // 洗牌:一片沙沙,靠滤波扫频做出「哗啦」的动势
  shuffle: () => {
    if (!sfxOn) return;
    const c = ac(), t = c.currentTime, src = noise();
    const bp = c.createBiquadFilter();
    bp.type = "bandpass"; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(2600, t + 0.35);
    bp.frequency.linearRampToValueAtTime(900, t + 0.75);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.08);
    g.gain.linearRampToValueAtTime(0.001, t + 0.8);
    src.connect(bp).connect(g).connect(master);
    src.start(t); src.stop(t + 0.85);
  },
};

// ---------- 背景音乐 ----------
// 中式五声音阶(宫商角徵羽)的生成式慢速琶音。不循环固定旋律,
// 每次取音都带一点随机,听久了不容易腻,也不用带任何音频文件。

const PENTA = [261.63, 293.66, 329.63, 392.0, 440.0];   // C D E G A
const BASS = [130.81, 146.83, 164.81, 196.0];

function pluck(freq, when, dur, gain) {
  const c = ctx;
  const o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
  o.type = "triangle"; o.frequency.value = freq;
  lp.type = "lowpass"; lp.frequency.value = 2400;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(lp).connect(g).connect(musicGain);
  o.start(when); o.stop(when + dur + 0.05);
}

let step = 0;
function scheduleMusic() {
  if (!musicOn) return;
  const c = ac();
  const now = c.currentTime;
  const beat = 0.62;
  for (let i = 0; i < 4; i++) {
    const when = now + i * beat;
    const n = PENTA[(step + i * 2 + ((Math.random() * 3) | 0)) % PENTA.length];
    pluck(n * (Math.random() < 0.25 ? 2 : 1), when, 1.5, 0.075);
    if ((step + i) % 4 === 0) pluck(BASS[(step / 4 | 0) % BASS.length], when, 2.4, 0.06);
  }
  step += 4;
  musicTimer = setTimeout(scheduleMusic, beat * 4 * 1000 - 60);
}

export function toggleMusic(on) {
  ac();
  musicOn = on ?? !musicOn;
  clearTimeout(musicTimer);
  if (musicOn) {
    musicGain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.6);
    scheduleMusic();
  } else {
    musicGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  }
  return musicOn;
}
