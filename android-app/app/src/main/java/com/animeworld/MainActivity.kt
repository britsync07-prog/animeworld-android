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

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                scheduleLoad()
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
                scheduleLoad()
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
        }

        webView.addJavascriptInterface(AnimeBridge(), "AnimeBridge")

        if (!serverStarted) {
            serverStarted = true
            Thread {
                Server(this@MainActivity).start()
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
        if (tries++ > 30) return
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
    }
}
