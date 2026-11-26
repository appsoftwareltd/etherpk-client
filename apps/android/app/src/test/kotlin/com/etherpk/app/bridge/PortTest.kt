package com.etherpk.app.bridge

import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import kotlin.random.Random
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A seed and a run count an environment variable overrides, as for the repository's other property tests. */
private val RUNS = System.getenv("ANDROID_FUZZ_RUNS")?.toInt() ?: 300

class PortTest {
    private val dir = Files.createTempDirectory("etherpk-port").toFile()
    private var time = 0L
    private var seen: Arguments? = null
    private val logged = ArrayList<String>()
    private val dispatcher = Dispatcher(
        mapOf(
            "echo" to { args -> args.any("value") },
            "bytes" to { args -> args.content("bytes").bytes().size.toLong() },
            "big" to { _ -> mapOf("bytes" to BytesContent(ByteArray(5 * 1024 * 1024))) },
            "refuse" to { _ -> throw BridgeFailure(Failure.NOT_FOUND, "Gone.") },
            "fault" to { _ -> throw IllegalStateException("Broken at /storage/emulated/0/Garden.") },
            "caused" to { _ -> throw BridgeFailure(Failure.NOT_READABLE, "Unreadable.", java.io.IOException("EIO")) },
            "memory" to { _ -> throw OutOfMemoryError("Full.") },
            "later" to { _ -> CompletableFuture.supplyAsync { 7 } },
            "laterRefused" to { _ -> CompletableFuture.supplyAsync<Any> { throw BridgeFailure(Failure.ABORT, "No.") } },
            "nothing" to { _ -> },
            "args" to { args -> seen = args },
        ),
        { method, error -> logged.add("$method ${error.message}") },
    )
    private val port = Port(dispatcher, Executor(Runnable::run), dir, { time })

    @After fun clear() { dir.deleteRecursively() }

    private fun send(header: Map<String, Any?>): Frame.Incoming? {
        val answered = CompletableFuture<ByteArray>()
        port.receive(Frame.write(header, Long.MAX_VALUE) { error("not streamed") }, answered::complete)
        return if (header.containsKey("hello")) null else Frame.read(answered.get())
    }

    private fun call(method: String, args: Any? = emptyMap<String, Any?>()) = send(mapOf("id" to 1, "method" to method, "args" to args))!!

    private fun part(token: String, offset: Long, bytes: ByteArray): Boolean {
        val json = JSONObject(mapOf("id" to 2, "part" to token, "offset" to offset)).toString().toByteArray()
        val message = java.nio.ByteBuffer.allocate(4 + json.size + bytes.size).putInt(json.size).put(json).put(bytes).array()
        val answered = CompletableFuture<ByteArray>()
        port.receive(message, answered::complete)
        return Frame.read(answered.get())!!.header.getBoolean("ok")
    }

    /** Property: what the page sends comes back as it was, bytes and text and nesting. */
    @Test fun whatIsSentComesBack() {
        val random = Random(20261125)
        fun value(depth: Int): Any? = when (random.nextInt(if (depth > 3) 6 else 8)) {
            0 -> null
            1 -> random.nextBoolean()
            2 -> random.nextInt()
            3 -> String(CharArray(random.nextInt(12)) { random.nextInt(1, 0xD000).toChar() })
            4, 5 -> BytesContent(random.nextBytes(random.nextInt(40)))
            6 -> List(random.nextInt(4)) { value(depth + 1) }
            else -> List(random.nextInt(4)) { "k$it" to value(depth + 1) }.toMap()
        }
        repeat(RUNS) {
            val sent = value(0)
            assertEquals(plain(sent), plain(call("echo", mapOf("value" to sent)).value("value")))
        }
    }

    private fun plain(value: Any?): Any? = when (value) {
        is Content -> value.bytes().toList()
        is Map<*, *> -> value.mapValues { plain(it.value) }
        is List<*> -> value.map(::plain)
        else -> value
    }

    /** Property: a message of any bytes is answered or ignored, and never thrown out of the port. */
    @Test fun anyMessageIsAnsweredOrIgnored() {
        val random = Random(11)
        repeat(RUNS) {
            val message = random.nextBytes(random.nextInt(64))
            if (message.size >= 4 && random.nextBoolean()) java.nio.ByteBuffer.wrap(message).putInt(random.nextInt(0, message.size))
            port.receive(message) {}
        }
        val broken = listOf("{", "[]", "null", "{\"id\":\"x\"}", "{\"id\":1}", "{\"id\":1,\"method\":7}", "{\"id\":1,\"method\":\"bytes\",\"args\":[1]}", "{\"id\":1,\"part\":\"t\"}")
        for (text in broken) port.receive(java.nio.ByteBuffer.allocate(4 + text.length).putInt(text.length).put(text.toByteArray()).array()) {}
    }

    @Test fun bytesOutsideTheMessageAreRefused() {
        for (place in listOf(listOf(0, 1), listOf(-1, 1), listOf(0, -1), listOf(Int.MAX_VALUE, Int.MAX_VALUE), listOf(1L shl 40, 1L shl 40), listOf("a", "b"), emptyList())) {
            val reply = call("bytes", mapOf("bytes" to mapOf(Frame.BYTES to place)))
            assertFalse("$place", reply.header.getBoolean("ok"))
        }
        assertFalse(call("bytes", mapOf("bytes" to mapOf(Frame.UPLOAD to "made-up"))).header.getBoolean("ok"))
        assertFalse(call("bytes", mapOf("bytes" to mapOf(Frame.UPLOAD to "../../etc/hosts"))).header.getBoolean("ok"))
    }

    @Test fun aMethodThatIsNotThereIsRefused() {
        for (method in listOf("", "toString", "class", "__proto__", "echo ", "hello")) assertEquals("NotSupportedError", call(method).header.getString("name"))
    }

    @Test fun failuresHaveTheirNames() {
        assertEquals("NotFoundError", call("refuse").header.getString("name"))
        assertEquals("OperationError", call("fault").header.getString("name"))
        assertEquals("OperationError", call("memory").header.getString("name"))
        assertEquals("AbortError", call("laterRefused").header.getString("name"))
        assertEquals(7, call("later").header.getInt("value"))
    }

    /** The page may show a message, so an unforeseen one carries no class name and no path. The log has them. */
    @Test fun anUnforeseenFailureIsToldTwice() {
        val reply = call("fault").header
        assertEquals(UNFORESEEN, reply.getString("message"))
        assertEquals(listOf("fault Broken at /storage/emulated/0/Garden."), logged)
        assertEquals("NotReadableError", call("caused").header.getString("name"))
        assertEquals("caused Unreadable.", logged.last())
        call("refuse")
        assertEquals(2, logged.size)
    }

    @Test fun aCallWithNoResultAnswersNoValue() {
        val reply = call("nothing").header
        assertTrue(reply.getBoolean("ok"))
        assertFalse(reply.has("value"))
    }

    @Test fun partsAreGatheredAndUsedOnce() {
        assertTrue(part("t", 0, ByteArray(10) { 1 }))
        assertTrue(part("t", 10, ByteArray(5) { 2 }))
        val args = mapOf("bytes" to mapOf(Frame.UPLOAD to "t"))
        assertEquals(15, call("bytes", args).header.getInt("value"))
        assertFalse(call("bytes", args).header.getBoolean("ok"))
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test fun anUploadThatWasUsedMakesRoomForAnother() {
        repeat(Port.MAX_UPLOADS * 2) {
            assertTrue(part("t$it", 0, ByteArray(1)))
            assertTrue(call("bytes", mapOf("bytes" to mapOf(Frame.UPLOAD to "t$it"))).header.getBoolean("ok"))
        }
    }

    @Test fun aPartOutOfOrderEndsTheUpload() {
        assertTrue(part("t", 0, ByteArray(10)))
        assertFalse(part("t", 20, ByteArray(10)))
        assertFalse(call("bytes", mapOf("bytes" to mapOf(Frame.UPLOAD to "t"))).header.getBoolean("ok"))
        assertEquals(0, dir.listFiles()!!.size)
    }

    @Test fun uploadsAreLimitedAndGoWithThePage() {
        repeat(Port.MAX_UPLOADS) { assertTrue(part("t$it", 0, ByteArray(1))) }
        assertFalse(part("one more", 0, ByteArray(1)))
        send(mapOf("id" to 9, "hello" to true))
        assertEquals(0, dir.listFiles()!!.size)
        assertTrue(part("again", 0, ByteArray(1)))
    }

    @Test fun bytesTooManyForAMessageAreFetchedOnceAndGoStale() {
        val stream = call("big").header.getJSONObject("value").getJSONObject("bytes")
        assertEquals(5 * 1024 * 1024, stream.getInt("size"))
        val token = stream.getString(Frame.STREAM)
        assertTrue(token.length >= 43)
        assertNull(port.takeStream("$token "))
        assertNull(port.takeStream(""))
        assertEquals(5 * 1024 * 1024, port.takeStream(token)!!.bytes().size)
        assertNull(port.takeStream(token))

        val stale = call("big").header.getJSONObject("value").getJSONObject("bytes").getString(Frame.STREAM)
        time += Port.STREAM_LIFE_MS + 1
        assertNull(port.takeStream(stale))
    }

    @Test fun wholeNumbersAreCheckedAndFlagsDefaultToFalse() {
        call("args", mapOf("a" to 5, "b" to 1.5, "c" to -1, "d" to "7", "e" to 1e300))
        val args = seen!!
        assertEquals(5L, args.whole("a"))
        for (name in listOf("b", "c", "d", "e", "f")) assertEquals(name, Failure.OPERATION, runCatching { args.whole(name) }.exceptionOrNull().let { (it as BridgeFailure).failure })
        assertFalse(args.flag("f"))
    }

    @Test fun theScriptHoldsTheInfoAndNoPlaceholder() {
        val template = Files.readString(java.nio.file.Path.of("src/main/res/raw/port.js"))
        val script = Port.script(template, JSONObject(mapOf("platform" to "android")))
        assertTrue(script.contains("const info = {\"platform\":\"android\"}"))
        assertFalse(script.contains("__INFO__"))
        assertTrue(script.contains("'${Port.STREAM_PATH}'"))
        assertArrayEquals(intArrayOf(4 * 1024 * 1024), Regex("CHUNK = (\\d+) \\* 1024 \\* 1024").findAll(script).map { it.groupValues[1].toInt() * 1024 * 1024 }.toList().toIntArray())
    }
}
