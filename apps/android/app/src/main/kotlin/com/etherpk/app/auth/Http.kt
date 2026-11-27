package com.etherpk.app.auth

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

class HttpAnswer(val status: Int, val body: String)

/**
 * The request never left this device: the name was not found, the connection or its TLS handshake
 * failed. The server cannot have acted on it. Any other [IOException] from [Http.ask] may come after
 * the server has acted, which matters for a refresh token that works once.
 */
class NotSent(message: String, cause: Throwable? = null) : IOException(message, cause)

/** One request and its whole answer. Redirects are not followed and no cookie is sent. */
fun interface Http {
    /**
     * A GET when [form] is null. Throws [NotSent] when the request never reached the server, and
     * another [IOException] when there is no whole answer within [budgetMs] of the start.
     */
    fun ask(url: String, headers: Map<String, String>, form: String?, budgetMs: Int): HttpAnswer
}

class UrlConnectionHttp(private val limit: Int = 256 * 1024) : Http {
    override fun ask(url: String, headers: Map<String, String>, form: String?, budgetMs: Int): HttpAnswer {
        val connection = URL(url).openConnection() as HttpURLConnection
        // The budget is for the whole request. The platform's timeouts are for each connect and each
        // read, so an answer that comes a byte at a time would outlast them: this ends it at the budget.
        val deadline = watchdog.schedule({ connection.disconnect() }, budgetMs.toLong(), TimeUnit.MILLISECONDS)
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = budgetMs
            connection.readTimeout = budgetMs
            headers.forEach(connection::setRequestProperty)
            val bytes = form?.toByteArray()
            // The method and the body's length are set before the connection is made: the platform
            // refuses them after, with "Already connected".
            if (bytes != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                // A fixed length also keeps the platform from sending the request again by itself when
                // a reused connection turns out to be closed. A code or a refresh token is sent once.
                connection.setFixedLengthStreamingMode(bytes.size)
            }
            try {
                connection.connect()
            } catch (error: IOException) {
                throw NotSent(error.message ?: error.javaClass.simpleName, error)
            }
            if (bytes != null) connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status < 400) connection.inputStream else connection.errorStream
            return HttpAnswer(status, stream?.use(::text).orEmpty())
        } finally {
            deadline.cancel(false)
            connection.disconnect()
        }
    }

    private companion object {
        val watchdog: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "http-deadline").apply { isDaemon = true }
        }
    }

    private fun text(stream: InputStream): String {
        val bytes = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) return bytes.toString(Charsets.UTF_8.name())
            bytes.write(buffer, 0, count)
            if (bytes.size() > limit) throw IOException("The answer is too long.")
        }
    }
}
