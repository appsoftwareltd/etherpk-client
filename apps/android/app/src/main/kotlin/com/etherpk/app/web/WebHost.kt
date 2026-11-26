package com.etherpk.app.web

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import com.etherpk.app.R
import com.etherpk.app.Shell
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Frame
import com.etherpk.app.bridge.Port
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream

/** What the page's window asks of the activity. */
interface WebHostOwner {
    fun openExternal(url: String)
    fun historyChanged()
    fun chooseFiles(params: WebChromeClient.FileChooserParams, answer: ValueCallback<Array<Uri>>): Boolean
    fun showFullScreen(view: View, hidden: WebChromeClient.CustomViewCallback)
    fun hideFullScreen()
    /** The process that draws the page has died, and with it this WebView. */
    fun rendererGone(crashed: Boolean)
}

/**
 * The one WebView: what it may load, what answers it, and the port on its page. WebViewVersion has seen
 * that the device's WebView has the features used here.
 */
@SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
class WebHost(private val view: WebView, private val shell: Shell, private val owner: WebHostOwner) {
    private val assets = view.context.assets
    private val build = InstalledBuild { path ->
        try {
            assets.open("installed/$path")
        } catch (_: IOException) {
            null
        }
    }
    private var script: ScriptHandler? = null
    private var page: JavaScriptReplyProxy? = null
    /** Windows the page opened that have not gone anywhere yet. On the main thread. */
    private val popups = LinkedHashSet<WebView>()

    init {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false)
            setSupportMultipleWindows(true)
            // A pinch makes the page larger, as it does in a browser.
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        view.webViewClient = PageClient()
        view.webChromeClient = WindowClient()
        // The page registers no service worker on Android (Installed Build.md). Should anything register
        // one, its requests for the app's own address are still answered here, and never go to a
        // network where the address has no record.
        ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
            override fun shouldInterceptRequest(request: WebResourceRequest) = answer(request)
        })
        WebViewCompat.addWebMessageListener(view, "etherpkNativeMessages", setOf(APP_ORIGIN), ::received)
        putPortOnPages()
    }

    /** Has every later page of the app given the port, with what is true of the shell now. */
    fun putPortOnPages() {
        script?.remove()
        val template = view.resources.openRawResource(R.raw.port).use { it.readBytes().decodeToString() }
        script = WebViewCompat.addDocumentStartJavaScript(view, Port.script(template, shell.info()), setOf(APP_ORIGIN))
    }

    private fun received(@Suppress("UNUSED_PARAMETER") from: WebView, message: WebMessageCompat, origin: Uri, mainFrame: Boolean, reply: JavaScriptReplyProxy) {
        // The listener's origin rule has been applied by the WebView. A frame of the app's own origin
        // passes it, and is still not the app's page.
        if (!mainFrame || origin.toString() != APP_ORIGIN || message.type != WebMessageCompat.TYPE_ARRAY_BUFFER) return
        val bytes = message.arrayBuffer
        if (Frame.read(bytes)?.header?.optBoolean("hello") == true) {
            page = reply
            shell.pageStarted()
        }
        shell.port.receive(bytes) { answer -> view.post { if (page === reply) reply.postMessage(answer) } }
    }

    fun send(message: ByteArray) { page?.postMessage(message) }

    fun load(address: String) = view.loadUrl(APP_ORIGIN + address)

    private fun answer(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (!url.host.equals(APP_HOST, ignoreCase = true)) return null
        if (url.scheme != "https" || url.port != -1) return response(build.serve("GET", "/__native/", false))
        val path = url.encodedPath ?: "/"
        if (path.startsWith(Port.STREAM_PATH) && request.method == "GET" && !request.isForMainFrame) {
            shell.port.takeStream(path.removePrefix(Port.STREAM_PATH))?.let { return response(it) }
        }
        return response(build.serve(request.method, path, request.isForMainFrame))
    }

    private fun response(served: Served) = WebResourceResponse(served.mime, served.charset, served.status, served.reason, served.headers, served.body)

    /** Bytes the port promised. They are data and nothing else, whatever asks for them. */
    private fun response(content: Content): WebResourceResponse {
        val headers = mapOf(
            "Content-Length" to content.size.toString(),
            "Cache-Control" to "no-store",
            "X-Content-Type-Options" to "nosniff",
            "Content-Security-Policy" to "default-src 'none'; sandbox",
            "Cross-Origin-Resource-Policy" to "same-origin",
        )
        return WebResourceResponse("application/octet-stream", null, 200, "OK", headers, releasing(content))
    }

    private fun releasing(content: Content): InputStream = object : FilterInputStream(content.open()) {
        override fun close() {
            super.close()
            content.release()
        }
    }

    /** A link or a script wants [url] in this window or a new one. True when the page must not go there itself. */
    private fun leave(url: String): Boolean {
        if (isAppUrl(url)) return false
        openableUrl(url)?.let(owner::openExternal)
        return true
    }

    private inner class PageClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = answer(request)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            // A player's frame goes where it likes on the web, and nowhere else.
            if (!request.isForMainFrame) return request.url.scheme != "https" && request.url.scheme != "http"
            return leave(url)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) = owner.historyChanged()

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            page = null
            owner.rendererGone(detail.didCrash())
            return true
        }
    }

    private inner class WindowClient : WebChromeClient() {
        /** A new window is the browser for the web, and this window for the app's own pages. */
        override fun onCreateWindow(from: WebView, isDialog: Boolean, isUserGesture: Boolean, result: Message): Boolean {
            if (!isUserGesture) return false
            val popup = WebView(from.context)
            popups.add(popup)
            fun end() {
                if (popups.remove(popup)) popup.post { popup.destroy() }
            }
            fun taken(url: String) {
                if (!leave(url)) view.loadUrl(url)
                end()
            }
            // A window the page opens empty and gives an address later. One that never gets one, or
            // that the page closes, is let go.
            popup.webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) = end()
            }
            popup.postDelayed(::end, POPUP_WAIT_MS)
            popup.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    taken(request.url.toString())
                    return true
                }
                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    if (url != "about:blank") {
                        view.stopLoading()
                        taken(url)
                    }
                }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) = WebResourceResponse("text/plain", "utf-8", null)
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail) = true
            }
            (result.obj as WebView.WebViewTransport).webView = popup
            result.sendToTarget()
            return true
        }

        override fun onShowFileChooser(view: WebView, answer: ValueCallback<Array<Uri>>, params: FileChooserParams) = owner.chooseFiles(params, answer)
        override fun onShowCustomView(shown: View, hidden: CustomViewCallback) = owner.showFullScreen(shown, hidden)
        override fun onHideCustomView() = owner.hideFullScreen()
        /** The camera, the microphone and protected media: nothing in EtherPK uses them. */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
    }

    /** Stops answering for a WebView that is going. */
    fun destroy() {
        page = null
        popups.toList().forEach { it.destroy() }
        popups.clear()
        view.destroy()
    }
}

/** How long a window the page opened may wait for an address. */
private const val POPUP_WAIT_MS = 30_000L
