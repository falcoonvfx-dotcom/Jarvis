'use strict';
const $ = id => document.getElementById(id);
const appEl = $('app'), logEl = $('log');
const S = JSON.parse(localStorage.getItem('jarvis.settings') || '{}');
const cfg = Object.assign({ voiceId: '', title: 'sir', lang: 'en-US', autoSpeak: true, autoMic: false, code: '' }, S);
let history = JSON.parse(localStorage.getItem('jarvis.history') || '[]');
let state = 'idle', server = { chatReady: true, voiceReady: true }, busy = false, chatCtl = null, ttsCtl = null;
const saveCfg = () => localStorage.setItem('jarvis.settings', JSON.stringify(cfg));
const saveHist = () => localStorage.setItem('jarvis.history', JSON.stringify(history.slice(-40)));

function setState(s) {
  state = s; appEl.dataset.state = s;
  $('stateText').querySelector('span').textContent = { idle: 'ONLINE', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING' }[s];
}
function addMsg(who, text, cls = '') {
  const d = document.createElement('div'); d.className = 'm ' + cls;
  const sm = document.createElement('small'); sm.textContent = who;
  const p = document.createElement('span'); p.textContent = text;
  d.append(sm, p); logEl.append(d); logEl.scrollTop = logEl.scrollHeight; return p;
}
function renderHistory() {
  logEl.innerHTML = '';
  if (!history.length) addMsg('JARVIS', `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, ${cfg.title}. How may I assist you today?`);
  history.forEach(m => addMsg(m.role === 'user' ? 'YOU' : 'JARVIS', m.content, m.role === 'user' ? 'u' : ''));
}

// ---------- Audio (TTS playback + analyser) ----------
const audio = new Audio(); audio.preload = 'auto';
let actx, analyser, freq, unlocked = false;
function unlockAudio() {
  if (unlocked) return; unlocked = true;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser(); analyser.fftSize = 128; freq = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser); analyser.connect(actx.destination); actx.resume();
  } catch (e) { analyser = null; }
  audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='; audio.play().catch(() => {});
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

const hdr = () => Object.assign({ 'Content-Type': 'application/json' }, cfg.code ? { 'x-access-code': cfg.code } : {});
async function apiError(r) { let m = `Error ${r.status}`; try { m = (await r.json()).error || m; } catch (e) {} if (r.status === 401) openSettings('Enter your access code.'); return m; }

function stopSpeaking() { if (ttsCtl) ttsCtl.abort(); audio.pause(); audio.currentTime = 0; if (state === 'speaking') setState('idle'); }
async function speak(text) {
  if (!cfg.autoSpeak || !server.voiceReady || !text) return;
  stopSpeaking(); ttsCtl = new AbortController();
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: hdr(), signal: ttsCtl.signal, body: JSON.stringify({ text, voiceId: cfg.voiceId }) });
    if (!r.ok) throw new Error(await apiError(r));
    const url = URL.createObjectURL(await r.blob());
    audio.src = url; setState('speaking');
    await new Promise((res, rej) => { audio.onended = res; audio.onerror = () => rej(new Error('Audio playback failed')); audio.play().catch(rej); });
    URL.revokeObjectURL(url);
  } catch (e) {
    if (e.name !== 'AbortError') addMsg('SYSTEM', 'Voice unavailable: ' + e.message, 'e');
    return;
  } finally { if (state === 'speaking') setState('idle'); }
  if (cfg.autoMic && !busy) startListening();
}

// ---------- Chat ----------
async function ask(text) {
  text = text.trim(); if (!text || busy) return;
  stopSpeaking(); stopListening(); busy = true; $('txt').value = '';
  history.push({ role: 'user', content: text }); addMsg('YOU', text, 'u'); setState('thinking');
  const out = addMsg('JARVIS', '…'); let full = ''; chatCtl = new AbortController();
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: hdr(), signal: chatCtl.signal,
      body: JSON.stringify({ messages: history.slice(-20), now: new Date().toString() }) });
    if (!r.ok) throw new Error(await apiError(r));
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue; const d = l.slice(5).trim(); if (d === '[DONE]') continue;
        try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) { full += t; out.textContent = full; logEl.scrollTop = logEl.scrollHeight; } } catch (e) {}
      }
    }
    if (!full.trim()) throw new Error('Empty response from AI.');
    history.push({ role: 'assistant', content: full.trim() }); saveHist();
    busy = false; setState('idle'); await speak(full.trim());
  } catch (e) {
    history.pop(); saveHist();
    if (e.name !== 'AbortError') { out.parentElement.classList.add('e'); out.textContent = 'Apologies, ' + cfg.title + ': ' + e.message; }
    else out.parentElement.remove();
    setState('idle');
  } finally { busy = false; }
}

// ---------- Voice input ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null, heard = false;
function startListening() {
  if (!SR) return addMsg('SYSTEM', 'Speech recognition needs Chrome on Android (over HTTPS). You can still type.', 'e');
  if (busy) return; stopSpeaking(); unlockAudio();
  rec = new SR(); rec.lang = cfg.lang; rec.interimResults = true; rec.continuous = false; heard = false;
  rec.onstart = () => setState('listening');
  rec.onresult = ev => {
    let t = ''; for (const r of ev.results) t += r[0].transcript; $('txt').value = t; heard = true;
    if (ev.results[ev.results.length - 1].isFinal) { const f = t; rec.onend = null; setState('idle'); ask(f); }
  };
  rec.onerror = ev => {
    const m = { 'not-allowed': 'Microphone permission denied. Tap the lock icon in Chrome → Permissions → allow Microphone.', 'service-not-allowed': 'Speech service blocked. Use Chrome over HTTPS.', 'no-speech': '', 'aborted': '', 'network': 'Speech recognition needs an internet connection.', 'audio-capture': 'No microphone found.' }[ev.error];
    if (m) addMsg('SYSTEM', m, 'e'); setState('idle');
  };
  rec.onend = () => { if (state === 'listening') setState('idle'); };
  try { rec.start(); } catch (e) { setState('idle'); }
}
function stopListening() { if (rec) { rec.onend = null; try { rec.abort(); } catch (e) {} rec = null; } if (state === 'listening') setState('idle'); }
$('mic').onclick = () => state === 'listening' ? stopListening() : startListening();

// ---------- UI wiring ----------
$('send').onclick = () => ask($('txt').value);
$('txt').addEventListener('keydown', e => { if (e.key === 'Enter') ask($('txt').value); });
$('stop').onclick = () => { stopSpeaking(); if (chatCtl) chatCtl.abort(); stopListening(); };
function syncMute() { $('mute').textContent = cfg.autoSpeak ? '🔊' : '🔇'; $('autoSpeak').checked = cfg.autoSpeak; }
$('mute').onclick = () => { cfg.autoSpeak = !cfg.autoSpeak; if (!cfg.autoSpeak) stopSpeaking(); saveCfg(); syncMute(); };
document.querySelectorAll('#quick button').forEach(b => b.onclick = () => ask(b.dataset.q));
const clearChat = () => { stopSpeaking(); history = []; saveHist(); renderHistory(); };
$('clear').onclick = () => { clearChat(); $('cfgMsg').textContent = 'Conversation cleared.'; };

function openSettings(msg = '') {
  $('voiceId').value = cfg.voiceId; $('title').value = cfg.title; $('lang').value = cfg.lang;
  $('autoMic').checked = cfg.autoMic; $('code').value = cfg.code; syncMute();
  $('cfgMsg').textContent = msg; $('modal').classList.remove('hidden');
}
$('cfg').onclick = () => openSettings();
$('close').onclick = () => {
  cfg.voiceId = $('voiceId').value.trim(); cfg.title = $('title').value.trim() || 'sir'; cfg.lang = $('lang').value;
  cfg.autoSpeak = $('autoSpeak').checked; cfg.autoMic = $('autoMic').checked; cfg.code = $('code').value.trim();
  saveCfg(); syncMute(); $('modal').classList.add('hidden');
};
$('testVoice').onclick = async () => {
  cfg.voiceId = $('voiceId').value.trim(); const was = cfg.autoSpeak; cfg.autoSpeak = true; cfg.code = $('code').value.trim(); unlockAudio();
  $('cfgMsg').textContent = 'Testing voice…'; await speak(`All systems operational, ${$('title').value.trim() || 'sir'}.`);
  cfg.autoSpeak = was; $('cfgMsg').textContent = 'Test finished.';
};
let deferred; window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('install').classList.remove('hidden'); });
$('install').onclick = async () => { if (deferred) { deferred.prompt(); deferred = null; $('install').classList.add('hidden'); } };

// ---------- HUD data ----------
function tick() {
  const d = new Date(); $('time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  $('date').textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase();
}
setInterval(tick, 1000); tick();
const bar = (id, p) => $(id).style.width = Math.max(2, Math.min(100, p)) + '%';
function hud() {
  const c = navigator.hardwareConcurrency; if (c) { $('cpu').textContent = c + ' CORE'; bar('cpub', c * 12.5); }
  if (navigator.deviceMemory) { $('ram').textContent = navigator.deviceMemory + '+ GB'; bar('ramb', navigator.deviceMemory * 12.5); }
  else if (performance.memory) { const m = performance.memory; $('ram').textContent = Math.round(m.usedJSHeapSize / 1048576) + ' MB'; bar('ramb', m.usedJSHeapSize / m.jsHeapSizeLimit * 100); }
  const n = navigator.connection; if (n) { $('net').textContent = (n.rtt ?? '--') + ' ms'; bar('netb', 100 - Math.min(90, (n.rtt || 50) / 6)); }
  else $('net').textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
  $('status').innerHTML = navigator.onLine ? '<i class="dot"></i>NOMINAL' : '<i class="dot" style="background:#ff4d5e"></i>OFFLINE';
}
hud(); setInterval(hud, 5000); addEventListener('online', hud); addEventListener('offline', hud);
if (navigator.getBattery) navigator.getBattery().then(b => { const u = () => { $('bat').textContent = Math.round(b.level * 100) + '%' + (b.charging ? '⚡' : ''); bar('batb', b.level * 100); }; u(); b.onlevelchange = b.onchargingchange = u; });
else $('bat').textContent = 'N/A';
const wmo = c => c === 0 ? 'Clear' : c < 4 ? 'Cloudy' : c < 50 ? 'Fog' : c < 70 ? 'Rain' : c < 80 ? 'Snow' : c < 100 ? 'Showers' : 'Storm';
navigator.geolocation?.getCurrentPosition(async p => {
  try { const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.coords.latitude}&longitude=${p.coords.longitude}&current=temperature_2m,weather_code`)).json();
    $('wxT').textContent = Math.round(j.current.temperature_2m) + '°C'; $('wxD').textContent = wmo(j.current.weather_code); } catch (e) {}
}, () => { $('wxD').textContent = 'No location' }, { timeout: 8000, maximumAge: 3600000 });

// ---------- Canvases ----------
const bg = $('bg'), bx = bg.getContext('2d'); let P = [];
function sizeBg() { bg.width = innerWidth; bg.height = innerHeight; P = Array.from({ length: 55 }, () => ({ x: Math.random() * bg.width, y: Math.random() * bg.height, v: .15 + Math.random() * .5, r: Math.random() * 1.6 + .4 })); }
sizeBg(); addEventListener('resize', sizeBg);
const gl = $('globe').getContext('2d'); let rot = 0;
const wv = $('wave').getContext('2d'); let ph = 0;
function frame() {
  bx.clearRect(0, 0, bg.width, bg.height); bx.strokeStyle = 'rgba(25,184,255,.05)'; bx.lineWidth = 1;
  for (let x = 0; x < bg.width; x += 40) { bx.beginPath(); bx.moveTo(x, 0); bx.lineTo(x, bg.height); bx.stroke(); }
  for (let y = 0; y < bg.height; y += 40) { bx.beginPath(); bx.moveTo(0, y); bx.lineTo(bg.width, y); bx.stroke(); }
  bx.fillStyle = 'rgba(60,200,255,.7)'; for (const p of P) { p.y -= p.v; if (p.y < 0) { p.y = bg.height; p.x = Math.random() * bg.width; } bx.beginPath(); bx.arc(p.x, p.y, p.r, 0, 6.3); bx.fill(); }
  // globe
  rot += .012; gl.clearRect(0, 0, 120, 120); gl.strokeStyle = 'rgba(25,184,255,.8)'; gl.lineWidth = .8;
  gl.beginPath(); gl.arc(60, 60, 44, 0, 6.3); gl.stroke();
  for (let i = -3; i <= 3; i++) { const y = i * 12, w = Math.sqrt(44 * 44 - y * y); gl.beginPath(); gl.ellipse(60, 60 + y, w, w * .12, 0, 0, 6.3); gl.stroke(); }
  for (let i = 0; i < 6; i++) { const a = rot + i * Math.PI / 6; gl.beginPath(); gl.ellipse(60, 60, Math.abs(Math.cos(a)) * 44, 44, 0, 0, 6.3); gl.stroke(); }
  gl.fillStyle = '#5fd4ff'; for (let i = 0; i < 40; i++) { const a = rot * 1.3 + i * 2.4, b = Math.asin(((i * 37) % 80 - 40) / 44), z = Math.cos(b) * Math.cos(a); if (z > 0) { gl.beginPath(); gl.arc(60 + 44 * Math.cos(b) * Math.sin(a), 60 + 44 * Math.sin(b), 1.3, 0, 6.3); gl.fill(); } }
  gl.strokeStyle = 'rgba(25,184,255,.5)'; gl.beginPath(); gl.ellipse(60, 60, 58, 14, -.35, 0, 6.3); gl.stroke();
  // waveform ring around the reactor core
  wv.clearRect(0, 0, 300, 300); ph += .08; let lvl = 0;
  if (state === 'speaking' && analyser && !audio.paused) { analyser.getByteFrequencyData(freq); lvl = freq.reduce((a, b) => a + b, 0) / freq.length / 255; }
  else if (state === 'speaking') lvl = .25 + .2 * Math.sin(ph * 3);
  else if (state === 'listening') lvl = .2 + .15 * Math.abs(Math.sin(ph * 2));
  else if (state === 'thinking') lvl = .1;
  if (lvl > 0) {
    wv.strokeStyle = state === 'listening' ? '#ff6b7a' : '#7fe3ff'; wv.lineWidth = 2; wv.shadowColor = wv.strokeStyle; wv.shadowBlur = 10; wv.beginPath();
    for (let i = 0; i <= 120; i++) { const a = i / 120 * 6.283, k = freq && state === 'speaking' ? freq[i % 48] / 255 : Math.abs(Math.sin(i * .5 + ph * 3)); const r = 90 + (k * 30 + 4) * (lvl + .3) * (1 + .3 * Math.sin(a * 5 + ph)); const x = 150 + r * Math.cos(a), y = 150 + r * Math.sin(a); i ? wv.lineTo(x, y) : wv.moveTo(x, y); }
    wv.closePath(); wv.stroke(); wv.shadowBlur = 0;
  }
  requestAnimationFrame(frame);
}
frame();

// ---------- Boot ----------
(async () => {
  renderHistory(); syncMute();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    server = await (await fetch('/api/config')).json();
    if (!cfg.voiceId && server.defaultVoice) cfg.voiceId = '';
    if (server.needsCode) { const r = await fetch('/api/check', { headers: hdr() }); if (!r.ok) openSettings('Enter your access code to continue.'); }
    if (!server.chatReady) addMsg('SYSTEM', 'Server is missing GROQ_API_KEY. See README.', 'e');
    if (!server.voiceReady) addMsg('SYSTEM', 'Server is missing FISH_API_KEY - voice disabled.', 'e');
  } catch (e) { addMsg('SYSTEM', 'Cannot reach the JARVIS server. Is it running?', 'e'); }
})();
