'use strict';

/* ============ VoiceForge UI ============ */

const $ = (id) => document.getElementById(id);

const state = {
  audioCtx: null,
  sourceBuffer: null,
  sourceName: null,
  presetKey: null,
  rendered: null,
  playingNode: null,
  renderToken: 0,
  recorder: null,
  recChunks: [],
  recTimer: null,
  ttsAvailable: false,
};

function getCtx() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioCtx;
}

/* ---------- Sekmeler ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.classList.contains('disabled')) return;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

/* ---------- Kaynak yükleme ---------- */
async function setSourceFromArrayBuffer(arrayBuf, name) {
  try {
    const buf = await getCtx().decodeAudioData(arrayBuf);
    state.sourceBuffer = buf;
    state.sourceName = name;
    state.rendered = null;
    $('source-card').classList.remove('hidden');
    $('source-name').textContent = name;
    $('source-meta').textContent = `${buf.duration.toFixed(1)} sn · ${buf.sampleRate} Hz · ${buf.numberOfChannels} kanal`;
    $('play-btn').disabled = true;
    $('download-btn').disabled = true;
    setStatus('Kaynak hazır — karakter seç.', '');
    if (buf.duration > 60) setStatus('Kaynak hazır (uzun dosya — işlem yavaş olabilir).', '');
    // Preset seçiliyse otomatik yeniden render
    if (state.presetKey) renderCurrent();
  } catch (e) {
    console.error(e);
    setStatus('Dosya çözülemedi — desteklenen bir ses/video dosyası seç.', 'error');
  }
}

/* Dosya */
const dropzone = $('dropzone');
dropzone.addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await setSourceFromArrayBuffer(await f.arrayBuffer(), f.name);
  e.target.value = '';
});
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) await setSourceFromArrayBuffer(await f.arrayBuffer(), f.name);
});

/* Mikrofon */
$('rec-btn').addEventListener('click', async () => {
  const btn = $('rec-btn');
  if (state.recorder && state.recorder.state === 'recording') {
    state.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recChunks = [];
    state.recorder.ondataavailable = (e) => { if (e.data.size) state.recChunks.push(e.data); };
    state.recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(state.recTimer);
      $('rec-time').classList.add('hidden');
      btn.classList.remove('recording');
      btn.textContent = '● Kayda Başla';
      const blob = new Blob(state.recChunks, { type: state.recorder.mimeType || 'audio/webm' });
      await setSourceFromArrayBuffer(await blob.arrayBuffer(), 'mikrofon_kaydi');
    };
    state.recorder.start();
    btn.classList.add('recording');
    btn.textContent = '■ Kaydı Bitir';
    const t0 = Date.now();
    $('rec-time').classList.remove('hidden');
    state.recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      $('rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 250);
  } catch (e) {
    console.error(e);
    setStatus('Mikrofona erişilemedi — tarayıcı izinlerini kontrol et.', 'error');
  }
});

/* TTS */
async function initTts() {
  try {
    const res = await fetch('/voices');
    if (!res.ok) throw new Error('no server');
    const voices = await res.json();
    if (!voices.length) throw new Error('no voices');
    // İngilizce sesler önce (boss replikleri çoğunlukla İngilizce)
    voices.sort((a, b) => {
      const ae = a.culture.startsWith('en') ? 0 : 1;
      const be = b.culture.startsWith('en') ? 0 : 1;
      return ae - be || a.name.localeCompare(b.name);
    });
    const sel = $('tts-voice');
    sel.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      const gender = v.gender === 'Male' ? 'Erkek' : v.gender === 'Female' ? 'Kadın' : v.gender;
      opt.textContent = `${v.name.replace('Microsoft ', '').replace(' Desktop', '')} (${gender}, ${v.culture})`;
      sel.appendChild(opt);
    }
    const male = voices.find((v) => v.gender === 'Male' && v.culture.startsWith('en'));
    if (male) sel.value = male.name;
    state.ttsAvailable = true;
  } catch {
    state.ttsAvailable = false;
    const tab = document.querySelector('[data-tab="tts"]');
    tab.classList.add('disabled');
    tab.title = 'TTS için uygulamayı start.ps1 (server.py) ile başlat';
  }
}

$('tts-rate').addEventListener('input', () => { $('tts-rate-val').textContent = $('tts-rate').value; });

$('tts-btn').addEventListener('click', async () => {
  const text = $('tts-text').value.trim();
  if (!text) { $('tts-status').textContent = 'Önce bir cümle yaz.'; return; }
  $('tts-btn').disabled = true;
  $('tts-status').textContent = 'Sentezleniyor…';
  try {
    const res = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: $('tts-voice').value, rate: parseInt($('tts-rate').value, 10) }),
    });
    if (!res.ok) throw new Error('TTS sunucu hatası: ' + res.status);
    const ab = await res.arrayBuffer();
    const shortName = text.length > 30 ? text.slice(0, 30) + '…' : text;
    await setSourceFromArrayBuffer(ab, `"${shortName}"`);
    $('tts-status').textContent = '';
  } catch (e) {
    console.error(e);
    $('tts-status').textContent = 'Sentez başarısız — sunucunun çalıştığından emin ol.';
  } finally {
    $('tts-btn').disabled = false;
  }
});

/* ---------- Preset grid ---------- */
function buildPresetGrid() {
  const grid = $('preset-grid');
  for (const [key, p] of Object.entries(VoiceEngine.PRESETS)) {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.dataset.key = key;
    card.innerHTML = `<span class="preset-emoji">${p.emoji}</span>` +
      `<span class="preset-name">${p.name}</span>` +
      `<span class="preset-desc">${p.desc}</span>`;
    card.addEventListener('click', () => selectPreset(key));
    grid.appendChild(card);
  }
}

function selectPreset(key) {
  if (!state.sourceBuffer) {
    setStatus('Önce bir kaynak ses yükle (dosya, mikrofon ya da metin).', 'error');
    return;
  }
  state.presetKey = key;
  document.querySelectorAll('.preset-card').forEach((c) =>
    c.classList.toggle('selected', c.dataset.key === key));
  const p = VoiceEngine.PRESETS[key];
  // Slider varsayılanları
  $('pitch').value = 0; $('pitch-val').textContent = '0';
  $('intensity').value = p.intensityDefault; $('intensity-val').textContent = p.intensityDefault;
  const rv = Math.round((p.reverb ? p.reverb.wet : 0) * 100);
  $('reverb').value = rv; $('reverb-val').textContent = rv;
  $('tune-panel').classList.remove('hidden');
  renderCurrent();
}

/* ---------- Slider'lar ---------- */
let sliderDebounce = null;
for (const id of ['pitch', 'intensity', 'reverb']) {
  $(id).addEventListener('input', () => {
    $(id + '-val').textContent = $(id).value;
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(renderCurrent, 300);
  });
}

/* ---------- Render & çalma ---------- */
function setStatus(msg, cls) {
  const el = $('output-status');
  el.textContent = msg;
  el.className = 'output-status' + (cls ? ' ' + cls : '');
  $('output-bar').classList.remove('hidden');
}

async function renderCurrent() {
  if (!state.sourceBuffer || !state.presetKey) return;
  const token = ++state.renderToken;
  setStatus('İşleniyor…', 'busy');
  $('play-btn').disabled = true;
  $('download-btn').disabled = true;
  // UI'ın nefes alması için bir frame bekle (pitch shift senkron CPU işi)
  await new Promise((r) => setTimeout(r, 30));
  try {
    const user = {
      pitch: parseFloat($('pitch').value),
      intensity: parseFloat($('intensity').value),
      reverbWet: parseFloat($('reverb').value) / 100,
    };
    const out = await VoiceEngine.renderWithPreset(state.sourceBuffer, state.presetKey, user);
    if (token !== state.renderToken) return; // bu render eskidi
    state.rendered = out;
    const p = VoiceEngine.PRESETS[state.presetKey];
    setStatus(`${p.emoji} ${p.name} hazır (${out.duration.toFixed(1)} sn)`, 'ready');
    $('play-btn').disabled = false;
    $('download-btn').disabled = false;
    playBuffer(out);
  } catch (e) {
    console.error(e);
    if (token === state.renderToken) setStatus('İşleme hatası: ' + e.message, 'error');
  }
}

function stopPlayback() {
  if (state.playingNode) {
    try { state.playingNode.onended = null; state.playingNode.stop(); } catch {}
    state.playingNode = null;
  }
  $('play-btn').textContent = '▶ Çal';
}

function playBuffer(buffer) {
  stopPlayback();
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => { state.playingNode = null; $('play-btn').textContent = '▶ Çal'; };
  src.start();
  state.playingNode = src;
  $('play-btn').textContent = '⏹ Durdur';
}

$('play-btn').addEventListener('click', () => {
  if (state.playingNode) stopPlayback();
  else if (state.rendered) playBuffer(state.rendered);
});

$('play-original').addEventListener('click', () => {
  if (state.sourceBuffer) playBuffer(state.sourceBuffer);
});

$('download-btn').addEventListener('click', () => {
  if (!state.rendered) return;
  const blob = VoiceEngine.encodeWav(state.rendered);
  const base = (state.sourceName || 'ses').replace(/\.[^.]+$/, '').replace(/[^\wçğıöşüÇĞİÖŞÜ\- ]/g, '').trim() || 'ses';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}_${state.presetKey}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

/* ---------- Başlat ---------- */
buildPresetGrid();
initTts();
