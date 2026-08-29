package com.animeworld;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.appcompat.app.AppCompatActivity;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

public class MainActivity extends AppCompatActivity {
    private static final int PORT = 8080;
    private WebView webView;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int tries = 0;

    // Fullscreen (HTML5 video) support.
    private FrameLayout mContentView;
    private FrameLayout mFullscreenContainer;
    private View mCustomView;
    private WebChromeClient.CustomViewCallback mCustomViewCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mContentView = new FrameLayout(this);
        setContentView(mContentView);

        webView = new WebView(this);
        mContentView.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

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

        // Fullscreen: when the <video> element requests fullscreen, host it in
        // a dedicated overlay so it can use the whole screen.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (mCustomView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                mCustomView = view;
                mCustomViewCallback = callback;
                if (mFullscreenContainer == null) {
                    mFullscreenContainer = new FrameLayout(MainActivity.this);
                    mFullscreenContainer.setBackgroundColor(0xff000000);
                }
                mFullscreenContainer.removeAllViews();
                mFullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                mContentView.addView(mFullscreenContainer, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                if (mCustomView == null) return;
                mFullscreenContainer.removeView(mCustomView);
                mContentView.removeView(mFullscreenContainer);
                mCustomView = null;
                if (mCustomViewCallback != null) {
                    mCustomViewCallback.onCustomViewHidden();
                    mCustomViewCallback = null;
                }
                showSystemUi();
            }
        });

        // JS bridge so the frontend can launch an external video player and tell
        // the app when background downloads are active.
        webView.addJavascriptInterface(new AnimeBridge(), "AnimeBridge");

        // Start the embedded Python backend (server.py) on a background thread.
        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(this));
        }
        new Thread(() -> {
            Python.getInstance().getModule("server").callAttr("main");
        }).start();

        scheduleLoad();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void showSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }

    // Wait until the in-app backend is up, then point the WebView at it.
    private void scheduleLoad() {
        if (tries++ > 30) return; // ~15s max
        handler.postDelayed(() -> webView.loadUrl("http://127.0.0.1:" + PORT + "/"), 500);
    }

    @Override
    public void onBackPressed() {
        if (mCustomView != null) {
            if (mCustomViewCallback != null) mCustomViewCallback.onCustomViewHidden();
            return;
        }
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    // Called from JavaScript.
    private class AnimeBridge {
        // Open a (localhost HLS) video URL in whatever external player the user picks.
        @JavascriptInterface
        public void openExternal(final String url) {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(Uri.parse(url), "application/x-mpegURL");
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(Intent.createChooser(intent, "Play with"));
                } catch (Exception ignored) {
                    // No activity can handle the intent.
                }
            });
        }

        // Start/stop the foreground "download keeper" service so background downloads
        // survive the app being minimised. Called with `active=true` while any
        // episode is downloading, `false` once the queue drains.
        @JavascriptInterface
        public void setDownloadService(final boolean active) {
            runOnUiThread(() -> {
                Intent i = new Intent(MainActivity.this, DownloadKeeperService.class);
                try {
                    if (active) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
                        else startService(i);
                    } else {
                        stopService(i);
                    }
                } catch (Exception ignored) {
                    // Service not available (e.g. outside the app shell).
                }
            });
        }
    }
}
