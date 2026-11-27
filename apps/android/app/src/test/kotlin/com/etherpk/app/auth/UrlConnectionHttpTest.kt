package com.etherpk.app.auth

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.ServerSocket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The app's one way to the account site, over a real socket. The sign-in's own tests use a stand-in
 * for it, which is how a POST that never left this device went out in the 1.0.4 Android app: every code
 * exchange and refresh failed with "Already connected", and a sign-in ended with "The sign-in was not
 * completed".
 */
class UrlConnectionHttpTest {
    private lateinit var server: HttpServer
    private val seen = ArrayList<String>()

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            synchronized(seen) {
                seen.add("${exchange.requestMethod} ${exchange.requestURI.path} origin=${exchange.requestHeaders.getFirst("Origin")} type=${exchange.requestHeaders.getFirst("Content-Type")} body=$body")
            }
            val status = if (exchange.requestURI.path == "/refused") 400 else 200
            val answer = """{"path":"${exchange.requestURI.path}"}""".toByteArray()
            exchange.sendResponseHeaders(status, answer.size.toLong())
            exchange.responseBody.use { it.write(answer) }
        }
        server.start()
    }

    @After
    fun stop() = server.stop(0)

    private fun url(path: String) = "http://127.0.0.1:${server.address.port}$path"

    @Test
    fun `posts a form with its headers and reads the answer`() {
        val answer = UrlConnectionHttp().ask(
            url("/token"),
            mapOf("Origin" to "https://accounts.example", "Content-Type" to "application/x-www-form-urlencoded"),
            "grant_type=authorization_code&code=garden",
            5_000,
        )
        assertEquals(200, answer.status)
        assertEquals("""{"path":"/token"}""", answer.body)
        assertEquals(listOf("POST /token origin=https://accounts.example type=application/x-www-form-urlencoded body=grant_type=authorization_code&code=garden"), seen)
    }

    @Test
    fun `reads a refusal's answer from the error stream`() {
        val answer = UrlConnectionHttp().ask(url("/refused"), emptyMap(), "token=beans", 5_000)
        assertEquals(400, answer.status)
        assertEquals("""{"path":"/refused"}""", answer.body)
    }

    @Test
    fun `gets without a body when there is no form`() {
        val answer = UrlConnectionHttp().ask(url("/.well-known/openid-configuration"), mapOf("Accept" to "application/json"), null, 5_000)
        assertEquals(200, answer.status)
        assertEquals(listOf("GET /.well-known/openid-configuration origin=null type=null body="), seen)
    }

    @Test
    fun `says a request to a port nobody listens on was never sent`() {
        val closed = ServerSocket(0, 0, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val thrown = runCatching { UrlConnectionHttp().ask("http://127.0.0.1:$closed/token", emptyMap(), "code=garden", 5_000) }.exceptionOrNull()
        assertTrue("$thrown", thrown is NotSent)
    }
}
