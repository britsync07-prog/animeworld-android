package com.animeworld;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebSettings;
import androidx.appcompat.app.AppCompatActivity;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

public class MainActivity extends AppCompatActivity {
    private static final int PORT = 8080;
    private WebView webView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int tries = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                scheduleLoad();
            }
            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                scheduleLoad();
            }
        });

        // Start the embedded Python backend (server.py) on a background thread.
        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(this));
        }
        new Thread(() -> {
            Python.getInstance().getModule("server").callAttr("main");
        }).start();

        scheduleLoad();
    }

    // Wait until the in-app backend is up, then point the WebView at it.
    private void scheduleLoad() {
        if (tries++ > 30) return; // ~15s max
        handler.postDelayed(() -> webView.loadUrl("http://127.0.0.1:" + PORT + "/"), 500);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
