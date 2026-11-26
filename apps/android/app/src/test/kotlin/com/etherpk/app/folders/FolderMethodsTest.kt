package com.etherpk.app.folders

import com.etherpk.app.bridge.Arguments
import com.etherpk.app.bridge.BridgeFailure
import java.io.Closeable
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FolderMethodsTest {
    private val dir = Files.createTempDirectory("etherpk-methods").toFile()
    private val notes = File(dir, "Notes").apply { mkdirs() }
    private val registry = FolderRegistry(File(dir, "folders.json"))
    private val logged = ArrayList<String>()
    private var check: () -> Unit = {}
    private var treeWatch: (() -> Closeable)? = null

    private val system = object : FolderSystem {
        override fun pick(): CompletableFuture<PickedTree> = CompletableFuture.completedFuture(PickedTree(notes.path, "Notes"))
        override fun files(grant: FolderGrant): FolderFiles {
            val direct = DirectFolder(File(grant.tree).toPath(), treeWatch?.let { make -> { _, _, _ -> make() } })
            return object : FolderFiles by direct {
                override fun check() {
                    this@FolderMethodsTest.check()
                    direct.check()
                }
            }
        }
        override fun displayPath(grant: FolderGrant): String? = null
        override fun treePath(above: String, below: String): List<String>? = null
        override fun release(tree: String) {}
    }
    private val methods = FolderMethods(registry, system, { _, _ -> }, { message, _ -> logged.add(message) })

    @After fun clear() { dir.deleteRecursively() }

    private fun call(method: String, vararg args: Pair<String, Any?>): Any? = methods.handlers.getValue(method)(Arguments(mapOf(*args)))

    private fun folder(): String {
        val picked = call("folders.pick") as CompletableFuture<*>
        return (picked.get() as Map<*, *>)["id"] as String
    }

    /** A provider that does not answer is not a folder that is gone: the page would ask for it again. */
    @Test fun aFolderThatCannotBeCheckedIsAFaultAndNotGone() {
        val id = folder()
        check = { throw BridgeFailure("OperationError", "The app that keeps the folder did not answer.") }
        val error = runCatching { call("folders.get", "folder" to id) }.exceptionOrNull() as BridgeFailure
        assertEquals("OperationError", error.failure)
        assertEquals(listOf("The folder could not be checked."), logged)
        check = { throw folderGone() }
        assertNull(call("folders.get", "folder" to id))
        check = { throw BridgeFailure("NotAllowedError", "No.") }
        assertNull(call("folders.get", "folder" to id))
        assertEquals(1, logged.size)
    }

    /** A watch that is still being made when the page goes is closed, and is not kept for the next page. */
    @Test fun aWatchReadyAfterItsPageHasGoneIsClosed() {
        val id = folder()
        val making = CountDownLatch(1)
        val ended = CountDownLatch(1)
        val closed = AtomicInteger()
        treeWatch = {
            making.countDown()
            ended.await(5, TimeUnit.SECONDS)
            Closeable { closed.incrementAndGet() }
        }
        val asked = CompletableFuture.supplyAsync { runCatching { call("fs.watch", "folder" to id) } }
        assertTrue(making.await(5, TimeUnit.SECONDS))
        methods.endWatches()
        ended.countDown()
        val answer = asked.get(5, TimeUnit.SECONDS)
        assertEquals("AbortError", (answer.exceptionOrNull() as BridgeFailure).failure)
        assertEquals(1, closed.get())
        // The next page's watch is kept, and ends with its page.
        treeWatch = { Closeable { closed.incrementAndGet() } }
        call("fs.watch", "folder" to id)
        assertEquals(1, closed.get())
        methods.endWatches()
        assertEquals(2, closed.get())
    }
}
