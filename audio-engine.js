'use strict';

/* ============================================================
 * VoiceForge Audio Engine
 * Web Audio API tabanlı, tamamen lokal karakter sesi dönüştürücü.
 * Akış: kaynak AudioBuffer → katmanlı granüler pitch shift →
 *       filtre / ring mod / distortion / chorus / tremolo / echo →
 *       reverb (dry-wet) → kompresör → normalize → trim
 * ============================================================ */

const VoiceEngine = (() => {

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /* ---------- Granüler pitch shift (süre sabit kalır) ---------- */
  function pitchShiftBuffer(buffer, semitones) {
    if (Math.abs(semitones) < 0.01) return buffer;
    const ratio = Math.pow(2, semitones / 12);
    const sr = buffer.sampleRate;
    const chs = buffer.numberOfChannels;
    const len = buffer.length;
    const out = new AudioBuffer({ numberOfChannels: chs, length: len, sampleRate: sr });

    const grain = Math.round(sr * 0.10);     // 100 ms grain
    const hop = Math.max(1, Math.round(grain / 4)); // %75 overlap
    const win = new Float32Array(grain);
    for (let i = 0; i < grain; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain);

    for (let c = 0; c < chs; c++) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      const norm = new Float32Array(len);
      for (let pos = 0; pos < len; pos += hop) {
        for (let i = 0; i < grain; i++) {
          const oi = pos + i;
          if (oi >= len) break;
          const srcIdx = pos + i * ratio;
          const i0 = Math.floor(srcIdx);
          if (i0 + 1 >= len) break;
          const frac = srcIdx - i0;
          const sample = src[i0] * (1 - frac) + src[i0 + 1] * frac;
          dst[oi] += sample * win[i];
          norm[oi] += win[i];
        }
      }
      for (let i = 0; i < len; i++) if (norm[i] > 1e-6) dst[i] /= norm[i];
    }
    return out;
  }

  /* ---------- Yardımcı eğriler / IR ---------- */
  function makeDistortionCurve(drive) {
    const n = 2048;
    const curve = new Float32Array(n);
    const k = 1 + drive * 40;
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  function makeCrushCurve(steps) {
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  function makeImpulse(ctx, seconds, decay) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return ir;
  }

  /* ---------- Post: normalize + kuyruk kırpma ---------- */
  function normalizeBuffer(buffer, target) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak < 1e-4) return buffer;
    const g = target / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
    return buffer;
  }

  function trimTail(buffer, threshold, padSec) {
    const sr = buffer.sampleRate;
    let last = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = d.length - 1; i >= 0; i--) {
        if (Math.abs(d[i]) > threshold) { if (i > last) last = i; break; }
      }
    }
    const newLen = Math.min(buffer.length, last + Math.floor(sr * padSec));
    if (newLen >= buffer.length - sr * 0.05) return buffer;
    const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: newLen, sampleRate: sr });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      out.getChannelData(c).set(buffer.getChannelData(c).subarray(0, newLen));
    }
    return out;
  }

  /* ---------- WAV (16-bit PCM) encode ---------- */
  function encodeWav(buffer) {
    const numCh = Math.min(2, buffer.numberOfChannels);
    const sr = buffer.sampleRate;
    const len = buffer.length;
    const blockAlign = numCh * 2;
    const dataSize = len * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, dataSize, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  /* ============================================================
   * PRESETLER
   * layers: [{ st: yarımton, gain }] — ana ses + alt/üst katmanlar
   * intensityDefault: yoğunluk slider'ının varsayılanı; drive ve
   *   ringMod.depth bu değere göre ölçeklenir (v / intensityDefault)
   * ============================================================ */
  const PRESETS = {
    demon: {
      name: 'İblis Lordu', emoji: '😈', desc: 'Derin, katmanlı, arena yankılı boss sesi',
      layers: [{ st: -5, gain: 1.0 }, { st: -17, gain: 0.45 }],
      ringMod: { freq: 70, depth: 0.35 },
      drive: 0.4,
      filters: [{ type: 'peaking', freq: 200, gain: 5, q: 0.8 }, { type: 'lowpass', freq: 3600 }],
      echo: { time: 0.16, feedback: 0.25, mix: 0.15 },
      reverb: { seconds: 2.4, decay: 2.5, wet: 0.4 },
      intensityDefault: 60,
    },
    orc: {
      name: 'Ork', emoji: '👹', desc: 'Kalın, hırıltılı, agresif savaş sesi',
      layers: [{ st: -3.5, gain: 1.0 }],
      ringMod: { freq: 50, depth: 0.15 },
      drive: 0.65,
      filters: [{ type: 'peaking', freq: 180, gain: 6, q: 0.9 }, { type: 'lowpass', freq: 4200 }],
      reverb: { seconds: 0.9, decay: 3.0, wet: 0.18 },
      intensityDefault: 60,
    },
    troll: {
      name: 'Mağara Trolü', emoji: '🗿', desc: 'Çok derin, mağara yankılı, ağır',
      layers: [{ st: -7, gain: 1.0 }],
      drive: 0.45,
      filters: [{ type: 'peaking', freq: 140, gain: 7, q: 0.8 }, { type: 'lowpass', freq: 2600 }],
      echo: { time: 0.22, feedback: 0.38, mix: 0.3 },
      reverb: { seconds: 3.2, decay: 2.2, wet: 0.45 },
      intensityDefault: 60,
    },
    giant: {
      name: 'Dev', emoji: '⛰️', desc: 'Devasa gövde, gümbürtülü alçak ton',
      layers: [{ st: -9, gain: 1.0 }],
      drive: 0.3,
      filters: [{ type: 'peaking', freq: 100, gain: 8, q: 0.7 }, { type: 'lowpass', freq: 2200 }],
      echo: { time: 0.3, feedback: 0.3, mix: 0.2 },
      reverb: { seconds: 2.8, decay: 2.0, wet: 0.35 },
      intensityDefault: 60,
    },
    zombie: {
      name: 'Zombi', emoji: '🧟', desc: 'Boğuk, çürümüş, titrek hırlama',
      layers: [{ st: -4, gain: 1.0 }],
      drive: 0.55,
      filters: [{ type: 'lowpass', freq: 3000 }, { type: 'peaking', freq: 300, gain: 4, q: 1.0 }],
      tremolo: { rate: 7, depth: 0.3 },
      echo: { time: 0.09, feedback: 0.3, mix: 0.25 },
      reverb: { seconds: 1.2, decay: 2.5, wet: 0.2 },
      intensityDefault: 60,
    },
    elf: {
      name: 'Elf', emoji: '✨', desc: 'Parlak, zarif, büyülü şıngırtılı',
      layers: [{ st: 2.5, gain: 1.0 }, { st: 14.5, gain: 0.15 }],
      chorus: { delayMs: 18, depthMs: 4, rate: 0.8, mix: 0.6 },
      filters: [{ type: 'highshelf', freq: 6000, gain: 4 }],
      reverb: { seconds: 1.8, decay: 2.8, wet: 0.35 },
      intensityDefault: 60,
    },
    ghost: {
      name: 'Hayalet', emoji: '👻', desc: 'Ürpertici, dağınık, öbür dünyadan',
      layers: [{ st: 1, gain: 0.9 }, { st: 1.4, gain: 0.5 }, { st: 0.6, gain: 0.5 }],
      filters: [{ type: 'highpass', freq: 350 }, { type: 'lowpass', freq: 6000 }],
      tremolo: { rate: 4.5, depth: 0.35 },
      echo: { time: 0.35, feedback: 0.45, mix: 0.3 },
      reverb: { seconds: 3.8, decay: 1.8, wet: 0.65 },
      intensityDefault: 60,
    },
    goblin: {
      name: 'Goblin', emoji: '👺', desc: 'Sinsi, cıyaklayan ufaklık',
      layers: [{ st: 6, gain: 1.0 }, { st: 6.3, gain: 0.3 }],
      drive: 0.25,
      filters: [{ type: 'highpass', freq: 200 }, { type: 'peaking', freq: 2500, gain: 4, q: 1.0 }],
      reverb: { seconds: 0.8, decay: 3.0, wet: 0.15 },
      intensityDefault: 60,
    },
    robot: {
      name: 'Robot', emoji: '🤖', desc: 'Metalik, vokoder vari, mekanik',
      layers: [{ st: 0, gain: 1.0 }],
      ringMod: { freq: 55, depth: 0.85 },
      bitcrush: { steps: 14 },
      filters: [{ type: 'highpass', freq: 250 }, { type: 'lowpass', freq: 3800 }],
      reverb: { seconds: 0.4, decay: 4.0, wet: 0.08 },
      intensityDefault: 60,
    },
    radio: {
      name: 'Telsiz', emoji: '📻', desc: 'Cızırtılı, dar bantlı muhabere',
      layers: [{ st: 0, gain: 1.0 }],
      drive: 0.35,
      bitcrush: { steps: 20 },
      filters: [
        { type: 'highpass', freq: 500, q: 0.7 },
        { type: 'lowpass', freq: 2800, q: 0.7 },
        { type: 'peaking', freq: 1800, gain: 4, q: 1.2 },
      ],
      reverb: { seconds: 0.3, decay: 4.0, wet: 0.05 },
      intensityDefault: 60,
    },
  };

  /* ---------- Render ----------
   * user: { pitch: yarımton ofseti, intensity: 0-100, reverbWet: 0-1 }
   */
  async function renderWithPreset(srcBuffer, presetKey, user) {
    const preset = PRESETS[presetKey];
    if (!preset) throw new Error('Bilinmeyen preset: ' + presetKey);

    const sr = srcBuffer.sampleRate;
    const tailSec = (preset.reverb ? preset.reverb.seconds : 0) + (preset.echo ? 1.2 : 0) + 0.3;
    const length = srcBuffer.length + Math.ceil(tailSec * sr);
    const ctx = new OfflineAudioContext(2, length, sr);

    // Katmanlar (pitch shift CPU'da, senkron — kısa replikler için hızlı)
    const input = ctx.createGain();
    for (const layer of preset.layers) {
      const shifted = pitchShiftBuffer(srcBuffer, layer.st + user.pitch);
      const s = ctx.createBufferSource();
      s.buffer = shifted;
      const g = ctx.createGain();
      g.gain.value = layer.gain;
      s.connect(g);
      g.connect(input);
      s.start(0);
    }

    let node = input;
    const intensityFactor = user.intensity / (preset.intensityDefault || 60);

    // Filtreler
    if (preset.filters) {
      for (const f of preset.filters) {
        const bi = ctx.createBiquadFilter();
        bi.type = f.type;
        bi.frequency.value = f.freq;
        if (f.gain !== undefined) bi.gain.value = f.gain;
        if (f.q !== undefined) bi.Q.value = f.q;
        node.connect(bi);
        node = bi;
      }
    }

    // Ring modulation: gain = (1-depth) + depth*sin(2πft)
    if (preset.ringMod) {
      const depth = clamp01(preset.ringMod.depth * intensityFactor);
      if (depth > 0.01) {
        const rm = ctx.createGain();
        rm.gain.value = 1 - depth;
        const osc = ctx.createOscillator();
        osc.frequency.value = preset.ringMod.freq;
        const og = ctx.createGain();
        og.gain.value = depth;
        osc.connect(og);
        og.connect(rm.gain);
        osc.start(0);
        node.connect(rm);
        node = rm;
      }
    }

    // Distortion
    if (preset.drive) {
      const d = clamp01(preset.drive * intensityFactor);
      if (d > 0.01) {
        const shp = ctx.createWaveShaper();
        shp.curve = makeDistortionCurve(d);
        shp.oversample = '2x';
        node.connect(shp);
        node = shp;
      }
    }

    // Bitcrush
    if (preset.bitcrush) {
      const shp = ctx.createWaveShaper();
      shp.curve = makeCrushCurve(preset.bitcrush.steps);
      node.connect(shp);
      node = shp;
    }

    // Chorus (paralel, LFO'lu kısa delay)
    if (preset.chorus) {
      const c = preset.chorus;
      const delay = ctx.createDelay(1);
      delay.delayTime.value = c.delayMs / 1000;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = c.rate;
      const lg = ctx.createGain();
      lg.gain.value = c.depthMs / 1000;
      lfo.connect(lg);
      lg.connect(delay.delayTime);
      lfo.start(0);
      const sum = ctx.createGain();
      const dryG = ctx.createGain();
      dryG.gain.value = 1 - c.mix * 0.4;
      const wetG = ctx.createGain();
      wetG.gain.value = c.mix;
      node.connect(dryG); dryG.connect(sum);
      node.connect(delay); delay.connect(wetG); wetG.connect(sum);
      node = sum;
    }

    // Tremolo
    if (preset.tremolo) {
      const t = preset.tremolo;
      const tg = ctx.createGain();
      tg.gain.value = 1 - t.depth;
      const osc = ctx.createOscillator();
      osc.frequency.value = t.rate;
      const og = ctx.createGain();
      og.gain.value = t.depth;
      osc.connect(og);
      og.connect(tg.gain);
      osc.start(0);
      node.connect(tg);
      node = tg;
    }

    // Echo (feedback delay, paralel)
    if (preset.echo) {
      const e = preset.echo;
      const dl = ctx.createDelay(2);
      dl.delayTime.value = e.time;
      const fb = ctx.createGain();
      fb.gain.value = e.feedback;
      dl.connect(fb); fb.connect(dl);
      const eg = ctx.createGain();
      eg.gain.value = e.mix;
      const sum = ctx.createGain();
      node.connect(sum);
      node.connect(dl); dl.connect(eg); eg.connect(sum);
      node = sum;
    }

    // Reverb (dry/wet)
    const wet = clamp01(user.reverbWet);
    let outNode = node;
    if (preset.reverb && wet > 0.01) {
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, preset.reverb.seconds, preset.reverb.decay);
      const dryG = ctx.createGain();
      dryG.gain.value = 1 - wet * 0.5;
      const wetG = ctx.createGain();
      wetG.gain.value = wet;
      const sum = ctx.createGain();
      node.connect(dryG); dryG.connect(sum);
      node.connect(conv); conv.connect(wetG); wetG.connect(sum);
      outNode = sum;
    }

    // Master kompresör
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.12;
    outNode.connect(comp);
    comp.connect(ctx.destination);

    let rendered = await ctx.startRendering();
    rendered = normalizeBuffer(rendered, 0.95);
    rendered = trimTail(rendered, 0.0008, 0.25);
    return rendered;
  }

  return { PRESETS, renderWithPreset, encodeWav, pitchShiftBuffer };
})();
