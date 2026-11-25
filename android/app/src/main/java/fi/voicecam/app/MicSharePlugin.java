package fi.voicecam.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Jakaa yhden mikrofonin kahteen käyttöön tallennuksen ajaksi:
 *  1) AAC-ääni videoon (palautetaan JS:lle, joka liittää sen MP4:ään)
 *  2) sama ääni puheentunnistimelle putken kautta (RecognizerIntent.EXTRA_AUDIO_SOURCE, Android 13+),
 *     jotta äänikomennot ("lopeta") toimivat tallennuksen aikana.
 * Android antaa mikrofonin vain yhdelle kaappaajalle kerrallaan, joten ilman tätä
 * joko video tai puheentunnistus jäisi ilman ääntä.
 */
@CapacitorPlugin(
    name = "MicShare",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class MicSharePlugin extends Plugin {
    private static final String TAG = "MicShare";
    private static final int RATE = 48000;      // videon ääni
    private static final int REC_RATE = 16000;  // puheentunnistimelle (RATE / 3)
    private static final int BITRATE = 128000;

    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile boolean running = false;
    private Thread captureThread;
    private Thread pipeThread;
    private AudioRecord audioRecord;
    private MediaCodec encoder;

    private final ByteArrayOutputStream aac = new ByteArrayOutputStream();
    private final List<Integer> frameSizes = new ArrayList<>();
    private byte[] asc;
    private long startWallMs;

    // Puheentunnistin (käytetään vain pääsäikeessä)
    private SpeechRecognizer recognizer;
    private String language = "fi-FI";
    private ParcelFileDescriptor pipeRead;
    private volatile FileOutputStream pipeOut;
    private ParcelFileDescriptor pipeWrite;
    private final BlockingQueue<byte[]> pipeQueue = new ArrayBlockingQueue<>(100); // ~2 s puskuri

    // ---------- järjestelmän piippausten mykistys + omat äänimerkit ----------
    // Androidin puheentunnistin piippaa joka kerta kun se käynnistyy uudelleen (muutaman sekunnin välein).
    // Mykistetään media-, ilmoitus- ja järjestelmäkanava kun kamera on päällä; palautetaan kun sovellus
    // menee taustalle. Omat aloitus/lopetus-merkit soitetaan hälytyskanavalla, joka ei ole mykistetty.
    private static final int[] BEEP_STREAMS = {
        AudioManager.STREAM_MUSIC, AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM
    };
    private final Set<Integer> mutedByUs = new HashSet<>();
    private boolean wantMute = false;
    private ToneGenerator toneGen;

    @PluginMethod
    public void muteSystemBeeps(PluginCall call) {
        wantMute = Boolean.TRUE.equals(call.getBoolean("mute", false));
        applyMute(wantMute);
        call.resolve();
    }

    private synchronized void applyMute(boolean mute) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        if (mute) {
            for (int s : BEEP_STREAMS) {
                try {
                    if (!mutedByUs.contains(s) && !am.isStreamMute(s)) {
                        am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, 0);
                        mutedByUs.add(s);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "mute stream " + s + " failed: " + e.getMessage()); // esim. Älä häiritse -tila
                }
            }
        } else {
            for (int s : mutedByUs) {
                try { am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, 0); } catch (Exception ignored) { }
            }
            mutedByUs.clear();
        }
    }

    @PluginMethod
    public void tone(PluginCall call) {
        boolean stop = "stop".equals(call.getString("kind", "start"));
        try {
            if (toneGen == null) toneGen = new ToneGenerator(AudioManager.STREAM_ALARM, 90);
            // Aloitus: yksi piippaus, lopetus: kaksi
            toneGen.startTone(stop ? ToneGenerator.TONE_PROP_BEEP2 : ToneGenerator.TONE_PROP_BEEP, stop ? 400 : 250);
        } catch (Exception e) {
            Log.w(TAG, "tone failed: " + e.getMessage());
        }
        call.resolve();
    }

    @Override
    protected void handleOnPause() { applyMute(false); }

    @Override
    protected void handleOnResume() { if (wantMute) applyMute(true); }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isRecognitionAvailable(getContext()));
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (running) { call.reject("already running"); return; }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermissionCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) doStart(call);
        else call.reject("microphone permission denied");
    }

    private void doStart(PluginCall call) {
        language = call.getString("language", "fi-FI");
        try {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE / 2));

            MediaFormat fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1);
            fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            fmt.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
            fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            encoder.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            encoder.start();

            synchronized (aac) { aac.reset(); frameSizes.clear(); }
            asc = null;
            pipeQueue.clear();

            audioRecord.startRecording();
            startWallMs = System.currentTimeMillis();
            running = true;
            captureThread = new Thread(this::captureLoop, "MicShare-capture");
            captureThread.start();
            pipeThread = new Thread(this::pipeLoop, "MicShare-pipe");
            pipeThread.start();
            main.post(this::startRecognizer);

            JSObject r = new JSObject();
            r.put("startTime", startWallMs);
            r.put("speech", Build.VERSION.SDK_INT >= 33);
            call.resolve(r);
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            running = false;
            releaseAudio();
            call.reject("start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!running) { call.reject("not running"); return; }
        running = false;
        new Thread(() -> {
            try {
                if (captureThread != null) captureThread.join(3000);
                if (pipeThread != null) pipeThread.join(1000);
            } catch (InterruptedException ignored) { }
            main.post(this::stopRecognizer);

            JSObject r = new JSObject();
            synchronized (aac) {
                r.put("data", Base64.encodeToString(aac.toByteArray(), Base64.NO_WRAP));
                JSArray sizes = new JSArray();
                for (int s : frameSizes) sizes.put(s);
                r.put("sizes", sizes);
            }
            r.put("asc", asc != null ? Base64.encodeToString(asc, Base64.NO_WRAP) : "");
            r.put("sampleRate", RATE);
            r.put("channels", 1);
            r.put("bitrate", BITRATE);
            r.put("startTime", startWallMs);
            releaseAudio();
            call.resolve(r);
        }, "MicShare-stop").start();
    }

    // ---------- kaappaus + AAC-koodaus ----------

    private void captureLoop() {
        short[] pcm = new short[RATE / 50]; // 20 ms
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        long samples = 0;
        try {
            while (running) {
                int n = audioRecord.read(pcm, 0, pcm.length);
                if (n <= 0) continue;

                // Koodaajalle: odotetaan vapaata puskuria, tyhjennetään ulostuloa välissä (ei pudoteta ääntä).
                int idx;
                while ((idx = encoder.dequeueInputBuffer(5000)) < 0) drain(info, false);
                ByteBuffer in = encoder.getInputBuffer(idx);
                in.clear();
                in.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm, 0, n);
                encoder.queueInputBuffer(idx, 0, n * 2, samples * 1_000_000L / RATE, 0);
                samples += n;
                drain(info, false);

                // Puheentunnistimelle 16 kHz (keskiarvo kolmesta näytteestä)
                int m = n / 3;
                byte[] down = new byte[m * 2];
                for (int i = 0; i < m; i++) {
                    int s = (pcm[3 * i] + pcm[3 * i + 1] + pcm[3 * i + 2]) / 3;
                    down[2 * i] = (byte) s;
                    down[2 * i + 1] = (byte) (s >> 8);
                }
                pipeQueue.offer(down); // jos tunnistin ei ehdi lukea, pudotetaan (video ei kärsi)
            }
            int idx = encoder.dequeueInputBuffer(100000);
            if (idx >= 0) {
                encoder.queueInputBuffer(idx, 0, 0, samples * 1_000_000L / RATE, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                drain(info, true);
            }
        } catch (Exception e) {
            Log.e(TAG, "capture failed", e);
        }
    }

    private void drain(MediaCodec.BufferInfo info, boolean untilEos) {
        int idle = 0;
        while (true) {
            int o = encoder.dequeueOutputBuffer(info, untilEos ? 10000 : 0);
            if (o == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!untilEos || ++idle > 100) return;
                continue;
            }
            if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                ByteBuffer csd = encoder.getOutputFormat().getByteBuffer("csd-0");
                if (csd != null && asc == null) { asc = new byte[csd.remaining()]; csd.get(asc); }
                continue;
            }
            if (o < 0) continue;
            ByteBuffer out = encoder.getOutputBuffer(o);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                if (asc == null && info.size > 0) {
                    asc = new byte[info.size];
                    out.position(info.offset);
                    out.get(asc);
                }
            } else if (info.size > 0) {
                byte[] f = new byte[info.size];
                out.position(info.offset);
                out.get(f);
                synchronized (aac) { aac.write(f, 0, f.length); frameSizes.add(f.length); }
            }
            encoder.releaseOutputBuffer(o, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    private void pipeLoop() {
        while (running) {
            try {
                byte[] b = pipeQueue.poll(100, TimeUnit.MILLISECONDS);
                FileOutputStream os = pipeOut;
                if (b != null && os != null) {
                    try { os.write(b); } catch (IOException e) { /* tunnistin sulki putken – uusi avataan */ }
                }
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    // ---------- puheentunnistus samasta äänestä ----------

    private void startRecognizer() {
        if (!running) return;
        if (Build.VERSION.SDK_INT < 33) { emitError(-1, "Android 13+ required for shared speech"); return; }
        try {
            ParcelFileDescriptor[] p = ParcelFileDescriptor.createPipe();
            closePipe();
            pipeRead = p[0];
            pipeWrite = p[1];
            pipeOut = new FileOutputStream(p[1].getFileDescriptor());

            if (recognizer == null) {
                recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
                recognizer.setRecognitionListener(listener);
            }
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
            i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, p[0]);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, REC_RATE);
            recognizer.startListening(i);
            Log.d(TAG, "recognizer session started (" + language + ")");
        } catch (Exception e) {
            Log.e(TAG, "recognizer start failed", e);
            emitError(-2, String.valueOf(e.getMessage()));
            main.postDelayed(this::startRecognizer, 1000);
        }
    }

    private void restartRecognizer(long delayMs) {
        if (running) main.postDelayed(this::startRecognizer, delayMs);
    }

    private void stopRecognizer() {
        if (recognizer != null) {
            try { recognizer.cancel(); recognizer.destroy(); } catch (Exception ignored) { }
            recognizer = null;
        }
        closePipe();
    }

    private void closePipe() {
        FileOutputStream os = pipeOut;
        pipeOut = null;
        try { if (os != null) os.close(); } catch (IOException ignored) { }
        try { if (pipeWrite != null) pipeWrite.close(); } catch (IOException ignored) { }
        try { if (pipeRead != null) pipeRead.close(); } catch (IOException ignored) { }
        pipeWrite = null;
        pipeRead = null;
    }

    private void emitMatches(Bundle b) {
        ArrayList<String> m = b != null ? b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) : null;
        if (m == null || m.isEmpty()) return;
        JSObject data = new JSObject();
        JSArray arr = new JSArray();
        for (String s : m) arr.put(s);
        data.put("matches", arr);
        notifyListeners("partialResults", data);
    }

    private void emitError(int code, String msg) {
        Log.w(TAG, "speech error " + code + ": " + msg);
        JSObject data = new JSObject();
        data.put("code", code);
        data.put("message", msg);
        notifyListeners("speechError", data);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle params) { Log.d(TAG, "ready for speech"); }
        @Override public void onBeginningOfSpeech() {
            // Puheen alkuhetki: golf-tilassa lopeta-komento leikataan tästä kohdasta pois
            JSObject data = new JSObject();
            data.put("time", System.currentTimeMillis());
            notifyListeners("speechStart", data);
        }
        @Override public void onRmsChanged(float rmsdB) { }
        @Override public void onBufferReceived(byte[] buffer) { }
        @Override public void onEndOfSpeech() { }
        @Override public void onPartialResults(Bundle partialResults) { emitMatches(partialResults); }
        @Override public void onEvent(int eventType, Bundle params) { }
        @Override public void onResults(Bundle results) {
            emitMatches(results);
            restartRecognizer(50);
        }
        @Override public void onError(int error) {
            emitError(error, "recognizer error");
            // 7 = NO_MATCH, 6 = SPEECH_TIMEOUT: normaalia, jatketaan heti
            restartRecognizer(error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? 50 : 500);
        }
    };

    private void releaseAudio() {
        try { if (audioRecord != null) { audioRecord.stop(); audioRecord.release(); } } catch (Exception ignored) { }
        audioRecord = null;
        try { if (encoder != null) { encoder.stop(); encoder.release(); } } catch (Exception ignored) { }
        encoder = null;
    }

    @Override
    protected void handleOnDestroy() {
        applyMute(false);
        if (toneGen != null) { toneGen.release(); toneGen = null; }
        running = false;
        main.post(this::stopRecognizer);
        releaseAudio();
    }
}
