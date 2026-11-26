package com.etherpk.app.folders

import com.etherpk.app.bridge.Content
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DirectFolderTest {
    private val dir = Files.createTempDirectory("etherpk-direct").toFile()
    private val folder = DirectFolder(dir.toPath())

    @After fun clear() { dir.deleteRecursively() }

    @Test fun aWriteThatFailsPartWayLeavesTheOldFileAndNothingBeside() {
        java.io.File(dir, "a.md").writeText("old")
        val torn = object : Content {
            override val size = 100L
            override fun open(): InputStream = object : InputStream() { override fun read(): Int = throw IOException("torn") }
        }
        assertTrue(runCatching { folder.write(listOf("a.md"), torn, false, null) }.isFailure)
        assertEquals(listOf("a.md"), dir.list()!!.toList())
        assertEquals("old", java.io.File(dir, "a.md").readText())
    }

    /** The system's words for a full disk come in a plain IOException from a channel, not a FileSystemException. */
    @Test fun aFullDiskIsNamedAsOne() {
        val full = object : Content {
            override val size = 100L
            override fun open(): InputStream = object : InputStream() { override fun read(): Int = throw IOException("write failed: ENOSPC (No space left on device)") }
        }
        val error = runCatching { folder.write(listOf("a.md"), full, false, null) }.exceptionOrNull()
        assertEquals("QuotaExceededError", (error as com.etherpk.app.bridge.BridgeFailure).failure)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test fun aWriteThroughALinkInsideTheFolderKeepsTheLink() {
        java.io.File(dir, "real.md").writeText("old")
        Files.createSymbolicLink(dir.toPath().resolve("link.md"), dir.toPath().resolve("real.md"))
        folder.write(listOf("link.md"), com.etherpk.app.bridge.BytesContent("new".toByteArray()), false, null)
        assertTrue(Files.isSymbolicLink(dir.toPath().resolve("link.md")))
        assertEquals("new", java.io.File(dir, "real.md").readText())
    }

    @Test fun walkEndsWhereALinkLeadsBackUp() {
        java.io.File(dir, "a").mkdir()
        java.io.File(dir, "a/x.md").writeText("x")
        Files.createSymbolicLink(dir.toPath().resolve("a/up"), dir.toPath())
        assertEquals(listOf("a/x.md"), folder.walk(emptyList(), emptySet(), 100).files.filter { it.endsWith("x.md") }.take(1))
        assertTrue(folder.walk(emptyList(), emptySet(), 100).files.size < 5)
    }
}
