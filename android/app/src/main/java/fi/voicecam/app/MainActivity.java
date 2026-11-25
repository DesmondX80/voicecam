package fi.voicecam.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Sovelluksen oma plugin: mikrofonin jako videon äänelle ja puheentunnistukselle.
        registerPlugin(MicSharePlugin.class);
        super.onCreate(savedInstanceState);
        // Näyttö pysyy päällä, kun puhelin on jalustalla.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
