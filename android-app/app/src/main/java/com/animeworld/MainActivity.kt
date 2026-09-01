package com.animeworld

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private val PORT = 8080
    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var tries = 0
    private var serverStarted = false

    private var mContentView: FrameLayout? = null
    private var mFullscreenContainer: FrameLayout? = null
    private var mCustomView: View? = null
    private var mCustomViewCallback: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        mContentView = FrameLayout(this)
        setContentView(mContentView)

        webView = WebView(this)
        mContentView?.addView(webView, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        val ws = webView.settings
        ws.javaScriptEnabled = true
        ws.domStorageEnabled = true
        ws.mediaPlaybackRequiresUserGesture = false
        ws.allowFileAccess = true
        webView.setBackgroundColor(android.graphics.Color.WHITE)

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    scheduleLoad()
                }
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
                val base = "http://127.0.0.1:$PORT"
                if (failingUrl == base || failingUrl == "$base/") {
                    scheduleLoad()
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                view?.evaluateJavascript(
                    "window.onerror=function(msg,url,line){AnimeBridge.logError(msg+' at '+url+':'+line);return true;};",
                    null
                )
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (mCustomView != null) {
                    callback.onCustomViewHidden()
                    return
                }
                mCustomView = view
                mCustomViewCallback = callback
                if (mFullscreenContainer == null) {
                    mFullscreenContainer = FrameLayout(this@MainActivity)
                    mFullscreenContainer?.setBackgroundColor(0xff000000.toInt())
                }
                mFullscreenContainer?.removeAllViews()
                mFullscreenContainer?.addView(view, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                mContentView?.addView(mFullscreenContainer, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                hideSystemUi()
            }

            override fun onHideCustomView() {
                if (mCustomView == null) return
                mFullscreenContainer?.removeView(mCustomView)
                mContentView?.removeView(mFullscreenContainer)
                mCustomView = null
                mCustomViewCallback?.onCustomViewHidden()
                mCustomViewCallback = null
                showSystemUi()
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val msg = "${message.sourceId()}:${message.lineNumber()} ${message.message()}"
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    android.util.Log.e("AnimeWorldWebView", msg)
                } else {
                    android.util.Log.d("AnimeWorldWebView", msg)
                }
                return true
            }
        }

        webView.addJavascriptInterface(AnimeBridge(), "AnimeBridge")

        if (!serverStarted) {
            serverStarted = true
            Thread {
                try {
                    Server(this@MainActivity).start()
                    android.util.Log.i("AnimeWorld", "Embedded server started on port $PORT")
                } catch (e: Exception) {
                    android.util.Log.e("AnimeWorld", "Failed to start embedded server", e)
                }
            }.start()
        }

        scheduleLoad()
    }

    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    private fun showSystemUi() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }

    private fun scheduleLoad() {
        if (tries++ > 120) {
            val html = "<html><body style='background:#0f1117;color:#e8e8ea;font:16px system-ui;padding:40px'><h2>AnimeWorld</h2><p>Could not reach the in-app server after multiple attempts.</p><p style='color:#9aa1b1'>Check that the app has storage/network permissions, then restart.</p></body></html>"
            webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            return
        }
        handler.postDelayed({
            webView.loadUrl("http://127.0.0.1:$PORT/")
        }, 500)
    }

    override fun onBackPressed() {
        if (mCustomView != null) {
            mCustomViewCallback?.onCustomViewHidden()
            return
        }
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    private inner class AnimeBridge {
        @JavascriptInterface
        fun openExternal(url: String) {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        data = Uri.parse(url)
                        type = "application/x-mpegURL"
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(Intent.createChooser(intent, "Play with"))
                } catch (e: Exception) {
                    // No activity can handle the intent.
                }
            }
        }

        @JavascriptInterface
        fun setDownloadService(active: Boolean) {
            runOnUiThread {
                val i = Intent(this@MainActivity, DownloadKeeperService::class.java)
                try {
                    if (active) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            startForegroundService(i)
                        } else {
                            startService(i)
                        }
                    } else {
                        stopService(i)
                    }
                } catch (e: Exception) {
                    // Service not available
                }
            }
        }

        @JavascriptInterface
        fun logError(msg: String) {
            runOnUiThread {
                android.widget.Toast.makeText(this@MainActivity, "JS Error: $msg", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
}
