package com.etherpk.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.etherpk.app.auth.KeystoreTokenStore
import com.etherpk.app.auth.UrlConnectionHttp
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** The parts of a sign-in that only a device has: its HTTP client and its Keystore. */
@RunWith(AndroidJUnit4::class)
class SignInPartsTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val file = File(context.cacheDir, "sign-in-test")
    private val problems = ArrayList<String>()

    @After fun clear() { file.delete() }

    private fun store(issuer: String = "https://accounts.example") = KeystoreTokenStore(file, issuer) { message, _ -> problems.add(message) }

    @Test fun theTokenIsKeptEncryptedAndOnlyForItsIssuer() {
        assertNull(store().load())
        store().save("a-refresh-token")
        assertEquals("a-refresh-token", store().load())
        assertFalse(file.readBytes().decodeToString().contains("a-refresh-token"))
        assertNull(store("https://other.example").load())
        store().save("the-next-one")
        assertEquals("the-next-one", store().load())
        assertFalse(File(file.path + ".partial").exists())
        store().clear()
        assertNull(store().load())
        assertTrue(problems.isEmpty())
    }

    @Test fun aFileThatWasChangedIsNoSignIn() {
        store().save("a-refresh-token")
        file.writeBytes(file.readBytes().also { it[20] = (it[20] + 1).toByte() })
        assertNull(store().load())
        file.writeBytes(ByteArray(3))
        assertNull(store().load())
        assertEquals(2, problems.size)
    }

    /** One connection: what was asked, and the answer given. A null answer closes it unanswered. */
    private fun serve(answer: String?): Pair<Int, CompletableFuture<String>> {
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val asked = CompletableFuture<String>()
        Thread {
            server.use {
                val connection = it.accept()
                val input = connection.getInputStream().buffered()
                val head = StringBuilder()
                while (!head.endsWith("\r\n\r\n")) head.append(input.read().toChar())
                val length = Regex("content-length: (\\d+)", RegexOption.IGNORE_CASE).find(head)?.groupValues?.get(1)?.toInt() ?: 0
                asked.complete(head.toString() + ByteArray(length).also { body -> java.io.DataInputStream(input).readFully(body) }.decodeToString())
                if (answer != null) connection.getOutputStream().apply { write(answer.toByteArray()); flush() }
                connection.close()
            }
        }.start()
        return server.localPort to asked
    }

    @Test fun aFormIsPostedWithItsOriginAndNoCookies() {
        val (port, asked) = serve("HTTP/1.1 400 Bad Request\r\nSet-Cookie: a=b\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
        val headers = mapOf("Origin" to "https://accounts.example", "Content-Type" to "application/x-www-form-urlencoded")
        val answer = UrlConnectionHttp().ask("http://127.0.0.1:$port/token", headers, "a=b+c&d=%2F", 5000)
        assertEquals(400, answer.status)
        assertEquals("{}", answer.body)
        val request = asked.get(5, TimeUnit.SECONDS)
        assertTrue(request, request.startsWith("POST /token HTTP/1.1"))
        assertTrue(request, request.contains("Origin: https://accounts.example\r\n", ignoreCase = true))
        assertTrue(request, request.contains("Content-Type: application/x-www-form-urlencoded\r\n", ignoreCase = true))
        assertFalse(request, request.contains("cookie", ignoreCase = true))
        assertTrue(request, request.endsWith("a=b+c&d=%2F"))
    }

    @Test fun aRedirectIsNotFollowedAndALongAnswerIsRefused() {
        val (port) = serve("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        assertEquals(302, UrlConnectionHttp().ask("http://127.0.0.1:$port/", emptyMap(), null, 5000).status)
        val (long) = serve("HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\n" + "x".repeat(20))
        assertTrue(runCatching { UrlConnectionHttp(10).ask("http://127.0.0.1:$long/", emptyMap(), null, 5000) }.isFailure)
    }

    @Test fun aRequestWithNoAnswerIsSentOnce() {
        val connections = java.util.concurrent.atomic.AtomicInteger()
        ServerSocket(0, 5, InetAddress.getByName("127.0.0.1")).use { server ->
            val thread = Thread {
                try {
                    while (true) server.accept().also { connections.incrementAndGet() }.close()
                } catch (_: java.io.IOException) {
                    // Closed: the test is over.
                }
            }
            thread.start()
            assertTrue(runCatching { UrlConnectionHttp().ask("http://127.0.0.1:${server.localPort}/", emptyMap(), "a=b", 3000) }.exceptionOrNull() is java.io.IOException)
            Thread.sleep(500)
        }
        assertEquals(1, connections.get())
    }
}
