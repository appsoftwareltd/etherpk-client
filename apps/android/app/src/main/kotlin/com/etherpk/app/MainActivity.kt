package com.etherpk.app

import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.etherpk.app.auth.BrowserSignIn
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.failed
import com.etherpk.app.files.OpenedDocument
import com.etherpk.app.files.SaveTarget
import com.etherpk.app.files.SavedDocument
import com.etherpk.app.web.WebHost
import com.etherpk.app.web.WebHostOwner
import com.etherpk.app.web.addressWithin
import java.util.concurrent.CompletableFuture

/** The app's one screen: the WebView, and what the system asks an activity for. */
class MainActivity : ComponentActivity(), Screen, WebHostOwner {
    private lateinit var shell: Shell
    private lateinit var frame: FrameLayout
    private lateinit var documents: Asker<Intent, androidx.activity.result.ActivityResult>
    private lateinit var files: Asker<Intent, androidx.activity.result.ActivityResult>
    override lateinit var signInBrowser: BrowserSignIn
        private set

    private var web: WebView? = null
    private var host: WebHost? = null
    private var fullScreen: View? = null
    private var fullScreenHidden: WebChromeClient.CustomViewCallback? = null
    private var dark = false
    /** The page's last address of the app's own, for when it is drawn again. */
    private var address = "/"
    private var knewAllFiles = false
    /** An intent that came while there was no page. */
    private var waiting: Intent? = null
    private val main = Handler(Looper.getMainLooper())
    private val rendererDeaths = ArrayDeque<Long>()

    /** On only while there is something to go back to, so that at the first page Android shows the app leaving. */
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (fullScreen != null) fullScreenHidden?.onCustomViewHidden() else web?.goBack()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        shell = (application as EtherpkApp).shell
        documents = Asker(this, StartActivityForResult())
        files = Asker(this, StartActivityForResult())
        signInBrowser = BrowserSignIn(this)
        onBackPressedDispatcher.addCallback(this, back)

        frame = FrameLayout(this)
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { _, insets -> pad(insets) }
        setTheme(getPreferences(MODE_PRIVATE).getBoolean(DARK, resources.configuration.isNightModeActive))

        val tooOld = WebViewVersion.problem(this)
        if (tooOld != null) {
            frame.addView(NoticeView.oldWebView(this, tooOld, dark))
            return
        }
        shell.screen = this
        showPage(savedInstanceState?.getString(ADDRESS) ?: "/")
        // An activity made again, or opened from the list of recent apps, has its first intent still.
        // What was in it has been handed over.
        val old = savedInstanceState != null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (!old) receive(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // With no page (it stopped, and its notice is showing), what came is kept for the next page.
        if (host != null) receive(intent) else waiting = intent
    }

    private fun showPage(start: String) {
        address = start
        val view = WebView(this)
        web = view
        view.setBackgroundColor(background())
        frame.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        knewAllFiles = com.etherpk.app.folders.hasAllFilesAccess()
        host = WebHost(view, shell, this).also { it.load(start) }
        waiting?.let {
            waiting = null
            receive(it)
        }
    }

    /** Keeps the page clear of the system's bars, the camera's cutout and the keyboard, all in one step. */
    private fun pad(insets: WindowInsetsCompat): WindowInsetsCompat {
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
        if (fullScreen == null) frame.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom)) else frame.setPadding(0, 0, 0, 0)
        // The page is not told of them too, or it would make the same room again.
        return WindowInsetsCompat.CONSUMED
    }

    private fun background() = if (dark) DARK_BACKGROUND else Color.WHITE

    override fun setTheme(dark: Boolean) {
        this.dark = dark
        getPreferences(MODE_PRIVATE).edit { putBoolean(DARK, dark) }
        val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.BLACK)
        enableEdgeToEdge(style, style)
        frame.setBackgroundColor(background())
        web?.setBackgroundColor(background())
    }

    // What another app hands over

    private fun receive(intent: Intent) {
        when (val received = readIntent(intent, packageName)) {
            is Received.Link -> shell.launches.add(mapOf("kind" to "link", "url" to received.url))
            is Received.SignInReturn -> signedInElsewhere(received.address)
            is Received.Share -> receiveShare(received)
            is Received.Document -> shell.inBackground {
                val file = shell.opened.add(OpenedDocument(contentResolver, received.uri, received.type, received.writable))
                shell.launches.add(mapOf("kind" to "file", "file" to file))
            }
            Received.Nothing -> {}
        }
    }

    private fun signedInElsewhere(address: String) {
        if (!signInBrowser.returned(address)) tell(R.string.sign_in_not_waiting)
    }

    private fun receiveShare(share: Received.Share) = shell.inBackground {
        val kept = shell.shared.receive(share.streams.map { offered(contentResolver, it, share.type) })
        if (kept.missed > 0) main.post { tell(R.string.share_partly_received) }
        if (kept.files.isEmpty() && share.text.isEmpty() && share.title.isEmpty()) return@inBackground
        val infos = kept.files.map(shell.opened::add)
        shell.launches.add(mapOf("kind" to "share", "title" to share.title, "text" to share.text, "url" to "", "files" to infos))
    }

    private fun tell(message: Int) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    // The shell's methods

    override fun pickFolder(): CompletableFuture<Uri?> =
        documents.ask(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)).thenApply { if (it.resultCode == RESULT_OK) it.data?.data else null }

    override fun createDocument(name: String, type: String): CompletableFuture<SaveTarget> {
        val wanted = type.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(wanted).putExtra(Intent.EXTRA_TITLE, name)
        // Off the main thread: the new document's name is a question to the app that made it.
        return documents.ask(intent).thenApplyAsync({ answer ->
            val uri = if (answer.resultCode == RESULT_OK) answer.data?.data else null
            SavedDocument(contentResolver, uri ?: throw BridgeFailure(Failure.ABORT, "The person cancelled."), name)
        }, shell.background)
    }

    override fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            tell(R.string.no_app_for_link)
        } catch (_: SecurityException) {
            tell(R.string.no_app_for_link)
        }
    }

    override fun print(): CompletableFuture<Unit> {
        val view = web ?: return failed(BridgeFailure(Failure.ABORT, "There is no page."))
        val title = view.title?.ifEmpty { null } ?: getString(R.string.app_name)
        val done = CompletableFuture<Unit>()
        val adapter = FinishingPrintAdapter(view.createPrintDocumentAdapter(title)) { done.complete(Unit) }
        getSystemService(PrintManager::class.java).print(title, adapter, null)
        return done
    }

    override fun clipboardItem(): android.content.ClipData.Item? =
        getSystemService(ClipboardManager::class.java).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)

    override fun closeAnswered(allow: Boolean) {
        val asked = closing
        closing = null
        asked?.let(main::removeCallbacks)
        // Nothing was asked: the page has finished what it was doing and wants to close.
        if (asked == null && allow) moveTaskToBack(true) else pauseIfStopped()
    }

    override fun send(message: ByteArray) { host?.send(message) }

    // The page's window

    override fun historyChanged() {
        web?.url?.let(::addressWithin)?.let { address = it }
        back.isEnabled = fullScreen != null || web?.canGoBack() == true
    }

    override fun chooseFiles(params: WebChromeClient.FileChooserParams, answer: ValueCallback<Array<Uri>>): Boolean {
        if (params.mode == WebChromeClient.FileChooserParams.MODE_SAVE) return false
        val many = params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
        val types = chooserTypes(params.acceptTypes.toList())
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, many)
        if (types.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
        files.ask(intent).whenComplete { result, _ -> answer.onReceiveValue(result?.takeIf { it.resultCode == RESULT_OK }?.data?.let(::chosen)) }
        return true
    }

    private fun chosen(data: Intent): Array<Uri>? {
        val clip = data.clipData
        if (clip != null) return Array(clip.itemCount) { clip.getItemAt(it).uri }
        return data.data?.let { arrayOf(it) }
    }

    /** A page's `accept` as the types Android knows. Empty, for every type, when one of them has none. */
    private fun chooserTypes(accept: List<String>): List<String> {
        val types = accept.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.drop(1)) else it.takeIf { type -> '/' in type } }
        return if (types.any { it == null }) emptyList() else types.filterNotNull().distinct()
    }

    override fun showFullScreen(view: View, hidden: WebChromeClient.CustomViewCallback) {
        if (fullScreen != null) {
            hidden.onCustomViewHidden()
            return
        }
        fullScreen = view
        fullScreenHidden = hidden
        frame.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        bars().hide(WindowInsetsCompat.Type.systemBars())
        bars().systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        ViewCompat.requestApplyInsets(frame)
        historyChanged()
    }

    override fun hideFullScreen() {
        val view = fullScreen ?: return
        fullScreen = null
        fullScreenHidden = null
        frame.removeView(view)
        bars().show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(frame)
        historyChanged()
    }

    private fun bars() = WindowCompat.getInsetsController(window, window.decorView)

    /** The page is drawn again where it was. One that keeps dying is not tried for ever. */
    override fun rendererGone(crashed: Boolean) {
        hideFullScreen()
        dropPage()
        val now = System.currentTimeMillis()
        rendererDeaths.addLast(now)
        while (rendererDeaths.first() < now - DEATHS_WITHIN_MS) rendererDeaths.removeFirst()
        if (rendererDeaths.size < MOST_DEATHS) {
            showPage(address)
            return
        }
        rendererDeaths.clear()
        frame.addView(NoticeView.pageStopped(this, dark) { frame.removeAllViews(); showPage("/") })
    }

    private fun dropPage() {
        frame.removeAllViews()
        host?.destroy()
        host = null
        web = null
        historyChanged()
    }

    // Coming and going

    private var closing: Runnable? = null
    private var stopped = false

    override fun onResume() {
        super.onResume()
        web?.onResume()
        signInBrowser.resumed()
        val allFiles = com.etherpk.app.folders.hasAllFilesAccess()
        if (allFiles != knewAllFiles) {
            // The page learns what the shell can do when it starts.
            knewAllFiles = allFiles
            host?.putPortOnPages()
            web?.reload()
        }
    }

    override fun onPause() {
        signInBrowser.paused()
        super.onPause()
    }

    override fun onStart() {
        super.onStart()
        stopped = false
        closing?.let(main::removeCallbacks)
        closing = null
    }

    /** The app may be ended at any time from here. The page is asked to finish saving, and runs on until it has. */
    override fun onStop() {
        super.onStop()
        stopped = true
        if (host == null) return
        val limit = Runnable {
            closing = null
            pauseIfStopped()
        }
        closing = limit
        main.postDelayed(limit, CLOSE_LIMIT_MS)
        shell.emit("beforeClose", emptyMap())
    }

    private fun pauseIfStopped() { if (stopped) web?.onPause() }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(ADDRESS, address)
    }

    override fun onDestroy() {
        if (shell.screen === this) shell.screen = null
        documents.end()
        files.end()
        signInBrowser.close()
        closing?.let(main::removeCallbacks)
        if (host != null) dropPage()
        super.onDestroy()
    }

    private companion object {
        const val ADDRESS = "address"
        const val DARK = "dark"
        val DARK_BACKGROUND = Color.rgb(0x0f, 0x0f, 0x0f)
        /** The page answers within eight seconds. */
        const val CLOSE_LIMIT_MS = 8_500L
        const val DEATHS_WITHIN_MS = 60_000L
        const val MOST_DEATHS = 3
    }
}
