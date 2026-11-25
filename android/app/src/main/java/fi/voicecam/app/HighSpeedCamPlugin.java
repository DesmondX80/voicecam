package fi.voicecam.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaCodec;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Hidastuskuvaus (Camera2 constrained high-speed, esim. 120/240/480 fps).
 *
 * WebView:n kamera (getUserMedia) antaa vain tavalliset kuvanopeudet, joten hidastustilassa
 * esikatselu ja tallennus tehdään natiivisti: TextureView WebView:n alla (WebView läpinäkyvä)
 * ja MediaRecorder pysyvän syötepinnan kautta. Video tallennetaan ilman ääntä – ääni tulee
 * MicShare-pluginilta (sama mikrofoni myös puheentunnistukselle) ja liitetään JS:ssä.
 *
 * Golf-tilaa varten esikatselusta mitataan liike (pieni harmaasävykuva ~30 krt/s).
 */
@CapacitorPlugin(
    name = "HighSpeedCam",
    permissions = { @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }) }
)
public class HighSpeedCamPlugin extends Plugin {
    private static final String TAG = "HighSpeedCam";

    private CameraManager cameraManager;
    private HandlerThread camThread;
    private Handler camHandler;
    private final Handler main = new Handler(Looper.getMainLooper());

    private TextureView textureView;
    private CameraDevice device;
    private CameraConstrainedHighSpeedCaptureSession session;
    private Surface previewSurface;
    private Surface recorderSurface; // pysyvä syötepinta, sama kaikille tallennuksille
    private MediaRecorder recorder;
    private File outFile;

    // Nykyinen tila
    private String cameraId;
    private Size size;
    private int fps;
    private int sensorOrientation;
    private boolean frontFacing;
    private boolean active = false;     // JS on käynnistänyt kameran
    private boolean recording = false;
    private long recStartWall;

    // Liikemittaus
    private boolean motionOn = false;
    private Bitmap motionBitmap;
    private int[] prevGray;
    private final List<double[]> motion = new ArrayList<>();

    @Override
    public void load() {
        cameraManager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
    }

    // ---------- tilojen listaus ----------

    @PluginMethod
    public void getModes(PluginCall call) {
        JSArray modes = new JSArray();
        try {
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics c = cameraManager.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                String facingName = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT ? "user" : "environment";
                float[] focals = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                float focal = focals != null && focals.length > 0 ? focals[0] : 0;
                int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                StreamConfigurationMap map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
                if (map == null) continue;

                // Hidastustilat (vain kiinteät nopeudet, esim. [240, 240])
                if (contains(caps, CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO)) {
                    for (Size s : map.getHighSpeedVideoSizes()) {
                        for (Range<Integer> r : map.getHighSpeedVideoFpsRangesFor(s)) {
                            if (!r.getLower().equals(r.getUpper())) continue;
                            modes.put(mode("highspeed", id, facingName, s.getWidth(), s.getHeight(), r.getUpper(), focal));
                        }
                    }
                }

                // Tavallinen tila: suurin kiinteä nopeus
                Range<Integer>[] ranges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
                int maxFixed = 30;
                if (ranges != null) for (Range<Integer> r : ranges) {
                    if (r.getLower().equals(r.getUpper())) maxFixed = Math.max(maxFixed, r.getUpper());
                }
                modes.put(mode("normal", id, facingName, 1920, 1080, maxFixed, focal));
            }
        } catch (Exception e) {
            Log.e(TAG, "getModes failed", e);
        }
        JSObject r = new JSObject();
        r.put("modes", modes);
        call.resolve(r);
    }

    private static JSObject mode(String kind, String id, String facing, int w, int h, int fps, float focal) {
        JSObject m = new JSObject();
        m.put("kind", kind);
        m.put("cameraId", id);
        m.put("facing", facing);
        m.put("width", w);
        m.put("height", h);
        m.put("fps", fps);
        m.put("focal", focal);
        return m;
    }

    private static boolean contains(int[] arr, int v) {
        if (arr == null) return false;
        for (int x : arr) if (x == v) return true;
        return false;
    }

    // ---------- käynnistys / lopetus ----------

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) doStart(call);
        else call.reject("camera permission denied");
    }

    private void doStart(PluginCall call) {
        String id = call.getString("cameraId");
        Integer w = call.getInt("width"), h = call.getInt("height"), f = call.getInt("fps");
        if (id == null || w == null || h == null || f == null) { call.reject("cameraId, width, height, fps required"); return; }
        closeCamera();
        cameraId = id;
        size = new Size(w, h);
        fps = f;
        active = true;
        ensureThread();
        main.post(() -> {
            ensureTextureView();
            if (textureView.isAvailable()) openCamera(call);
            else pendingOpen = call;
        });
    }

    private PluginCall pendingOpen;

    @PluginMethod
    public void stop(PluginCall call) {
        active = false;
        closeCamera();
        main.post(() -> {
            if (textureView != null) {
                ((ViewGroup) textureView.getParent()).removeView(textureView);
                textureView = null;
            }
            WebView wv = getBridge().getWebView();
            wv.setBackgroundColor(Color.WHITE);
        });
        call.resolve();
    }

    private void ensureThread() {
        if (camThread != null) return;
        camThread = new HandlerThread("HighSpeedCam");
        camThread.start();
        camHandler = new Handler(camThread.getLooper());
    }

    private void ensureTextureView() {
        WebView wv = getBridge().getWebView();
        wv.setBackgroundColor(Color.TRANSPARENT); // esikatselu näkyy läpinäkyvän WebView:n alta
        if (textureView != null) return;
        textureView = new TextureView(getContext());
        ViewGroup parent = (ViewGroup) wv.getParent();
        parent.addView(textureView, 0, new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        textureView.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
                configureTransform(w, h);
                if (pendingOpen != null) { PluginCall c = pendingOpen; pendingOpen = null; openCamera(c); }
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { configureTransform(w, h); }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) { }
        });
        textureView.addOnLayoutChangeListener((View v, int l, int t, int r, int b, int ol, int ot, int or, int ob) ->
            configureTransform(r - l, b - t));
    }

    @SuppressLint("MissingPermission")
    private void openCamera(PluginCall call) {
        try {
            CameraCharacteristics c = cameraManager.getCameraCharacteristics(cameraId);
            Integer so = c.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = so != null ? so : 90;
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            frontFacing = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
            configureTransform(textureView.getWidth(), textureView.getHeight());

            cameraManager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice d) {
                    device = d;
                    createSession(call);
                }
                @Override public void onDisconnected(CameraDevice d) { d.close(); device = null; }
                @Override public void onError(CameraDevice d, int error) {
                    d.close();
                    device = null;
                    if (call != null) call.reject("camera error " + error);
                }
            }, camHandler);
        } catch (Exception e) {
            Log.e(TAG, "openCamera failed", e);
            if (call != null) call.reject("openCamera failed: " + e.getMessage());
        }
    }

    private void createSession(PluginCall call) {
        try {
            SurfaceTexture st = textureView.getSurfaceTexture();
            st.setDefaultBufferSize(size.getWidth(), size.getHeight());
            previewSurface = new Surface(st);
            if (recorderSurface == null) recorderSurface = MediaCodec.createPersistentInputSurface();
            // Pysyvä pinta pitää kytkeä koodaajaan ennen kuin kamera voi käyttää sitä.
            MediaRecorder primer = buildRecorder(new File(getContext().getCacheDir(), "hs-primer.mp4"));
            primer.release();

            device.createConstrainedHighSpeedCaptureSession(Arrays.asList(previewSurface, recorderSurface),
                new CameraCaptureSession.StateCallback() {
                    @Override public void onConfigured(CameraCaptureSession s) {
                        session = (CameraConstrainedHighSpeedCaptureSession) s;
                        try {
                            repeat(false);
                            JSObject r = new JSObject();
                            r.put("width", size.getWidth());
                            r.put("height", size.getHeight());
                            r.put("fps", fps);
                            if (call != null) call.resolve(r);
                        } catch (Exception e) {
                            Log.e(TAG, "preview failed", e);
                            if (call != null) call.reject("preview failed: " + e.getMessage());
                        }
                    }
                    @Override public void onConfigureFailed(CameraCaptureSession s) {
                        if (call != null) call.reject("high-speed session configuration failed");
                    }
                }, camHandler);
        } catch (Exception e) {
            Log.e(TAG, "createSession failed", e);
            if (call != null) call.reject("createSession failed: " + e.getMessage());
        }
    }

    /** Toistuva pyyntö: esikatselu, tallennuksen aikana myös koodaajan pinta. */
    private void repeat(boolean withRecorder) throws CameraAccessException {
        CaptureRequest.Builder b = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
        b.addTarget(previewSurface);
        if (withRecorder) b.addTarget(recorderSurface);
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, new Range<>(fps, fps));
        List<CaptureRequest> burst = session.createHighSpeedRequestList(b.build());
        session.setRepeatingBurst(burst, null, camHandler);
    }

    private MediaRecorder buildRecorder(File f) throws Exception {
        MediaRecorder r = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(getContext()) : new MediaRecorder();
        r.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        r.setOutputFile(f.getAbsolutePath());
        // Bittinopeus resoluution ja nopeuden mukaan (720p/120 ≈ 28 Mbit/s), rajattu 10–60 Mbit/s
        long bitrate = Math.max(10_000_000L, Math.min(60_000_000L, (long) size.getWidth() * size.getHeight() * fps / 4));
        r.setVideoEncodingBitRate((int) bitrate);
        r.setVideoFrameRate(fps);
        r.setVideoSize(size.getWidth(), size.getHeight());
        r.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
        r.setOrientationHint(orientationHint());
        r.setInputSurface(recorderSurface);
        r.prepare();
        return r;
    }

    private int orientationHint() {
        int rotation = getActivity().getWindowManager().getDefaultDisplay().getRotation();
        int deg = new int[] { 0, 90, 180, 270 }[rotation];
        return frontFacing ? (sensorOrientation + deg) % 360 : (sensorOrientation - deg + 360) % 360;
    }

    /** Esikatselu täyttää näkymän (kuten CSS object-fit: cover) ja on oikein päin. */
    private void configureTransform(int vw, int vh) {
        if (textureView == null || size == null || vw == 0 || vh == 0) return;
        int rotation = getActivity().getWindowManager().getDefaultDisplay().getRotation();
        Matrix m = new Matrix();
        float cx = vw / 2f, cy = vh / 2f;
        if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) {
            RectF viewRect = new RectF(0, 0, vw, vh);
            RectF bufferRect = new RectF(0, 0, size.getHeight(), size.getWidth());
            bufferRect.offset(cx - bufferRect.centerX(), cy - bufferRect.centerY());
            m.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL);
            float scale = Math.max((float) vh / size.getHeight(), (float) vw / size.getWidth());
            m.postScale(scale, scale, cx, cy);
            m.postRotate(90 * (rotation - 2), cx, cy);
        } else {
            float contentW = size.getHeight(), contentH = size.getWidth(); // pystyssä kuva on "kyljellään"
            float s = Math.max(vw / contentW, vh / contentH);
            m.setScale(s * contentW / vw, s * contentH / vh, cx, cy);
            if (rotation == Surface.ROTATION_180) m.postRotate(180, cx, cy);
        }
        textureView.setTransform(m);
    }

    // ---------- tallennus ----------

    @PluginMethod
    public void startRecording(PluginCall call) {
        if (session == null || device == null) { call.reject("camera not running"); return; }
        if (recording) { call.reject("already recording"); return; }
        boolean wantMotion = Boolean.TRUE.equals(call.getBoolean("motion", false));
        camHandler.post(() -> {
            try {
                if (outFile != null) outFile.delete();
                outFile = new File(getContext().getCacheDir(), "hs-" + System.currentTimeMillis() + ".mp4");
                recorder = buildRecorder(outFile);
                repeat(true);
                recorder.start();
                recStartWall = System.currentTimeMillis();
                recording = true;
                if (wantMotion) main.post(this::startMotion);
                JSObject r = new JSObject();
                r.put("startTime", recStartWall);
                call.resolve(r);
            } catch (Exception e) {
                Log.e(TAG, "startRecording failed", e);
                releaseRecorder();
                call.reject("startRecording failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopRecording(PluginCall call) {
        if (!recording) { call.reject("not recording"); return; }
        main.post(() -> {
            motionOn = false;
            JSArray mot = new JSArray();
            synchronized (motion) {
                for (double[] s : motion) {
                    JSArray p = new JSArray();
                    p.put(Double.valueOf(s[0])); // put(Object) ei heitä JSONExceptionia
                    p.put(Double.valueOf(s[1]));
                    mot.put(p);
                }
            }
            camHandler.post(() -> {
                try {
                    repeat(false);
                } catch (Exception e) {
                    Log.w(TAG, "preview-only repeat failed", e);
                }
                boolean ok = true;
                try { recorder.stop(); } catch (Exception e) { ok = false; Log.e(TAG, "recorder.stop failed", e); }
                releaseRecorder();
                recording = false;
                if (!ok) { call.reject("recording failed"); return; }
                JSObject r = new JSObject();
                r.put("path", outFile.getAbsolutePath());
                r.put("startTime", recStartWall);
                r.put("motion", mot);
                call.resolve(r);
            });
        });
    }

    private void releaseRecorder() {
        if (recorder != null) {
            try { recorder.release(); } catch (Exception ignored) { }
            recorder = null;
        }
    }

    // ---------- liikemittaus (golf) ----------

    private void startMotion() {
        synchronized (motion) { motion.clear(); }
        prevGray = null;
        int w = 96;
        int h = Math.max(1, Math.round(w * textureView.getHeight() / (float) Math.max(1, textureView.getWidth())));
        if (motionBitmap == null || motionBitmap.getWidth() != w || motionBitmap.getHeight() != h) {
            motionBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        }
        motionOn = true;
        main.post(motionTick);
    }

    private final Runnable motionTick = new Runnable() {
        @Override public void run() {
            if (!motionOn || textureView == null) return;
            try {
                textureView.getBitmap(motionBitmap);
                int w = motionBitmap.getWidth(), h = motionBitmap.getHeight();
                int[] px = new int[w * h];
                motionBitmap.getPixels(px, 0, w, 0, 0, w, h);
                int[] g = new int[px.length];
                for (int i = 0; i < px.length; i++) {
                    int c = px[i];
                    g[i] = (((c >> 16) & 255) * 77 + ((c >> 8) & 255) * 150 + (c & 255) * 29) >> 8;
                }
                if (prevGray != null) {
                    int changed = 0;
                    for (int i = 0; i < g.length; i++) if (Math.abs(g[i] - prevGray[i]) > 18) changed++;
                    synchronized (motion) {
                        motion.add(new double[] { System.currentTimeMillis() - recStartWall, changed / (double) g.length });
                    }
                }
                prevGray = g;
            } catch (Exception e) {
                Log.w(TAG, "motion sample failed: " + e.getMessage());
            }
            main.postDelayed(this, 33);
        }
    };

    // ---------- elinkaari ----------

    private void closeCamera() {
        motionOn = false;
        if (recording) {
            try { recorder.stop(); } catch (Exception ignored) { }
            releaseRecorder();
            recording = false;
        }
        try { if (session != null) session.close(); } catch (Exception ignored) { }
        session = null;
        try { if (device != null) device.close(); } catch (Exception ignored) { }
        device = null;
        if (previewSurface != null) { previewSurface.release(); previewSurface = null; }
    }

    @Override
    protected void handleOnPause() {
        if (active) {
            boolean wasRecording = recording;
            closeCamera();
            if (wasRecording) notifyListeners("interrupted", new JSObject());
        }
    }

    @Override
    protected void handleOnResume() {
        if (active && textureView != null && device == null) {
            ensureThread();
            main.post(() -> {
                if (textureView.isAvailable()) openCamera(null);
                else pendingOpen = null;
            });
        }
    }

    @Override
    protected void handleOnDestroy() {
        active = false;
        closeCamera();
        if (recorderSurface != null) { recorderSurface.release(); recorderSurface = null; }
        if (camThread != null) { camThread.quitSafely(); camThread = null; }
    }
}
