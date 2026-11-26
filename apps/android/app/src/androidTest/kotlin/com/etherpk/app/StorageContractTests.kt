package com.etherpk.app

import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Dispatcher
import com.etherpk.app.bridge.Failure
import com.etherpk.app.folders.AndroidFolders
import com.etherpk.app.folders.FolderFiles
import com.etherpk.app.folders.FolderGrant
import com.etherpk.app.folders.FolderMethods
import com.etherpk.app.folders.FolderRegistry
import com.etherpk.app.folders.FolderSystem
import com.etherpk.app.folders.InotifyWatch
import com.etherpk.app.folders.PickedTree
import com.etherpk.app.folders.SafFolder
import com.etherpk.app.folders.SafTree
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith

private const val TEST_PROVIDER = "com.etherpk.testapp.documents"

private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
private val app get() = instrumentation.targetContext

fun shell(command: String): String =
    android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes().decodeToString() }

private fun state() = File(app.cacheDir, "contract-" + UUID.randomUUID()).also { it.mkdirs() }

fun allowAllFiles() {
    shell("appops set --uid com.etherpk.app MANAGE_EXTERNAL_STORAGE allow")
    val end = System.currentTimeMillis() + 5000
    while (!Environment.isExternalStorageManager() && System.currentTimeMillis() < end) Thread.sleep(50)
    assumeTrue("All files access could not be turned on", Environment.isExternalStorageManager())
}

/** The port's contract over shared storage by path, watched with inotify. */
@RunWith(AndroidJUnit4::class)
class DirectStorageContractTest : PortContract() {
    override fun makeHarness(): ContractHarness {
        allowAllFiles()
        val timer = Executors.newSingleThreadScheduledExecutor()
        val scratch = File(Environment.getExternalStorageDirectory(), "EtherPK contract/" + UUID.randomUUID())
        return DirectHarness(scratch, state(), { root, changed, lost -> InotifyWatch(root, timer, changed, lost) }, keepsNameForm = true)
    }
}

/** Folders through a document provider, the dialog answered by the test. */
private abstract class SafHarness : ContractHarness {
    override val watches = false
    override val replacesAtOnce = false
    private val answers = ArrayDeque<String?>()
    private val state = state()
    protected abstract val system: FolderSystem
    private val folders by lazy { FolderMethods(FolderRegistry(File(state, "folders.json")), system, { name, detail -> port.emit(name, detail) }) }
    override val port: TestPort by lazy { TestPort(Dispatcher(folders.handlers) { _, error -> error.printStackTrace() }, state) }

    override fun answerFolder(path: String?) { answers.addLast(path) }
    protected fun answer(): CompletableFuture<String> =
        answers.removeFirst()?.let { CompletableFuture.completedFuture(it) } ?: com.etherpk.app.bridge.failed(BridgeFailure(Failure.ABORT, "The person cancelled."))

    override fun dispose() {
        port.close()
        state.deleteRecursively()
    }
}

/**
 * The contract over shared storage through the system's own provider. One tree is granted, by the
 * shell in place of the dialog (the dialog is driven in AppTest), and each chosen folder is inside it.
 */
@RunWith(AndroidJUnit4::class)
class SafStorageContractTest : PortContract() {
    override fun makeHarness(): ContractHarness {
        allowAllFiles()
        val name = "EtherPK contract"
        File(Environment.getExternalStorageDirectory(), name).mkdirs()
        val tree = DocumentsContract.buildTreeDocumentUri(SafTree.EXTERNAL_STORAGE, "primary:$name")
        assumeTrue("The folder $name has not been granted (see AppTest)", SafTree(app, tree).permitted())
        return StorageHarness(tree, File(Environment.getExternalStorageDirectory(), name), UUID.randomUUID().toString())
    }

    private class StorageHarness(private val tree: Uri, folder: File, private val mine: String) : SafHarness() {
        private val scratch = File(folder, mine).also { it.mkdirs() }
        override val disk = PlainDisk(scratch)
        override val ignoresCase = true
        override val system = object : FolderSystem {
            private val saf = SafTree(app, tree)
            override fun pick() = answer().thenApply { PickedTree(it, it.substringAfterLast('/')) }
            override fun files(grant: FolderGrant): FolderFiles = SafFolder(saf, listOf(mine) + grant.tree.split('/') + grant.path)
            override fun displayPath(grant: FolderGrant) = (listOf(grant.tree) + grant.path).joinToString("/")
            override fun treePath(above: String, below: String) = if (above == below) emptyList() else if (below.startsWith("$above/")) below.removePrefix("$above/").split('/') else null
            override fun release(tree: String) {}
        }
        override fun dispose() {
            super.dispose()
            scratch.deleteRecursively()
        }
    }
}

/** The contract over a provider in another process, whose ids say nothing. */
private class ProviderHarness(canMove: Boolean) : SafHarness() {
    private val uri = Uri.parse("content://" + TEST_PROVIDER)
    override val ignoresCase = false

    init {
        // Any grant lets the app reach the provider's test calls.
        grant("root")
        ask("clear", "", Bundle().apply { putBoolean("canMove", canMove) })
    }

    private fun ask(act: String, path: String, extras: Bundle? = null): Bundle = app.contentResolver.call(uri, "test:$act", path, extras)!!

    private fun grant(id: String): Uri {
        // Sent by the shell: the app cannot see the test's package to send to it.
        check("result=1" in shell("am broadcast --include-stopped-packages -f 0x10000000 -n com.etherpk.testapp/.TestDocumentsGrant --es id $id"))
        return DocumentsContract.buildTreeDocumentUri(TEST_PROVIDER, id)
    }

    override val disk = object : ContractDisk {
        override fun write(path: String, text: String) { ask("write", path, Bundle().apply { putString("text", text) }) }
        override fun read(path: String): String? = ask("read", path).getString("text")
        override fun makeDirectory(path: String) { ask("makeDirectory", path) }
        override fun remove(path: String) { ask("remove", path) }
        override fun names(path: String): List<String> = ask("names", path).getStringArray("names")!!.toList()
        override fun link(path: String, target: String) = false
    }

    /** The app's own, with the dialog answered: permission, ids and relations are the real thing. */
    override val system = AndroidFolders(app, { answer().handle { path, _ -> path?.let { grant(ask("id", it).getString("id")!!) } } }, java.util.concurrent.Executors.newCachedThreadPool())
}

@RunWith(AndroidJUnit4::class)
class ProviderContractTest : PortContract() {
    override fun makeHarness(): ContractHarness = ProviderHarness(canMove = true)
}

/** As above, with a provider that can neither move nor rename. */
@RunWith(AndroidJUnit4::class)
class ProviderWithoutMovesContractTest : PortContract() {
    override fun makeHarness(): ContractHarness = ProviderHarness(canMove = false)
}
