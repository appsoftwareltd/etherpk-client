package com.etherpk.app.files

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.bytes
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import kotlin.random.Random
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedFilesTest {
    private val parent = Files.createTempDirectory("etherpk-share").toFile()
    private val dir = java.io.File(parent, "shares")
    private val shared = SharedFiles(dir, mostFiles = 3, mostBytes = 100)

    @After fun clear() { parent.deleteRecursively() }

    private fun offered(size: Int, name: String? = "a.png", type: String? = "image/png") = Offered(name, type) { ByteArrayInputStream(ByteArray(size)) }
    private fun failing(error: () -> Throwable) = Offered("a", null) { throw error() }

    @Test fun copiesUnderNamesOfItsOwn() {
        val received = shared.receive(listOf(offered(10, "../../databases/secret.db"), offered(5, "Photo.png")))
        assertEquals(listOf("secret.db", "Photo.png"), received.files.map { it.name })
        assertEquals(listOf(10L, 5L), received.files.map { it.stamp().size })
        assertEquals(listOf("shares"), parent.list()!!.toList())
        assertTrue(dir.list()!!.all { it.matches(Regex("[0-9a-f-]{36}")) })
        assertEquals(5, received.files[1].read().content.bytes().size)
    }

    @Test fun keepsToItsLimitsAndCountsWhatItMissed() {
        val many = shared.receive(List(5) { offered(1) })
        assertEquals(3, many.files.size)
        assertEquals(2, many.missed)
        val large = shared.receive(listOf(offered(60), offered(60), offered(30)))
        assertEquals(listOf(60L, 30L), large.files.map { it.stamp().size })
        assertEquals(1, large.missed)
        val endless = Offered("a", null) { object : InputStream() { override fun read() = 1 } }
        assertEquals(1, shared.receive(listOf(endless)).missed)
        assertEquals(5, dir.list()!!.size)
    }

    @Test fun anAppThatFailsIsAFileMissed() {
        val broken = Offered("a", null) { object : InputStream() { override fun read(): Int = throw IOException("torn") } }
        val received = shared.receive(listOf(failing { SecurityException("no") }, failing { IllegalStateException("provider") }, broken))
        assertEquals(0, received.files.size)
        assertEquals(3, received.missed)
        assertEquals(1, SharedFiles(dir).receive(listOf(Offered("a", null) { null })).missed)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    /** Property: whatever a name is, it is one name, short, and means nothing to a file system. */
    @Test fun aNameIsMadeSafe() {
        val random = Random(5)
        val parts = listOf("..", "/", "\\", "\u0000", "a", "é", "‮", ".md", " ", "\n", "<", ":", "x".repeat(200))
        repeat(500) {
            val name = SharedFiles.safeName(List(random.nextInt(8)) { parts.random(random) }.joinToString(""), 1)
            assertTrue(name, name.isNotBlank() && name.length <= 120 && !name.startsWith("."))
            assertFalse(name, name.any { it in "/\\<>:\"|?*" || it.isISOControl() || it == '‮' })
        }
        assertEquals("Shared file 4", SharedFiles.safeName(null, 4))
        assertEquals("Café.md", SharedFiles.safeName("Café.md", 1))
        assertTrue(SharedFiles.safeName("y".repeat(300) + ".webm", 1).endsWith(".webm"))
    }

    @Test fun aTypeThatIsNotOneIsLeftOut() {
        assertEquals(listOf("", "image/png", ""), shared.receive(listOf(offered(1, type = "image/png; x=\"\u0000"), offered(1), offered(1, type = null))).files.map { it.type })
    }

    @Test fun clearedAtAStartAndGoneWhenLetGo() {
        val received = shared.receive(listOf(offered(1), offered(1)))
        received.files[0].release()
        assertEquals(1, dir.list()!!.size)
        shared.clear()
        assertFalse(dir.exists())
        assertEquals("NotFoundError", runCatching { received.files[1].open() }.exceptionOrNull().let { (it as BridgeFailure).failure })
        assertEquals("NoModificationAllowedError", runCatching { received.files[1].write(BytesContent(ByteArray(1)), null) }.exceptionOrNull().let { (it as BridgeFailure).failure })
    }

    @Test fun launchesAreTakenOnceOldestFirst() {
        var arrived = 0
        val launches = Launches { arrived++ }
        assertEquals(emptyList<Any>(), launches.take())
        launches.add(mapOf("kind" to "link", "url" to "etherpk:/a"))
        launches.add(mapOf("kind" to "link", "url" to "etherpk:/b"))
        assertEquals(listOf("etherpk:/a", "etherpk:/b"), launches.take().map { it["url"] })
        assertEquals(emptyList<Any>(), launches.take())
        assertEquals(2, arrived)
        repeat(100) { launches.add(mapOf("n" to it)) }
        assertEquals((80..99).toList(), launches.take().map { it["n"] })
    }
}
