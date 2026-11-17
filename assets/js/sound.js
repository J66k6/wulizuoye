/**
 * sound.js — 极简 Web Audio 音效合成
 * 不加载任何音频文件：用振荡器与噪声实时合成，体积为 0，首次交互后初始化。
 */

export class Sound {
  constructor(enabled = true) {
    this.enabled = Boolean(enabled);
    this.ctx = null;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
    if (this.enabled) this.ensure();
  }

  ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  tone({ frequency = 440, duration = 0.12, type = 'sine', gain = 0.05, slide = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, frequency + slide), now + duration);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  noise({ duration = 0.18, gain = 0.08, frequency = 900, q = 1.2 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start(now);
  }

  click() {
    this.tone({ frequency: 620, duration: 0.055, type: 'sine', gain: 0.03, slide: -120 });
  }

  record() {
    this.tone({ frequency: 880, duration: 0.09, type: 'sine', gain: 0.045 });
    setTimeout(() => this.tone({ frequency: 1320, duration: 0.14, type: 'sine', gain: 0.035 }), 70);
  }

  success() {
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      setTimeout(() => this.tone({ frequency: freq, duration: 0.18, type: 'triangle', gain: 0.04 }), i * 90);
    });
  }

  error() {
    this.tone({ frequency: 220, duration: 0.16, type: 'sawtooth', gain: 0.03, slide: -60 });
  }

  whoosh() {
    this.noise({ duration: 0.35, gain: 0.025, frequency: 1200, q: 0.7 });
  }

  impact() {
    this.noise({ duration: 0.32, gain: 0.12, frequency: 480, q: 0.8 });
    this.tone({ frequency: 120, duration: 0.28, type: 'sine', gain: 0.08, slide: -60 });
    setTimeout(() => this.tone({ frequency: 980, duration: 0.12, type: 'triangle', gain: 0.035 }), 60);
  }
}
