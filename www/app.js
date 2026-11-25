'use strict';

// ---------- Äänikomennot ----------
const COMMANDS = {
  start: ['aloita', 'aloitus', 'kuvaa', 'nauhoita', 'tallenna', 'start', 'record', 'action'],
  stop: ['lopeta', 'stop', 'seis', 'valmis', 'loppu', 'done', 'cut'],
  again: ['uusi', 'uudestaan', 'again', 'new'],
  flip: ['vaihda', 'käännä', 'kameran vaihto', 'switch', 'flip'],
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
const btnSwitch = $('btnSwitch');
const resultEl = $('result');
const btnShare = $('btnShare');
const btnDownload = $('btnDownload');
const langEl = $('lang');
const maxLenEl = $('maxLen');
const delayEl = $('delay');
const audioModeEl = $('audioMode');
const golfModeEl = $('golfMode');
const golfBadge = $('golfBadge');
const fpsModeEl = $('fpsMode');
const fpsBadge = $('fpsBadge');
const updateGolfBadge = () => { golfBadge.hidden = !golfModeEl.checked; };

// ---------- Natiivi (Android-APK) ----------
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const NativeSpeech = isNative ? Cap.registerPlugin('SpeechRecognition') : null;
const NativeFs = isNative ? Cap.registerPlugin('Filesystem') : null;
const NativeShare = isNative ? Cap.registerPlugin('Share') : null;
// Oma plugin: sama mikrofoni sekä videon ääneksi että puheentunnistukselle tallennuksen aikana
const NativeMic = isNative ? Cap.registerPlugin('MicShare') : null;
// Oma plugin: hidastuskuvaus (Camera2 high-speed), esim. 120/240/480 fps
const HighSpeed = isNative ? Cap.registerPlugin('HighSpeedCam') : null;

function base64ToBytes(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- Tila ----------
let state = 'off'; // off | idle | countdown | starting | recording | finishing | review
// Tila näkyy myös <body data-state>, jonka mukaan CSS näyttää oikeat ohjaimet.
function setState(s) {
  state = s;
  document.body.dataset.state = s;
}
let stream = null;
let recorder = null;
let micStream = null; // selaimen mikrofoni, varataan vain tallennuksen ajaksi
let micNative = false; // natiivi mikrofonijako käynnissä
let videoStartTime = 0;
let stopInfo = null;        // miten ja milloin tallennus pysäytettiin
let lastSpeechStart = 0;    // natiivin tunnistimen viimeisin puheen alku (Date.now)
let recordingGolf = false;

// ---------- Golf: liikkeen mittaus esikatselusta ----------
// Pieni harmaasävykuva jokaisesta kuvasta; mitataan muuttuneiden pikselien osuus edelliseen kuvaan.
const motionCanvas = document.createElement('canvas');
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
let motion = [];
let motionRunning = false;
let prevGray = null;

function startMotion() {
  const vw = preview.videoWidth || 640;
  const vh = preview.videoHeight || 360;
  const W = 96;
  const H = Math.max(1, Math.round((W * vh) / vw));
  motionCanvas.width = W;
  motionCanvas.height = H;
  motion = [];
  prevGray = null;
  motionRunning = true;
  const schedule = () => (preview.requestVideoFrameCallback
    ? preview.requestVideoFrameCallback(step)
    : requestAnimationFrame(step));
  const step = () => {
    if (!motionRunning) return;
    try {
      motionCtx.drawImage(preview, 0, 0, W, H);
      const d = motionCtx.getImageData(0, 0, W, H).data;
      const g = new Uint8Array(W * H);
      for (let i = 0; i < g.length; i++) g[i] = (d[4 * i] * 77 + d[4 * i + 1] * 150 + d[4 * i + 2] * 29) >> 8;
      if (prevGray) {
        let changed = 0;
        for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - prevGray[i]) > 18) changed++;
        motion.push({ t: Date.now() - videoStartTime, m: changed / g.length });
      }
      prevGray = g;
    } catch (_) { /* kuva ei vielä valmis */ }
    schedule();
  };
  schedule();
}
function stopMotion() { motionRunning = false; prevGray = null; }

// Lopeta-komennon alkukohta videon alusta (ms), tai Infinity jos pysäytettiin muuten kuin äänellä.
// Puheen alku saadaan natiivilta tunnistimelta; muuten arvio (tunnistus on ~1 s puhetta jäljessä).
function commandCutMs() {
  if (!stopInfo || stopInfo.reason !== 'voice') return Infinity;
  const sp = stopInfo.speechStart;
  const cutAt = sp && sp > stopInfo.at - 4000 && sp > videoStartTime ? sp - 150 : stopInfo.at - 1300;
  return cutAt - videoStartTime;
}

// Kaikki tallenteet: lopeta-komento leikataan pois lopusta.
function commandTrim() {
  const end = commandCutMs();
  return Number.isFinite(end) && end > 500 ? { trim: { startMs: 0, endMs: end }, note: '' } : { trim: null, note: '' };
}

// Golf: lyönnin tunnistus + lopeta-komennon poisto
function golfTrim() {
  if (!stopInfo) return { trim: null, note: '' };
  const endLimitMs = commandCutMs();
  let peakLimitMs = Infinity;
  if (stopInfo.reason === 'button') {
    peakLimitMs = stopInfo.at - videoStartTime - 2500; // käveltiin puhelimelle: ei etsitä piikkiä lopusta
  }
  const r = window.analyzeSwing ? window.analyzeSwing(motion, { endLimitMs, peakLimitMs }) : { found: false };
  console.log('Golf-analyysi', JSON.stringify(r), 'näytteitä', motion.length, 'pysäytys', stopInfo.reason);
  if (r.found) {
    return { trim: { startMs: r.startMs, endMs: r.endMs }, note: `Lyönti tunnistettu ✓ ${((r.endMs - r.startMs) / 1000).toFixed(1)} s` };
  }
  if (Number.isFinite(endLimitMs) && endLimitMs > 500) {
    return { trim: { startMs: 0, endMs: endLimitMs }, note: 'Lyöntiä ei tunnistettu – lopeta-komento leikattu' };
  }
  return { trim: null, note: 'Lyöntiä ei tunnistettu' };
}
let chunks = [];
let recordedFile = null;
let recordedUrl = null;
let startTime = 0;
let timerHandle = null;
let maxLenHandle = null;
let countdownHandle = null;
let audioCtx = null;
let wakeLock = null;
let facing = 'environment'; // environment = takakamera, user = etukamera

// ---------- Asetukset (per laite) ----------
const SETTINGS_KEY = 'voicecam.settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.lang) langEl.value = s.lang;
    if (s.maxLen) maxLenEl.value = s.maxLen;
    if (s.delay != null) delayEl.value = s.delay;
    if (s.facing === 'user' || s.facing === 'environment') facing = s.facing;
    if (['native', 'web', 'off'].includes(s.audioMode)) audioModeEl.value = s.audioMode;
    golfModeEl.checked = !!s.golf;
    if (s.fpsMode) savedFpsMode = s.fpsMode;
  } catch (_) { /* ei tallennusta saatavilla */ }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      lang: langEl.value, maxLen: maxLenEl.value, delay: delayEl.value, audioMode: audioModeEl.value, golf: golfModeEl.checked, fpsMode: fpsModeEl.value || savedFpsMode, facing,
    }));
  } catch (_) { /* ohitetaan */ }
}

function setStatus(text, rec = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('rec', rec);
}

// ---------- Äänimerkit (kuvattava voi olla kaukana puhelimesta) ----------
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

// Äänimerkki vain tallennuksen alkaessa ja loppuessa.
// APK: natiivi merkki hälytyskanavalla (kuuluu, vaikka järjestelmän piippaukset on mykistetty).
function cue(kind) {
  if (NativeMic) NativeMic.tone({ kind }).catch(() => beep(kind === 'start' ? 1320 : 440, 250));
  else beep(kind === 'start' ? 1320 : 440, kind === 'start' ? 200 : 250);
}

// Puheentunnistimen jatkuvat piippaukset pois, kun kamera on päällä (APK).
// Tallennetun videon toiston ajaksi äänet palautetaan.
function setBeepMute(on) {
  if (NativeMic) NativeMic.muteSystemBeeps({ mute: on }).catch(() => {});
}
playback.addEventListener('play', () => setBeepMute(false));
playback.addEventListener('pause', () => { if (state !== 'off') setBeepMute(true); });
playback.addEventListener('ended', () => { if (state !== 'off') setBeepMute(true); });

// ---------- Kamera ----------
// ---------- Kameratilat: paras = suurin fps ----------
let camModes = [];      // laitteen tilat natiivilta (tyhjä selaimessa)
let camKind = 'web';    // 'web' = getUserMedia, 'native' = hidastuskuvaus (HighSpeedCam)
let activeMode = null;
let savedFpsMode = 'auto';
const modeKey = (m) => `${m.kind}:${m.cameraId}:${m.width}x${m.height}@${m.fps}`;

function modesFor(f) {
  const all = camModes.filter((m) => m.facing === f);
  // Tavallisessa tilassa selainkamera ei voi valita linssiä: pidetään vain paras tavallinen tila.
  const normal = all.filter((m) => m.kind === 'normal').sort((a, b) => b.fps - a.fps || b.focal - a.focal)[0];
  const list = all.filter((m) => m.kind === 'highspeed').concat(normal ? [normal] : []);
  // 1. suurin fps, 2. suurin resoluutio, 3. pidempi polttoväli (pääkamera), 4. tavallinen tila
  return list.sort((a, b) => b.fps - a.fps || b.width * b.height - a.width * a.height
    || b.focal - a.focal || (a.kind === 'normal' ? -1 : 1));
}
function modeLabel(m) {
  const backs = camModes.filter((x) => x.facing === m.facing && x.kind === 'normal');
  const maxF = Math.max(...backs.map((x) => x.focal));
  const wide = m.kind === 'highspeed' && backs.length > 1 && m.focal < maxF * 0.7 ? ' · laajakulma' : '';
  return `${Math.min(m.width, m.height)}p · ${m.fps} fps${wide}`;
}
function chooseMode() {
  const list = modesFor(facing);
  if (!list.length) return null;
  const want = fpsModeEl.value || 'auto';
  return (want !== 'auto' && list.find((m) => modeKey(m) === want)) || list[0];
}
function populateFpsModes() {
  const list = modesFor(facing);
  const keep = fpsModeEl.value || savedFpsMode;
  fpsModeEl.innerHTML = '';
  const auto = new Option(`Paras automaattisesti${list[0] ? ` (${modeLabel(list[0])})` : ''}`, 'auto');
  fpsModeEl.add(auto);
  for (const m of list) fpsModeEl.add(new Option(modeLabel(m), modeKey(m)));
  fpsModeEl.value = list.some((m) => modeKey(m) === keep) ? keep : 'auto';
}
async function loadCameraModes() {
  if (!HighSpeed) return;
  try { camModes = (await HighSpeed.getModes()).modes || []; } catch (e) { console.warn('Kameratilat:', e); }
  console.log('Kameratilat', JSON.stringify(camModes));
  populateFpsModes();
}

async function startCamera() {
  const mode = chooseMode();
  activeMode = mode;
  if (mode && mode.kind === 'highspeed') {
    try {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; preview.srcObject = null; }
      await HighSpeed.start({ cameraId: mode.cameraId, width: mode.width, height: mode.height, fps: mode.fps });
      camKind = 'native';
      setNativeView(true);
      fpsBadge.textContent = `${mode.fps} fps`;
      fpsBadge.hidden = false;
      return;
    } catch (e) {
      console.warn('Hidastuskuvaus ei käynnistynyt, käytetään tavallista kameraa:', e);
    }
  }
  if (camKind === 'native') { await HighSpeed.stop().catch(() => {}); }
  camKind = 'web';
  setNativeView(false);
  await startWebCamera(mode ? mode.fps : 60);
}

// Natiivi esikatselu näkyy läpinäkyvän sivun alta
function setNativeView(on) {
  document.documentElement.classList.toggle('native-cam', on);
}

async function startWebCamera(fps) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  const video = (facingMode, frameRate) => ({
    facingMode, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate,
  });
  // Ensin vaaditaan laitteen paras nopeus (min), sitten toiveena; exact varmistaa kameran vaihdon.
  const attempts = [
    ...(isNative && fps > 30 ? [video({ exact: facing }, { min: fps, ideal: fps })] : []),
    video({ exact: facing }, { ideal: fps }),
    video({ ideal: facing }, { ideal: fps }),
  ];
  let lastErr;
  for (const v of attempts) {
    try {
      // Ei ääntä tässä: jos mikrofoni olisi varattu koko ajan, Android vaimentaisi puheentunnistuksen.
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!stream) throw lastErr;
  preview.srcObject = stream;
  // Etukameran esikatselu peilataan kuten peilissä; tallenne itsessään ei ole peilattu.
  preview.classList.toggle('mirror', facing === 'user');
  const st = stream.getVideoTracks()[0].getSettings();
  console.log('Kamera:', st.width, 'x', st.height, '@', st.frameRate, 'fps');
  fpsBadge.textContent = st.frameRate ? `${Math.round(st.frameRate)} fps` : '';
  fpsBadge.hidden = !st.frameRate;
}

function pickMimeType(recStream) {
  const audio = recStream.getAudioTracks().length > 0;
  const candidates = [
    // AAC-ääni on yhteensopivin muiden sovellusten kanssa, Opus varalla
    ...(audio ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus'] : ['video/mp4;codecs=avc1']),
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
const countdownEl = $('countdown');
function showCount(n) {
  countdownEl.textContent = n;
  countdownEl.classList.remove('tick');
  void countdownEl.offsetWidth; // käynnistää animaation uudelleen
  countdownEl.classList.add('tick');
}

function requestStart() {
  if (state !== 'idle') return;
  const delay = Math.max(0, Number(delayEl.value) || 0);
  if (delay === 0) return startRecording();

  setState('countdown');
  let left = delay;
  setStatus(`Alkaa ${left}…`);
  showCount(left);
  countdownHandle = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(countdownHandle);
      countdownHandle = null;
      setState('idle');
      startRecording();
    } else {
      setStatus(`Alkaa ${left}…`);
      showCount(left);
    }
  }, 1000);
}

function releaseMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
}

async function startRecording() {
  if (state !== 'idle' || (camKind === 'web' && !stream)) return;
  setState('starting');
  let recStream = stream;
  let mode = audioModeEl.value;
  // Natiiviin hidastusvideoon ääni tulee aina natiivilta mikrofonijaolta
  if (camKind === 'native' && mode === 'web') mode = 'native';
  if (mode === 'native' && !NativeMic) mode = 'web';
  if (mode === 'native') {
    // Natiivi plugin nauhoittaa äänen ja syöttää saman äänen puheentunnistukselle,
    // joten tavallinen tunnistus pysäytetään tallennuksen ajaksi.
    try {
      pauseIdleListening();
      const r = await NativeMic.start({ language: langEl.value });
      micNative = true;
      micStartTime = r.startTime;
      micHandledLen = 0;
    } catch (e) {
      console.warn('Natiivi mikrofoni ei käynnistynyt, käytetään selaimen mikrofonia:', e);
      micNative = false;
      resumeIdleListening();
      mode = camKind === 'native' ? 'off' : 'web';
    }
  }
  if (mode === 'web' && camKind === 'web') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
      recStream = new MediaStream([...stream.getVideoTracks(), ...micStream.getAudioTracks()]);
    } catch (e) {
      console.warn('Mikrofoni ei käytettävissä, tallennetaan ilman ääntä:', e);
      releaseMic();
    }
  }
  const cleanupFail = (msg) => {
    releaseMic();
    if (micNative) { micNative = false; NativeMic.stop().catch(() => {}); resumeIdleListening(); }
    setState('idle');
    setStatus(msg);
  };
  recordingGolf = golfModeEl.checked;
  if (camKind === 'native') {
    try {
      const r = await HighSpeed.startRecording({ motion: recordingGolf });
      videoStartTime = r.startTime;
    } catch (e) {
      cleanupFail('Tallennus ei onnistu: ' + e.message);
      return;
    }
  } else {
  const mimeType = pickMimeType(recStream);
  chunks = [];
  try {
    recorder = new MediaRecorder(recStream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 10_000_000,
      // Golf-tilassa tiheämmät avainkuvat -> leikkaus osuu lähelle oikeaa kohtaa
      ...(golfModeEl.checked ? { videoKeyFrameIntervalDuration: 500 } : {}),
    });
  } catch (e) {
    cleanupFail('Tallennus ei onnistu: ' + e.message);
    return;
  }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(500);
  videoStartTime = Date.now();
  if (recordingGolf) startMotion(); // natiivissa tilassa liike mitataan natiivisti
  }
  stopInfo = null;

  setState('recording');
  btnSwitch.hidden = true;
  startTime = performance.now();
  btnRecord.classList.add('on');
  timerEl.hidden = false;
  // Äänen kanssa mikrofoni on videon käytössä, joten "lopeta" ei kuulu: pysäytys napista tai ajastimella.
  setStatus(micStream ? '● Tallentaa – lopeta napista' : '● Tallentaa', true);
  cue('start');

  timerHandle = setInterval(() => {
    timerEl.textContent = ((performance.now() - startTime) / 1000).toFixed(1) + ' s';
  }, 100);
  const maxLen = Math.max(2, Number(maxLenEl.value) || 10);
  maxLenHandle = setTimeout(() => stopRecording('timer'), maxLen * 1000);
}

function stopRecording(reason = 'button') {
  if (state === 'countdown') {
    clearInterval(countdownHandle);
    countdownHandle = null;
    setState('idle');
    setStatus('Valmis – sano "aloita"');
    return;
  }
  if (state !== 'recording' || (camKind === 'web' && !recorder)) return;
  clearTimeout(maxLenHandle);
  clearInterval(timerHandle);
  stopInfo = { reason, at: Date.now(), speechStart: lastSpeechStart };
  if (camKind === 'native') finishRecording();
  else recorder.stop();
  cue('stop');
}

async function finishRecording() {
  setState('finishing');
  stopMotion();
  let nativeVideo = null;
  if (camKind === 'native') {
    try {
      nativeVideo = await HighSpeed.stopRecording();
      if (nativeVideo.motion) motion = nativeVideo.motion.map(([t, m]) => ({ t, m }));
    } catch (e) {
      console.warn('Hidastustallennus epäonnistui:', e);
    }
  }
  const golf = recordingGolf ? golfTrim() : commandTrim();
  releaseMic();
  let extraAudio = null;
  if (micNative) {
    micNative = false;
    try {
      const r = await NativeMic.stop();
      const bytes = base64ToBytes(r.data);
      const frames = [];
      let o = 0;
      for (const n of r.sizes) { frames.push(bytes.subarray(o, o + n)); o += n; }
      extraAudio = {
        asc: base64ToBytes(r.asc), frames, sampleRate: r.sampleRate, channels: r.channels, bitrate: r.bitrate,
        offsetMs: videoStartTime - r.startTime, // ääni käynnistyi ennen videota
      };
    } catch (e) {
      console.warn('Natiivin äänen lopetus epäonnistui:', e);
    }
    resumeIdleListening();
  }
  let ext, type, blob;
  if (camKind === 'native') {
    ext = 'mp4';
    type = 'video/mp4';
    if (!nativeVideo) { resetAfterFailure('Tallennus epäonnistui'); return; }
    const resp = await fetch(Cap.convertFileSrc('file://' + nativeVideo.path));
    blob = new Blob([await resp.arrayBuffer()], { type });
  } else {
    const recType = recorder.mimeType || 'video/webm';
    ext = recType.includes('mp4') ? 'mp4' : 'webm';
    type = ext === 'mp4' ? 'video/mp4' : 'video/webm';
    blob = new Blob(chunks, { type });
  }
  if (ext === 'mp4' && window.fixMp4) {
    // MediaRecorderin MP4 on pilkottu eikä siinä ole kestoa -> toisto takkuaa lopussa.
    // Muunnetaan tavalliseksi MP4:ksi (data säilyy ennallaan).
    try {
      setStatus('Viimeistellään videota…');
      const fixed = window.fixMp4(new Uint8Array(await blob.arrayBuffer()), { audio: extraAudio, trim: golf.trim });
      if (fixed) blob = new Blob([fixed], { type });
    } catch (e) {
      console.warn('MP4-korjaus epäonnistui, käytetään alkuperäistä:', e);
    }
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `voicecam-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  recordedFile = new File([blob], name, { type });
  recordedUrl = URL.createObjectURL(blob);
  recorder = null;
  chunks = [];

  setState('review');
  btnSwitch.hidden = false;
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

  resultEl.hidden = false;
  setStatus(golf.note || `Tallennettu (${(blob.size / 1e6).toFixed(1)} MB) – "aloita" kuvaa uuden`);
}

function resetAfterFailure(msg) {
  recorder = null;
  chunks = [];
  btnRecord.classList.remove('on');
  timerEl.hidden = true;
  btnSwitch.hidden = false;
  setState('idle');
  setStatus(msg);
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
  setState('idle');
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
    setStatus('Valitse sovellus');
    await NativeShare.share({ title: recordedFile.name, files: [uri], dialogTitle: 'Jaa video' });
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
  if ((state === 'idle' || state === 'review') && matches(text, COMMANDS.flip)) { switchCamera(); return true; }
  if ((state === 'recording' || state === 'countdown') && matches(text, COMMANDS.stop)) { stopRecording('voice'); return true; }
  if (state === 'idle' && matches(text, COMMANDS.start)) { requestStart(); return true; }
  // Tallennuksen jälkeen "aloita" aloittaa suoraan uuden tallenteen, "uusi" palaa kameraan.
  if (state === 'review' && matches(text, COMMANDS.start)) { discard(); requestStart(); return true; }
  if (state === 'review' && matches(text, COMMANDS.again)) { discard(); return true; }
  return false;
}

// Android: järjestelmän puheentunnistin pysähtyy hiljaisuuden jälkeen, joten se käynnistetään uudelleen.
let nativeHandledLen = 0;
let nativeStarting = false;
let micStartTime = 0;
let micHandledLen = 0;

// Tallennuksen ajaksi tavallinen tunnistus pois (MicShare kuuntelee samaa ääntä), sen jälkeen takaisin.
function pauseIdleListening() {
  if (!isNative) return;
  listening = false;
  NativeSpeech.stop().catch(() => {});
}
function resumeIdleListening() {
  if (!isNative || listening) return;
  listening = true;
  setTimeout(nativeListenOnce, 300);
}

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
  if (NativeMic) {
    await NativeMic.addListener('partialResults', ({ matches: m }) => {
      const full = ((m && m[0]) || '').toLowerCase();
      if (full.length < micHandledLen) micHandledLen = 0; // uusi tunnistusjakso
      const text = full.slice(micHandledLen).trim();
      if (text && handleTranscript(text)) micHandledLen = full.length;
    });
    await NativeMic.addListener('speechStart', (e) => { lastSpeechStart = e.time; });
    await NativeMic.addListener('speechError', (e) => console.log('MicShare puhevirhe', e.code, e.message));
  }
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

// ---------- Kameran vaihto ----------
let switching = false;
async function switchCamera() {
  if (switching || state === 'off' || state === 'recording' || state === 'countdown') return;
  if (state === 'review') discard();
  switching = true;
  const previous = facing;
  facing = facing === 'environment' ? 'user' : 'environment';
  setStatus(facing === 'user' ? 'Etukamera' : 'Takakamera');
  populateFpsModes();
  try {
    await startCamera();
    saveSettings();
  } catch (e) {
    facing = previous; // palataan entiseen, jos toista kameraa ei ole
    setStatus('Kameran vaihto ei onnistunut');
    await startCamera().catch(() => {});
  }
  switching = false;
  setTimeout(() => { if (state === 'idle') setStatus('Valmis – sano "aloita"'); }, 1200);
}

// ---------- Tapahtumat ----------
btnInit.addEventListener('click', async () => {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await loadCameraModes();
    await startCamera();
  } catch (e) {
    setStatus('Kamera ei käynnisty: ' + e.message);
    return;
  }
  setBeepMute(true);
  btnInit.hidden = true;
  btnRecord.hidden = false;
  btnSwitch.hidden = false;
  setState('idle');
  setStatus('Valmis – sano "aloita"');
  requestWakeLock();
  startListening();
});

btnRecord.addEventListener('click', () => {
  if (state === 'review') discard();
  if (state === 'idle') requestStart();
  else stopRecording('button');
});
btnShare.addEventListener('click', share);
$('btnClose').addEventListener('click', discard);

// Asetuspaneeli
const sheet = $('settings');
const sheetBackdrop = $('sheetBackdrop');
function openSettings(open) {
  sheet.classList.toggle('open', open);
  sheet.setAttribute('aria-hidden', String(!open));
  sheetBackdrop.hidden = !open;
}
$('btnSettings').addEventListener('click', () => openSettings(true));
$('btnSettingsDone').addEventListener('click', () => openSettings(false));
sheetBackdrop.addEventListener('click', () => openSettings(false));

// Paneelin sulkeminen pyyhkäisemällä alas. Vedon voi aloittaa otsikosta aina,
// muualta vain kun sisältö on vieritetty ylös (muuten pyyhkäisy vierittää sisältöä).
let dragY0 = null;
let dragDy = 0;
let dragT0 = 0;
sheet.addEventListener('touchstart', (e) => {
  if (!sheet.classList.contains('open') || e.target.closest('select, input')) return;
  const fromHead = e.target.closest('.grabber, .sheet-head');
  if (!fromHead && sheet.scrollTop > 0) return;
  dragY0 = e.touches[0].clientY;
  dragDy = 0;
  dragT0 = performance.now();
  sheet.style.transition = 'none';
}, { passive: true });
sheet.addEventListener('touchmove', (e) => {
  if (dragY0 === null) return;
  dragDy = Math.max(0, e.touches[0].clientY - dragY0);
  if (dragDy > 0) {
    e.preventDefault(); // ei vieritystä vedon aikana
    sheet.style.transform = `translateY(${dragDy}px)`;
    sheetBackdrop.style.opacity = String(Math.max(0, 1 - dragDy / (sheet.offsetHeight || 1)));
  }
}, { passive: false });
function endSheetDrag() {
  if (dragY0 === null) return;
  const velocity = dragDy / Math.max(1, performance.now() - dragT0); // px/ms
  sheet.style.transition = '';
  sheet.style.transform = '';
  sheetBackdrop.style.opacity = '';
  if (dragDy > 120 || (dragDy > 40 && velocity > 0.5)) openSettings(false);
  dragY0 = null;
}
sheet.addEventListener('touchend', endSheetDrag);
sheet.addEventListener('touchcancel', endSheetDrag);
btnSwitch.addEventListener('click', switchCamera);
btnDownload.addEventListener('click', (e) => {
  if (!isNative) return; // selaimessa download-linkki hoitaa
  e.preventDefault();
  nativeSave();
});

golfModeEl.addEventListener('change', updateGolfBadge);
fpsModeEl.addEventListener('change', () => {
  if (state === 'idle' || state === 'review') {
    if (state === 'review') discard();
    startCamera().catch((e) => setStatus('Kamera ei käynnisty: ' + e.message));
  }
});
// Natiivi tallennus keskeytyi (sovellus taustalle): palautetaan käyttöliittymä
if (HighSpeed) HighSpeed.addListener('interrupted', () => {
  if (state !== 'recording') return;
  clearTimeout(maxLenHandle);
  clearInterval(timerHandle);
  if (micNative) { micNative = false; NativeMic.stop().catch(() => {}); resumeIdleListening(); }
  resetAfterFailure('Tallennus keskeytyi');
});
[langEl, maxLenEl, delayEl, audioModeEl, golfModeEl, fpsModeEl].forEach((el) => el.addEventListener('change', saveSettings));
langEl.addEventListener('change', restartListening);

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

// Selaimessa natiivia mikrofonijakoa ei ole: oletuksena ääni pois, jotta komennot toimivat.
if (!isNative) {
  audioModeEl.querySelector('option[value="native"]').remove();
  audioModeEl.value = 'off';
}
loadSettings();
updateGolfBadge();
populateFpsModes();
if (!window.isSecureContext) {
  setStatus('Avaa sivu HTTPS-osoitteesta');
}
