package com.etherpk.app

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Dispatcher
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.failed
import com.etherpk.app.files.FileSource
import com.etherpk.app.files.OpenedFiles
import com.etherpk.app.files.SaveTarget
import com.etherpk.app.files.Saves
import com.etherpk.app.folders.DirectFolder
import com.etherpk.app.folders.FileStamp
import com.etherpk.app.folders.FolderFiles
import com.etherpk.app.folders.FolderGrant
import com.etherpk.app.folders.FolderMethods
import com.etherpk.app.folders.FolderRegistry
import com.etherpk.app.folders.FolderSystem
import com.etherpk.app.folders.IfStamp
import com.etherpk.app.folders.PickedTree
import com.etherpk.app.folders.ReadFile
import com.etherpk.app.folders.TreeWatch
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.util.concurrent.CompletableFuture

/** Another program, using java.io on a scratch directory. */
class PlainDisk(private val scratch: File) : ContractDisk {
    private fun at(path: String) = if (path.isEmpty()) scratch else File(scratch, path)
    override fun write(path: String, text: String) {
        at(path).parentFile!!.mkdirs()
        at(path).writeText(text)
    }
    override fun read(path: String): String? = try { at(path).readText() } catch (_: IOException) { null }
    override fun makeDirectory(path: String) { at(path).mkdirs() }
    override fun remove(path: String) { at(path).deleteRecursively() }
    override fun names(path: String): List<String> = at(path).list().orEmpty().toList()
    override fun link(path: String, target: String): Boolean = try {
        Files.createSymbolicLink(at(path).toPath(), at(target).toPath())
        true
    } catch (_: IOException) {
        false
    }
    override fun rename(path: String, to: String): Boolean = at(path).renameTo(at(to))
}

/** Folders reached by path, the dialog answered by the test. */
class DirectHarness(private val scratch: File, private val state: File, treeWatch: TreeWatch? = null, override val keepsNameForm: Boolean = true) : ContractHarness {
    override val disk = PlainDisk(scratch)
    override val ignoresCase: Boolean
    override val watches = treeWatch != null
    private val answers = ArrayDeque<String?>()

    private val system = object : FolderSystem {
        override fun pick(): CompletableFuture<PickedTree> {
            val path = answers.removeFirst() ?: return failed(BridgeFailure(Failure.ABORT, "The person cancelled."))
            return CompletableFuture.completedFuture(PickedTree(File(scratch, path).path, path.substringAfterLast('/')))
        }
        override fun files(grant: FolderGrant): FolderFiles = DirectFolder(grant.path.fold(File(grant.tree)) { at, part -> File(at, part) }.toPath(), treeWatch)
        override fun displayPath(grant: FolderGrant) = grant.tree + grant.path.joinToString("") { "/$it" }
        override fun treePath(above: String, below: String): List<String>? = when {
            above == below -> emptyList()
            below.startsWith("$above/") -> below.removePrefix("$above/").split('/')
            else -> null
        }
        override fun release(tree: String) {}
    }

    private val folders: FolderMethods = FolderMethods(FolderRegistry(File(state, "folders.json")), system, { name, detail -> port.emit(name, detail) })
    private val opened = OpenedFiles()
    private val saveAnswers = ArrayDeque<String?>()
    private val saves = Saves(File(state, "saves")) { _, _ ->
        val path = saveAnswers.removeFirst()
        if (path == null) failed(BridgeFailure(Failure.ABORT, "The person cancelled.")) else CompletableFuture.completedFuture(PlainTarget(File(scratch, path)))
    }
    override val port: TestPort = TestPort(Dispatcher(folders.handlers + opened.handlers + saves.handlers) { _, error -> error.printStackTrace() }, state)

    init {
        scratch.mkdirs()
        File(scratch, "case").writeText("")
        ignoresCase = File(scratch, "CASE").exists()
        File(scratch, "case").delete()
    }

    override fun answerFolder(path: String?) { answers.addLast(path) }

    override fun answerSave(path: String?): Boolean {
        saveAnswers.addLast(path)
        return true
    }

    override fun openFile(path: String): Map<*, *> = opened.add(PlainSource(File(scratch, path)))

    override fun dispose() {
        folders.endWatches()
        port.close()
        scratch.deleteRecursively()
        state.deleteRecursively()
    }
}

private class PlainTarget(private val file: File) : SaveTarget {
    override val name: String = file.name
    override fun commit(from: File) { from.copyTo(file, overwrite = true) }
    override fun abandon() {}
}

/** One opened file, as a direct folder of its own directory answers it. */
private class PlainSource(private val file: File) : FileSource {
    private val folder = DirectFolder(file.parentFile!!.toPath())
    private val path = listOf(file.name)
    override val name: String = file.name
    override val type = ""
    override fun stamp(): FileStamp = folder.stat(path)!!.stamp!!
    override fun read(): ReadFile = folder.read(path)
    override fun open(): InputStream = file.inputStream()
    override fun write(content: Content, ifStamp: IfStamp?): FileStamp = folder.write(path, content, false, ifStamp)
    override fun release() {}
}
