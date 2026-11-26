package com.etherpk.app

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.etherpk.app.auth.Grant
import com.etherpk.app.auth.Issuer
import com.etherpk.app.auth.KeystoreTokenStore
import com.etherpk.app.auth.SignIn
import com.etherpk.app.auth.SignInBrowser
import com.etherpk.app.auth.SignInConfig
import com.etherpk.app.auth.UrlConnectionHttp
import com.etherpk.app.auth.checkedIssuer
import com.etherpk.app.bridge.Arguments
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Dispatcher
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.Handler as MethodHandler
import com.etherpk.app.bridge.Port
import com.etherpk.app.files.Launches
import com.etherpk.app.files.OpenedFiles
import com.etherpk.app.files.SaveTarget
import com.etherpk.app.files.Saves
import com.etherpk.app.files.SharedFiles
import com.etherpk.app.folders.AndroidFolders
import com.etherpk.app.folders.FolderMethods
import com.etherpk.app.folders.FolderRegistry
import com.etherpk.app.folders.hasAllFilesAccess
import com.etherpk.app.update.UpdateKey
import com.etherpk.app.update.Updates
import com.etherpk.app.web.openableUrl
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/** Everything of the shell that outlasts the activity: one for the process. */
class Shell(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val workers = Executors.newFixedThreadPool(WORKERS) { Thread(it, "bridge") }
    /** Waits for the network and for the person, which must not keep a file waiting. */
    private val slow = Executors.newCachedThreadPool { Thread(it, "bridge-slow") }
    /**
     * Questions to other apps' document providers, which can hang while one is offline or starting.
     * They wait here, so the shell's other methods (`launches.take`, sign-in, the theme) still answer.
     */
    private val folderWork = Executors.newFixedThreadPool(PROVIDER_WORKERS) { Thread(it, "bridge-folders") }
    private val fileWork = Executors.newFixedThreadPool(PROVIDER_WORKERS) { Thread(it, "bridge-files") }

    /** For work that must not run on the main thread. */
    val background: java.util.concurrent.Executor get() = slow
    private val http = UrlConnectionHttp()

    /** The activity on the screen, on the main thread. */
    var screen: Screen? = null

    val launches = Launches { emit("launch", emptyMap()) }
    val opened = OpenedFiles()
    val shared = SharedFiles(File(context.cacheDir, "shares"))
    private val saves = Saves(File(context.cacheDir, "saves")) { name, type -> onScreen { it.createDocument(name, type) } }
    private val folders = FolderMethods(
        FolderRegistry(File(context.filesDir, "folders.json"), ::log),
        AndroidFolders(context, { onScreen<Uri?> { it.pickFolder() } }, slow),
        ::emit,
        ::log,
    )

    private val issuer = checkedIssuer(BuildConfig.ACCOUNT_ISSUER)
    private val signIn = SignIn(
        issuer?.let { Issuer(SignInConfig(it), http) },
        KeystoreTokenStore(File(context.filesDir, "sign-in"), issuer.orEmpty(), ::log),
        object : SignInBrowser {
            override fun open(url: String, accept: (String) -> Boolean): CompletableFuture<String?> = onScreen { it.signInBrowser.open(url, accept) }
            override fun close() = main.post { screen?.signInBrowser?.close() }.let { }
        },
        ::log,
    )

    private val updates = Updates(
        if (BuildConfig.UPDATE_CHECK) BuildConfig.UPDATE_FEED else "",
        updateKeys(),
        BuildConfig.VERSION_NAME,
        File(context.filesDir, "update-sequence"),
        http,
        { emit("updateStatus", it) },
        ::log,
    )

    val port = Port(
        Dispatcher(shellMethods() + on(folderWork, folders.handlers) + on(fileWork, opened.handlers + saves.handlers), ::log),
        workers,
        File(context.cacheDir, "uploads"),
    )

    init {
        // A start of the app before this one may have left these. No id leads to them. They can be
        // large, so they are moved aside at once and deleted away from the main thread.
        clearAside(File(context.cacheDir, "shares"))
        clearAside(File(context.cacheDir, "saves"))
        port.reset()
    }

    private fun clearAside(dir: File) {
        val parent = dir.parentFile ?: return
        val aside = File(parent, "${dir.name}$ASIDE${java.util.UUID.randomUUID()}")
        if (dir.exists() && !dir.renameTo(aside)) log("The app's old files could not be moved aside.", java.io.IOException(dir.path))
        val old = parent.listFiles { file -> file.name.startsWith("${dir.name}$ASIDE") }.orEmpty()
        if (old.isNotEmpty()) inBackground { old.forEach(File::deleteRecursively) }
    }

    /** The same methods, run on [pool]. */
    private fun on(pool: java.util.concurrent.Executor, handlers: Map<String, MethodHandler>): Map<String, MethodHandler> =
        handlers.mapValues { (_, handler) ->
            { args: Arguments ->
                CompletableFuture.supplyAsync({ handler(args) }, pool).thenCompose { result ->
                    @Suppress("UNCHECKED_CAST")
                    if (result is CompletableFuture<*>) result as CompletableFuture<Any?> else CompletableFuture.completedFuture(result)
                }
            }
        }

    fun info(): JSONObject = JSONObject()
        .put("bridgeVersion", BRIDGE_VERSION)
        .put("platform", "android")
        .put("appVersion", BuildConfig.VERSION_NAME)
        .put(
            "features",
            JSONObject()
                .put("watch", hasAllFilesAccess())
                .put("showInFileManager", false)
                .put("print", true)
                .put("signIn", issuer != null)
                .put("updates", updates.status()["state"] != "off"),
        )

    private fun shellMethods(): Map<String, MethodHandler> = mapOf(
        "shell.openExternal" to { args -> openableUrl(args.text("url"))?.let { url -> onScreen { it.openExternal(url).let(::done) } } ?: throw BridgeFailure(Failure.SECURITY, "That kind of address is not opened.") },
        "shell.showInFileManager" to { _ -> throw BridgeFailure(Failure.NOT_SUPPORTED, "There is no file manager to show it in.") },
        "shell.print" to { _ -> onScreen { it.print() } },
        "shell.setTheme" to { args -> theme(args) },
        "shell.closeAnswer" to { args -> args.flag("allow").let { allow -> onScreen { it.closeAnswered(allow).let(::done) } } },
        // The clip is taken on the main thread, where the system lets an app on the screen read it. A
        // clip of a document is read from its app, which is a question to another process.
        "clipboard.readText" to { _ -> onScreen { CompletableFuture.completedFuture(it.clipboardItem()) }.thenApplyAsync({ item -> item?.coerceToText(context)?.toString().orEmpty() }, slow) },
        "launches.take" to { _ -> launches.take() },
        "auth.signIn" to { _ -> slowly { granted(signIn.signIn()) } },
        "auth.accessToken" to { args -> args.flag("forceRefresh").let { force -> slowly { signIn.accessToken(force)?.let(::granted) } } },
        "auth.signedIn" to { _ -> slowly { signIn.signedIn() } },
        "auth.signOut" to { _ -> slowly { signIn.signOut() } },
        "updates.status" to { _ -> updates.status() },
        "updates.check" to { _ -> slowly { updates.check() } },
        "updates.install" to { _ -> updates.install() },
    )

    private fun theme(args: Arguments): CompletableFuture<Unit> {
        val scheme = args.text("scheme")
        if (scheme != "light" && scheme != "dark") throw BridgeFailure(Failure.OPERATION, "There is no such scheme.")
        return onScreen { it.setTheme(scheme == "dark").let(::done) }
    }

    private fun granted(grant: Grant) = mapOf("accessToken" to grant.accessToken, "expiresAt" to grant.expiresAt)

    private fun done(@Suppress("UNUSED_PARAMETER") unit: Unit): CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit)

    private fun <T> slowly(body: () -> T): CompletableFuture<T> = CompletableFuture.supplyAsync(body, slow)

    /** Runs on the main thread with the activity on the screen. With none there is nobody to ask. */
    private fun <T> onScreen(body: (Screen) -> CompletableFuture<T>): CompletableFuture<T> {
        val answered = CompletableFuture<T>()
        main.post {
            try {
                val shown = screen ?: throw BridgeFailure(Failure.ABORT, "The app is not on the screen.")
                body(shown).whenComplete { value, error -> if (error == null) answered.complete(value) else answered.completeExceptionally(error) }
            } catch (error: Throwable) {
                answered.completeExceptionally(error)
            }
        }
        return answered
    }

    fun emit(event: String, detail: Map<String, Any?>) {
        val message = port.event(event, detail)
        main.post { screen?.send(message) }
    }

    /** Runs away from the main thread. Failures are logged. */
    fun inBackground(body: () -> Unit) {
        slow.execute {
            try {
                body()
            } catch (error: Exception) {
                log("Work in the background failed.", error)
            }
        }
    }

    /** A new document has the port. What the one before it left running ends. */
    fun pageStarted() {
        folders.endWatches()
        inBackground { saves.abandonAll() }
    }

    fun log(message: String, error: Throwable) { Log.w(TAG, message, error) }

    private fun updateKeys(): List<UpdateKey> {
        val keys = JSONArray(BuildConfig.UPDATE_KEYS)
        return List(keys.length()) { keys.getJSONObject(it) }.map { UpdateKey(it.getString("id"), it.getString("publicKey")) }
    }

    companion object {
        /** NATIVE_BRIDGE_VERSION in packages/native-bridge. A unit test keeps the two equal. */
        const val BRIDGE_VERSION = 1
        private const val WORKERS = 8
        private const val PROVIDER_WORKERS = 6
        private const val ASIDE = ".old-"
        private const val TAG = "EtherPK"
    }
}
