package com.etherpk.app

import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Environment
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.etherpk.app.web.APP_ORIGIN
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/** The whole app on a device: its page, its port, and what the system hands it. The first one grants the folder SafStorageContractTest needs. */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AppTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)

    @Before fun start() {
        device.wakeUp()
        launch(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
        ready()
    }

    @After fun finish() {
        instrumentation.runOnMainSync { activity()?.finishAndRemoveTask() }
        wait("the activity to end") { activity() == null }
    }

    private fun launch(intent: Intent) = context.startActivity(intent.setClassName(context, MainActivity::class.java.name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun activity(): MainActivity? {
        var found: MainActivity? = null
        val look = { found = Stage.entries.filter { it != Stage.DESTROYED && it != Stage.PRE_ON_CREATE }.flatMap { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) }.filterIsInstance<MainActivity>().firstOrNull() }
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) look() else instrumentation.runOnMainSync(look)
        return found
    }

    private fun wait(what: String, ms: Long = 20_000, met: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!met()) {
            if (System.currentTimeMillis() > end) throw AssertionError("Waited too long for $what.")
            Thread.sleep(50)
        }
    }

    private fun webView(view: View? = activity()?.window?.decorView): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { webView(view.getChildAt(it)) }
        else -> null
    }

    /** The value of a script's expression, a promise waited for. */
    private fun js(expression: String): Any? {
        run("window.__done = false; (async () => ($expression))().then((v) => { window.__value = v === undefined ? null : v; window.__failed = null }, (e) => { window.__failed = String(e) }).finally(() => { window.__done = true })")
        wait("a script", 60_000) { run("window.__done") == true }
        val failed = run("window.__failed")
        if (failed != null && failed != JSONObject.NULL) throw AssertionError("The script failed: $failed")
        return run("window.__value").takeIf { it != JSONObject.NULL }
    }

    private fun run(script: String): Any? {
        val answered = CompletableFuture<String>()
        instrumentation.runOnMainSync { webView()?.evaluateJavascript(script, answered::complete) ?: answered.complete("null") }
        // A page in the background, behind a dialog, answers when it is in front again.
        return try {
            JSONTokener(answered.get(20, TimeUnit.SECONDS)).nextValue()
        } catch (_: java.util.concurrent.TimeoutException) {
            null
        }
    }

    private fun ready() = wait("the page", 60_000) {
        run("document.readyState === 'complete' && window.etherpkNative !== undefined && document.body.innerText.length > 20") == true
    }

    private fun call(method: String, args: String = "{}"): JSONObject = js("etherpkNative.call('$method', $args)") as JSONObject
    private fun refusal(method: String, args: String = "{}"): String = call(method, args).let { if (it.getBoolean("ok")) "nothing" else it.getString("name") }

    private fun tap(text: String) {
        val found = device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile(text, java.util.regex.Pattern.CASE_INSENSITIVE))), 10_000)
        assertNotNull("There is no $text", found)
        found.click()
    }

    /** Chooses a folder of shared storage in the system's dialog. */
    private fun choose(name: String): JSONObject {
        run("window.__picked = null; etherpkNative.call('folders.pick', {}).then((r) => { window.__picked = JSON.stringify(r) })")
        assertTrue(device.wait(Until.hasObject(By.pkg(java.util.regex.Pattern.compile("com\\.(google\\.)?android\\.documentsui"))), 10_000))
        // The dialog opens where it was last.
        repeat(3) {
            if (device.wait(Until.hasObject(By.text(name)), 3_000)) return@repeat
            // From inside a folder, the way up to shared storage's own name.
            device.findObject(By.textContains("sdk_gphone"))?.click()
        }
        // The folder may be further down a long list.
        runCatching { androidx.test.uiautomator.UiScrollable(androidx.test.uiautomator.UiSelector().scrollable(true)).scrollTextIntoView(name) }
        tap(java.util.regex.Pattern.quote(name))
        tap("Use this folder")
        tap("Allow")
        wait("the folder") { run("window.__picked") is String }
        return JSONObject(run("window.__picked") as String).getJSONObject("value")
    }

    @Test fun a1_aFolderIsChosenInTheSystemsDialogAndUsed() {
        allowAllFiles()
        File(Environment.getExternalStorageDirectory(), "EtherPK contract").mkdirs()
        val folder = choose("EtherPK contract")
        assertEquals("EtherPK contract", folder.getString("name"))
        val id = folder.getString("id")
        assertTrue(call("fs.write", "{folder:'$id',path:'deep/Café.md',bytes:new TextEncoder().encode('from the page'),createDirectories:true}").getBoolean("ok"))
        val file = File(Environment.getExternalStorageDirectory(), "EtherPK contract/deep/Café.md")
        assertEquals("from the page", file.readText())
        assertEquals("from the page", js("etherpkNative.call('fs.read',{folder:'$id',path:'deep/Café.md'}).then((r) => new TextDecoder().decode(r.value.bytes))"))
        // The same folder chosen again is the same folder.
        assertEquals(id, choose("EtherPK contract").getString("id"))
        file.delete()
    }

    @Test fun a2_aDialogTheScreenLeavesIsAnAbort() {
        run("window.__picked = null; etherpkNative.call('folders.pick', {}).then((r) => { window.__picked = JSON.stringify(r) })")
        assertTrue(device.wait(Until.hasObject(By.pkg(java.util.regex.Pattern.compile("com\\.(google\\.)?android\\.documentsui"))), 10_000))
        device.pressBack()
        if (run("window.__picked") !is String) device.pressBack()
        wait("the answer") { run("window.__picked") is String }
        assertEquals("AbortError", JSONObject(run("window.__picked") as String).getString("name"))
    }

    @Test fun thePageIsTheAppsOwnWithItsPolicy() {
        assertEquals(APP_ORIGIN, run("location.origin"))
        assertEquals(true, run("isSecureContext"))
        assertTrue((js("fetch('/graphs', {headers: {accept: 'text/html'}}).then((r) => r.status)") as Int) == 404)
        assertTrue((js("fetch('/_app/env.js').then((r) => r.headers.get('content-security-policy'))") as String).contains("require-trusted-types-for"))
        // The policy is in force on the page itself.
        assertEquals("EvalError", js("(() => { try { return String(eval('1')) } catch (e) { return e.name } })()"))
        assertEquals(0, js("(() => { const d = document.createElement('div'); d.innerHTML = '<img src=x onerror=1>'; return d.querySelectorAll('[onerror]').length })()"))
        assertEquals(404, js("fetch('/api/v1/anything').then((r) => r.status)"))
        assertEquals(405, js("fetch('/graphs', {method: 'POST'}).then((r) => r.status)"))
        assertEquals(true, js("fetch('http://installed.app.etherpk.com/').then(() => false, () => true)"))
    }

    @Test fun thePortSaysWhatTheShellIsAndCannotBeReplaced() {
        assertEquals("android", run("etherpkNative.info.platform"))
        assertEquals(BuildConfig.VERSION_NAME, run("etherpkNative.info.appVersion"))
        assertEquals("false false true", run("[(() => { try { window.etherpkNative = 1 } catch {} return window.etherpkNative === 1 })(), (() => { try { etherpkNative.info.platform = 'x' } catch {} return etherpkNative.info.platform === 'x' })(), Object.isFrozen(etherpkNative)].join(' ')"))
        assertEquals("undefined", run("typeof window.etherpkNativeMessages"))
    }

    @Test fun methodsOutsideTheTableAndHostileArgumentsAreRefused() {
        for (method in listOf("fs.exec", "constructor", "__proto__", "", "hello")) assertEquals("NotSupportedError", refusal(method))
        assertEquals("NotSupportedError", js("etherpkNative.call({toString: () => 'fs.list'}, {}).then((r) => r.name)"))
        assertEquals("NotAllowedError", refusal("fs.list", "{folder: '../../data', path: '', stamps: true}"))
        assertEquals("NotAllowedError", refusal("fs.read", "{folder: '/data/data/com.etherpk.app', path: 'files/folders.json'}"))
        for (url in listOf("intent://x#Intent;scheme=http;end", "file:///sdcard", "content://a/b", "javascript:1", "market://details?id=x", "etherpk:/graph", "")) assertEquals(url, "SecurityError", refusal("shell.openExternal", "{url: '$url'}"))
        assertEquals("OperationError", refusal("shell.setTheme", "{scheme: 'purple'}"))
        assertEquals("OperationError", refusal("fs.read", "{folder: 1n, path: ''}"))
        assertEquals("OperationError", js("(() => { const loop = {}; loop.loop = loop; return etherpkNative.call('fs.list', loop).then((r) => r.name) })()"))
        assertEquals("NotAllowedError", refusal("files.read", "{file: 'made-up'}"))
        assertEquals("NotFoundError", refusal("save.commit", "{save: 'made-up'}"))
        assertEquals(404, js("fetch('/__native/bytes/guess').then((r) => r.status)"))
        assertEquals(404, js("fetch('/__native/bytes/').then((r) => r.status)"))
    }

    @Test fun aFrameHasNoPortAndItsMessagesAreNotAnswered() {
        // A frame of the app's own origin, which the WebView's origin rule does not keep out.
        js("new Promise((done) => { const f = document.createElement('iframe'); f.src = '/__etherpk-ebook/reader.html'; f.onload = done; f.id = 'probe'; document.body.append(f) })")
        assertEquals("undefined", run("typeof document.getElementById('probe').contentWindow.etherpkNative"))
        // Whatever the WebView left in the frame, a call through it is not answered.
        assertEquals(
            "silent",
            js(
                """new Promise((done) => {
                    const raw = document.getElementById('probe').contentWindow.etherpkNativeMessages
                    if (!raw) { done('silent'); return }
                    raw.onmessage = () => done('answered')
                    const json = new TextEncoder().encode(JSON.stringify({ id: 1, method: 'launches.take', args: {} }))
                    const message = new Uint8Array(4 + json.length)
                    new DataView(message.buffer).setUint32(0, json.length)
                    message.set(json, 4)
                    raw.postMessage(message.buffer)
                    setTimeout(() => done('silent'), 1500)
                })""",
            ),
        )
        // A frame with no origin of its own.
        js("new Promise((done) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = '/favicon.svg'; f.onload = done; document.body.append(f) })")
        run("document.querySelectorAll('iframe').forEach((f) => f.remove())")
    }

    @Test fun bytesTooLargeForAMessageGoBothWaysUnchanged() {
        allowAllFiles()
        val id = choose("EtherPK contract").getString("id")
        val result = js(
            """(async () => {
                const bytes = new Uint8Array(23 * 1024 * 1024 + 7)
                for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251
                const digest = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].join(',')
                const before = await digest(bytes)
                const written = await etherpkNative.call('fs.write', { folder: '$id', path: 'large.bin', bytes })
                const read = await etherpkNative.call('fs.read', { folder: '$id', path: 'large.bin' })
                return [written.ok, written.value?.size === bytes.length, read.ok, await digest(read.value.bytes) === before].join(' ')
            })()""",
        )
        assertEquals("true true true true", result)
        assertEquals(23L * 1024 * 1024 + 7, File(Environment.getExternalStorageDirectory(), "EtherPK contract/large.bin").length())
        // What the page sends is what it had when it called.
        assertEquals("1", js("(async () => { const b = new Uint8Array([49]); const sent = etherpkNative.call('fs.write', {folder:'$id',path:'small.txt',bytes:b}); b[0] = 50; await sent; return new TextDecoder().decode((await etherpkNative.call('fs.read', {folder:'$id',path:'small.txt'})).value.bytes) })()"))
        File(Environment.getExternalStorageDirectory(), "EtherPK contract/large.bin").delete()
        File(Environment.getExternalStorageDirectory(), "EtherPK contract/small.txt").delete()
    }

    private fun send(vararg extras: Pair<String, String>) =
        shell("am start -W -n com.etherpk.testapp/.SendActivity " + extras.joinToString(" ") { (name, value) -> "--es $name $value" })

    /** Takes what arrives from here on, as the page would. The Client's own taking is stopped first. */
    private fun launches(kind: String, count: Int = 1): List<JSONObject> {
        val all = ArrayList<JSONObject>()
        wait("a launch") {
            val more = (js("etherpkNative.call('launches.take', {}).then((r) => r.value)") as JSONArray)
            repeat(more.length()) { all.add(more.getJSONObject(it)) }
            all.count { it.getString("kind") == kind } >= count
        }
        return all.filter { it.getString("kind") == kind }
    }

    /** A page that is not the Client, so nothing but the test takes launches. It has the port as any page of the app has. */
    private fun quietPage() {
        instrumentation.runOnMainSync { webView()!!.loadUrl("$APP_ORIGIN/favicon.svg") }
        wait("the quiet page") { run("location.pathname === '/favicon.svg' && typeof etherpkNative") == "object" }
        js("etherpkNative.call('launches.take', {}).then(() => 1)")
    }

    @Test fun sharedTextAndFilesArriveOnceAndCanBeRead() {
        quietPage()
        send("send" to "share", "text" to "some.words", "title" to "A.title", "files" to "picture.png,note.txt,hostile,missing,throws")
        val share = launches("share").single()
        assertEquals("some.words", share.getString("text"))
        assertEquals("A.title", share.getString("title"))
        val files = share.getJSONArray("files")
        assertEquals(listOf("picture.png", "note.txt", "folders.json"), List(files.length()) { files.getJSONObject(it).getString("name") })
        assertEquals("image/png", files.getJSONObject(0).getString("type"))
        val id = files.getJSONObject(1).getString("id")
        assertEquals("shared words", js("etherpkNative.call('files.read', {file: '$id'}).then((r) => new TextDecoder().decode(r.value.bytes))"))
        assertEquals("words", js("etherpkNative.call('files.readPart', {file: '$id', offset: 7, length: 50}).then((r) => new TextDecoder().decode(r.value.bytes))"))
        assertEquals("NoModificationAllowedError", refusal("files.write", "{file: '$id', bytes: new Uint8Array(1)}"))
        assertEquals("NotAllowedError", refusal("fs.list", "{folder: '$id', path: '', stamps: false}"))
        call("files.release", "{file: '$id'}")
        assertEquals("NotAllowedError", refusal("files.read", "{file: '$id'}"))
        assertEquals(0, (js("etherpkNative.call('launches.take', {}).then((r) => r.value)") as JSONArray).length())
        // Nothing was written anywhere the shared file's own name pointed.
        assertTrue(File(context.cacheDir, "shares").list()!!.all { it.matches(Regex("[0-9a-f-]{36}")) })
    }

    @Test fun anEndlessFileIsGivenUpAndTheTextStillArrives() {
        quietPage()
        send("send" to "share", "text" to "still.here", "files" to "endless")
        val share = launches("share").single()
        assertEquals("still.here", share.getString("text"))
        assertEquals(0, share.getJSONArray("files").length())
    }

    @Test fun selectedTextComesToTheOnePage() {
        quietPage()
        send("send" to "process", "text" to "picked.words")
        assertEquals("picked.words", launches("share").single().getString("text"))
        var pages = 0
        instrumentation.runOnMainSync { pages = Stage.entries.filter { it != Stage.DESTROYED }.flatMap { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(it) }.filterIsInstance<MainActivity>().distinct().size }
        assertEquals(1, pages)
    }

    @Test fun anOpenedFileIsReadAndWrittenWhereItIs() {
        quietPage()
        send("send" to "view", "files" to "note.md")
        val file = launches("file").single().getJSONObject("file")
        assertEquals("note.md", file.getString("name"))
        val id = file.getString("id")
        val stamp = js("etherpkNative.call('files.read', {file: '$id'}).then((r) => ({lastModified: r.value.lastModified, size: r.value.size}))") as JSONObject
        assertTrue(call("files.write", "{file: '$id', bytes: new TextEncoder().encode('changed here'), ifStamp: $stamp}").getBoolean("ok"))
        assertEquals("changed here", js("etherpkNative.call('files.read', {file: '$id'}).then((r) => new TextDecoder().decode(r.value.bytes))"))
        assertEquals("NoModificationAllowedError", refusal("files.write", "{file: '$id', bytes: new Uint8Array(1), ifStamp: $stamp}"))
    }

    @Test fun anEtherpkLinkArrivesAndOthersDoNot() {
        quietPage()
        shell("am start -W -a android.intent.action.VIEW -d etherpk:/graph/sync/abc/d/Garden")
        assertEquals("etherpk:/graph/sync/abc/d/Garden", launches("link").single().getString("url"))
        for (data in listOf("file:///data/data/com.etherpk.app/files/folders.json", "content://com.etherpk.app/x", "https://example.com/")) {
            shell("am start -W -n com.etherpk.app/.MainActivity -a android.intent.action.VIEW -d $data")
            shell("am start -W -n com.etherpk.app/.MainActivity -a android.intent.action.SEND -t image/png --eu android.intent.extra.STREAM $data")
        }
        Thread.sleep(1000)
        assertEquals(0, (js("etherpkNative.call('launches.take', {}).then((r) => r.value)") as JSONArray).length())
    }

    @Test fun extrasThatDoNotUnpackAreNothing() {
        quietPage()
        shell("am start -W -n com.etherpk.app/.MainActivity -a android.intent.action.SEND -t text/plain --ei android.intent.extra.TEXT 5")
        shell("am start -W -n com.etherpk.app/.MainActivity -a android.intent.action.SEND_MULTIPLE -t text/plain --es android.intent.extra.STREAM words")
        shell("am start -W -n com.etherpk.app/.MainActivity -a android.intent.action.VIEW")
        Thread.sleep(500)
        assertEquals(0, (js("etherpkNative.call('launches.take', {}).then((r) => r.value)") as JSONArray).length())
    }

    @Test fun rotationKeepsThePage() {
        run("window.__kept = 7")
        instrumentation.runOnMainSync { activity()!!.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        wait("landscape") { run("innerWidth > innerHeight") == true }
        assertEquals(7, run("window.__kept"))
        instrumentation.runOnMainSync { activity()!!.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        wait("portrait") { run("innerWidth < innerHeight") == true }
        assertEquals(7, run("window.__kept"))
    }

    @Test fun backGoesThroughHistoryAndThenLeaves() {
        wait("the first page") { run("location.pathname") == "/graphs" }
        // Going back passes over what a page added before anyone touched it, as a browser's Back does.
        device.click(device.displayWidth / 2, device.displayHeight / 12)
        wait("a touch") { run("navigator.userActivation.hasBeenActive") == true }
        run("history.pushState({}, '', '/share?title=probe')")
        wait("the history") { run("location.pathname") == "/share" }
        instrumentation.waitForIdleSync()
        device.pressBack()
        wait("going back") { run("location.pathname") == "/graphs" }
        val activity = activity()!!
        var tries = 0
        while (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) && tries++ < 6) {
            device.pressBack()
            Thread.sleep(1000)
        }
        assertFalse(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }

    @Test fun anActivityMadeAgainReturnsToItsAddress() {
        run("history.pushState({}, '', '/share?title=kept')")
        wait("the address") { run("location.search") == "?title=kept" }
        var first: MainActivity? = null
        instrumentation.runOnMainSync { first = activity(); first!!.recreate() }
        wait("the new one") { activity().let { it != null && it !== first } }
        ready()
        assertEquals("?title=kept", run("location.search"))
    }

    @Test fun aRendererThatDiesIsStartedAgain() {
        run("history.pushState({}, '', '/share?title=kept')")
        val dead = webView()
        instrumentation.runOnMainSync { dead!!.loadUrl("chrome://crash") }
        wait("a new page") { webView().let { it != null && it !== dead } }
        ready()
        assertEquals("?title=kept", run("location.search"))
    }

    @Test fun theSaveDialogWritesACopyWhenItIsWhole() {
        allowAllFiles()
        run("window.__saved = null; etherpkNative.call('save.open', {name: 'Copy.md', type: 'text/markdown'}).then((r) => { window.__saved = JSON.stringify(r) })")
        tap("Save")
        wait("the dialog") { run("window.__saved") is String }
        val save = JSONObject(run("window.__saved") as String).getJSONObject("value")
        val id = save.getString("save")
        call("save.write", "{save: '$id', bytes: new TextEncoder().encode('one ')}")
        call("save.write", "{save: '$id', bytes: new TextEncoder().encode('two')}")
        assertTrue(call("save.commit", "{save: '$id'}").getBoolean("ok"))
        assertEquals("NotFoundError", refusal("save.commit", "{save: '$id'}"))
        assertTrue(save.getString("name").startsWith("Copy"))
        val written = Environment.getExternalStorageDirectory().walk().maxDepth(3).filter { it.name == save.getString("name") }.toList()
        assertEquals(listOf("one two"), written.map { it.readText() })
        written.forEach { it.delete() }
    }

    @Test fun printingShowsTheSystemsDialogAndEndsWithIt() {
        run("window.__printed = null; etherpkNative.call('shell.print', {}).then((r) => { window.__printed = JSON.stringify(r) })")
        assertTrue(device.wait(Until.hasObject(By.pkg("com.android.printspooler")), 15_000))
        Thread.sleep(1000)
        assertTrue(run("window.__printed").let { it == null || it == JSONObject.NULL })
        device.pressBack()
        wait("the print to end") { run("window.__printed") is String }
        assertTrue(JSONObject(run("window.__printed") as String).getBoolean("ok"))
    }

    @Test fun theClipboardIsRead() {
        instrumentation.runOnMainSync { context.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("", "copied words")) }
        assertEquals("copied words", call("clipboard.readText").getString("value"))
    }

    @Test fun thePageIsToldTheAppIsGoingAndComesBack() {
        run("window.__told = 0; etherpkNative.on((event) => { if (event === 'beforeClose') window.__told++ })")
        device.pressHome()
        wait("being told") { run("window.__told") == 1 }
        launch(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
        wait("the front") { activity()?.lifecycle?.currentState == Lifecycle.State.RESUMED }
    }

    @Test fun signInIsOffWithoutAnIssuerAndUpdatesWithoutAKey() {
        assertEquals(BuildConfig.ACCOUNT_ISSUER.isNotEmpty(), run("etherpkNative.info.features.signIn"))
        if (BuildConfig.ACCOUNT_ISSUER.isEmpty()) {
            assertEquals(false, call("auth.signedIn").getBoolean("value"))
            assertTrue(call("auth.accessToken").isNull("value"))
            assertEquals("NotSupportedError", refusal("auth.signIn"))
        }
        assertEquals("off", call("updates.status").getJSONObject("value").getString("state"))
        assertEquals("NotSupportedError", refusal("updates.install"))
        assertNull(js("etherpkNative.call('launches.take', {}).then(() => undefined)"))
    }

    @Test fun nothingOfTheAppIsBackedUp() {
        val info = context.applicationInfo
        assertEquals(0, info.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP)
        assertFalse(android.security.NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("example.com"))
        assertTrue(android.security.NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted("127.0.0.1"))
    }
}
