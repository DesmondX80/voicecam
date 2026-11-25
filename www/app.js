'use strict';

// ---------- Äänikomennot ----------
const COMMANDS = {
  start: ['aloita', 'aloitus', 'kuvaa', 'nauhoita', 'tallenna', 'start', 'record', 'action'],
  stop: ['lopeta', 'stop', 'seis', 'valmis', 'loppu', 'done', 'cut'],
  again: ['uusi', 'uudestaan', 'again', 'new'],
};

// ---------- Elementit ----------
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const playback = $('playback');
const statusEl = $('status');
const heardEl = $('heard');
const timerEl = $('timer');
const btnInit = $('btnInit');
const btnRecord = $('btnRecord');
const resultEl = $('result');
const btnShare = $('btnShare');
const btnDownload = $('btnDownload');
const btnDiscard = $('btnDiscard');
const langEl = $('lang');
const maxLenEl = $('maxLen');
const delayEl = $('delay');
const withAudioEl = $('withAudio');

// ---------- Natiivi (Android-APK) ----------
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const NativeSpeech = isNative ? Cap.registerPlugin('SpeechRecognition') : null;
const NativeFs = isNative ? Cap.registerPlugin('Filesystem') : null;
const NativeShare = isNative ? Cap.registerPlugin('Share') : null;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- Tila ----------
let state = 'off'; // off | idle | countdown | recording | review
let stream = null;
let recorder = null;
let chunks = [];
let recordedFile = null;
let recordedUrl = null;
let startTime = 0;
let timerHandle = null;
let maxLenHandle = null;
let countdownHandle = null;
let audioCtx = null;
let wakeLock = null;

// ---------- Asetukset (per laite) ----------
const SETTINGS_KEY = 'voicecam.settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.lang) langEl.value = s.lang;
    if (s.maxLen) maxLenEl.value = s.maxLen;
    if (s.delay != null) delayEl.value = s.delay;
    withAudioEl.checked = !!s.withAudio;
  } catch (_) { /* ei tallennusta saatavilla */ }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      lang: langEl.value, maxLen: maxLenEl.value, delay: delayEl.value, withAudio: withAudioEl.checked,
    }));
  } catch (_) { /* ohitetaan */ }
}

function setStatus(text, rec = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('rec', rec);
}

// ---------- Äänimerkit (golfaaja on kaukana puhelimesta) ----------
function beep(freq = 880, ms = 150) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.25;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + ms / 1000);
}

// ---------- Kamera ----------
async function startCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    },
    audio: withAudioEl.checked,
  });
  preview.srcObject = stream;
  const s = stream.getVideoTracks()[0].getSettings();
  console.log('Kamera:', s.width, 'x', s.height, '@', s.frameRate, 'fps');
}

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* ei tuettu */ }
}

// ---------- Tallennus ----------
function requestStart() {
  if (state !== 'idle') return;
  const delay = Math.max(0, Number(delayEl.value) || 0);
  if (delay === 0) return startRecording();

  state = 'countdown';
  let left = delay;
  setStatus(`Alkaa ${left}…`);
  beep(660, 100);
  countdownHandle = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(countdownHandle);
      countdownHandle = null;
      state = 'idle';
      startRecording();
    } else {
      setStatus(`Alkaa ${left}…`);
      beep(660, 100);
    }
  }, 1000);
}

function startRecording() {
  if (state !== 'idle' || !stream) return;
  const mimeType = pickMimeType();
  chunks = [];
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 10_000_000,
    });
  } catch (e) {
    setStatus('Tallennus ei onnistu: ' + e.message);
    return;
  }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(500);

  state = 'recording';
  startTime = performance.now();
  btnRecord.classList.add('on');
  timerEl.hidden = false;
  setStatus('● Tallentaa', true);
  beep(1320, 200);

  timerHandle = setInterval(() => {
    timerEl.textContent = ((performance.now() - startTime) / 1000).toFixed(1) + ' s';
  }, 100);
  const maxLen = Math.max(2, Number(maxLenEl.value) || 10);
  maxLenHandle = setTimeout(stopRecording, maxLen * 1000);
}

function stopRecording() {
  if (state === 'countdown') {
    clearInterval(countdownHandle);
    countdownHandle = null;
    state = 'idle';
    setStatus('Valmis – sano "aloita"');
    return;
  }
  if (state !== 'recording' || !recorder) return;
  clearTimeout(maxLenHandle);
  clearInterval(timerHandle);
  recorder.stop();
  beep(440, 250);
}

function finishRecording() {
  const type = recorder.mimeType || 'video/webm';
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `golf-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  recordedFile = new File([blob], name, { type });
  recordedUrl = URL.createObjectURL(blob);
  recorder = null;
  chunks = [];

  state = 'review';
  btnRecord.classList.remove('on');
  timerEl.hidden = true;
  preview.hidden = true;
  playback.src = recordedUrl;
  playback.hidden = false;
  playback.play().catch(() => {});

  btnDownload.href = recordedUrl;
  btnDownload.download = name;
  const canShare = isNative || !!(navigator.canShare && navigator.canShare({ files: [recordedFile] }));
  btnShare.hidden = !canShare;

  $('controls').hidden = true;
  resultEl.hidden = false;
  setStatus(`Tallennettu (${(blob.size / 1e6).toFixed(1)} MB) – "uusi" jatkaa`);
}

function discard() {
  if (state !== 'review') return;
  playback.pause();
  playback.removeAttribute('src');
  playback.load();
  if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  recordedUrl = null;
  recordedFile = null;
  playback.hidden = true;
  preview.hidden = false;
  resultEl.hidden = true;
  $('controls').hidden = false;
  state = 'idle';
  setStatus('Valmis – sano "aloita"');
}

async function share() {
  if (!recordedFile) return;
  if (isNative) return nativeShare();
  try {
    await navigator.share({ files: [recordedFile], title: recordedFile.name });
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Jako epäonnistui – käytä "Tallenna laitteelle"');
  }
}

async function nativeShare() {
  try {
    setStatus('Valmistellaan jakoa…');
    const data = await blobToBase64(recordedFile);
    const { uri } = await NativeFs.writeFile({ path: recordedFile.name, data, directory: 'CACHE' });
    setStatus('Jaa video analyysisovellukseen');
    await NativeShare.share({ title: recordedFile.name, files: [uri], dialogTitle: 'Jaa lyöntivideo' });
  } catch (e) {
    if (!/cancel/i.test(e.message || '')) setStatus('Jako epäonnistui: ' + e.message);
  }
}

// Natiivisti tallennetaan puhelimen Documents/VoiceCam-kansioon.
async function nativeSave() {
  if (!recordedFile) return;
  try {
    setStatus('Tallennetaan…');
    const data = await blobToBase64(recordedFile);
    await NativeFs.writeFile({
      path: `VoiceCam/${recordedFile.name}`, data, directory: 'DOCUMENTS', recursive: true,
    });
    setStatus(`Tallennettu: Documents/VoiceCam/${recordedFile.name}`);
  } catch (e) {
    setStatus('Tallennus epäonnistui: ' + e.message);
  }
}

// ---------- Puheentunnistus ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
// Käsitelty kohta: tuloksen indeksi ja kuinka monta merkkiä siitä on jo käytetty.
let handled = { index: -1, len: 0 };

function matches(text, words) {
  return words.some((w) => new RegExp(`(^|\\s)${w}`, 'i').test(text));
}

function handleTranscript(text) {
  heardEl.textContent = `”${text}”`;
  if ((state === 'recording' || state === 'countdown') && matches(text, COMMANDS.stop)) { stopRecording(); return true; }
  if (state === 'idle' && matches(text, COMMANDS.start)) { requestStart(); return true; }
  if (state === 'review' && matches(text, COMMANDS.again)) { discard(); return true; }
  return false;
}

// Android: järjestelmän puheentunnistin pysähtyy hiljaisuuden jälkeen, joten se käynnistetään uudelleen.
let nativeHandledLen = 0;
let nativeStarting = false;

async function nativeListenOnce() {
  if (!listening || nativeStarting) return;
  nativeStarting = true;
  nativeHandledLen = 0;
  try {
    await NativeSpeech.start({ language: langEl.value, partialResults: true, popup: false, maxResults: 1 });
  } catch (_) { /* esim. "no match" – vahtiajastin käynnistää uudelleen */ }
  nativeStarting = false;
}

async function startNativeListening() {
  try {
    const { available } = await NativeSpeech.available();
    if (!available) { heardEl.textContent = 'Puheentunnistus ei saatavilla – käytä nappia'; return; }
    const perm = await NativeSpeech.requestPermissions();
    if (perm.speechRecognition !== 'granted') { heardEl.textContent = 'Mikrofonin käyttö estetty – käytä nappia'; return; }
  } catch (e) {
    heardEl.textContent = 'Puheentunnistus ei käynnisty: ' + e.message;
    return;
  }
  await NativeSpeech.addListener('partialResults', ({ matches: m }) => {
    const full = ((m && m[0]) || '').toLowerCase();
    if (full.length < nativeHandledLen) nativeHandledLen = 0; // tunnistin korjasi tekstiä
    const text = full.slice(nativeHandledLen).trim();
    if (text && handleTranscript(text)) nativeHandledLen = full.length;
  });
  await NativeSpeech.addListener('listeningState', ({ status }) => {
    if (status === 'stopped' && listening) setTimeout(nativeListenOnce, 200);
  });
  listening = true;
  nativeListenOnce();
  // Vahtiajastin: jos tunnistin on virheen takia pysähtynyt, käynnistä se uudelleen.
  setInterval(async () => {
    if (!listening || nativeStarting) return;
    try {
      const { listening: on } = await NativeSpeech.isListening();
      if (!on) nativeListenOnce();
    } catch (_) {}
  }, 2000);
}

function startListening() {
  if (isNative) { startNativeListening(); return; }
  if (!SR) {
    heardEl.textContent = 'Selain ei tue puheentunnistusta – käytä nappia';
    return;
  }
  recognition = new SR();
  recognition.lang = langEl.value;
  recognition.continuous = true;
  recognition.interimResults = true; // reagoidaan heti, ei odoteta lauseen loppua

  recognition.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (i < handled.index) continue;
      const full = ev.results[i][0].transcript.toLowerCase();
      // Sama komento ei laukea uudelleen välitulosten päivittyessä.
      const offset = i === handled.index ? handled.len : 0;
      const text = full.slice(offset).trim();
      if (text && handleTranscript(text)) handled = { index: i, len: full.length };
    }
  };
  recognition.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      listening = false;
      heardEl.textContent = 'Mikrofonin käyttö estetty – käytä nappia';
    }
  };
  recognition.onend = () => {
    handled = { index: -1, len: 0 };
    if (listening) setTimeout(() => { try { recognition.start(); } catch (_) {} }, 250);
  };

  listening = true;
  try { recognition.start(); } catch (_) {}
}

function restartListening() {
  if (isNative) { NativeSpeech.stop().catch(() => {}); return; } // uusi kieli otetaan käyttöön uudelleenkäynnistyksessä
  if (!recognition) return;
  recognition.lang = langEl.value;
  try { recognition.stop(); } catch (_) {} // onend käynnistää uudelleen
}

// ---------- Tapahtumat ----------
btnInit.addEventListener('click', async () => {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await startCamera();
  } catch (e) {
    setStatus('Kamera ei käynnisty: ' + e.message);
    return;
  }
  btnInit.hidden = true;
  btnRecord.hidden = false;
  state = 'idle';
  setStatus('Valmis – sano "aloita"');
  requestWakeLock();
  startListening();
});

btnRecord.addEventListener('click', () => {
  if (state === 'idle') requestStart();
  else stopRecording();
});
btnShare.addEventListener('click', share);
btnDownload.addEventListener('click', (e) => {
  if (!isNative) return; // selaimessa download-linkki hoitaa
  e.preventDefault();
  nativeSave();
});
btnDiscard.addEventListener('click', discard);

[langEl, maxLenEl, delayEl, withAudioEl].forEach((el) => el.addEventListener('change', saveSettings));
langEl.addEventListener('change', restartListening);
withAudioEl.addEventListener('change', () => {
  if (state === 'idle') startCamera().catch((e) => setStatus('Kamera ei käynnisty: ' + e.message));
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== 'off') requestWakeLock();
});

// ---------- Asennus (PWA) ----------
const btnInstall = $('btnInstall');
const iosInstall = $('iosInstall');
let installPrompt = null;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || navigator.standalone === true;

if (!isNative && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker:', e));
}

// Android / Chrome: oma asennusnappi
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  btnInstall.hidden = state !== 'off';
});
btnInstall.addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  btnInstall.hidden = true;
});
window.addEventListener('appinstalled', () => { btnInstall.hidden = true; });

// iPhone / iPad: Safari ei tarjoa asennusnappia, joten näytetään ohje
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let iosHintDismissed = false;
try { iosHintDismissed = localStorage.getItem('voicecam.iosHint') === '1'; } catch (_) {}
iosInstall.hidden = !(isIos && !isStandalone && !iosHintDismissed && !isNative);
$('btnIosClose').addEventListener('click', () => {
  iosInstall.hidden = true;
  try { localStorage.setItem('voicecam.iosHint', '1'); } catch (_) {}
});
btnInit.addEventListener('click', () => { btnInstall.hidden = true; iosInstall.hidden = true; });

loadSettings();
if (!window.isSecureContext) {
  setStatus('Avaa sivu HTTPS-osoitteesta');
}
