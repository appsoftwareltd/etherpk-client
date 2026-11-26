package com.etherpk.app.bridge

import java.io.File
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import org.json.JSONObject

/**
 * The shell's end of `window.etherpkNative` (port.js is the page's). It reads the page's messages, has
 * the [dispatcher] answer them on [workers], and keeps the two kinds of bytes too large for one
 * message: those the page sends in parts, and those it fetches.
 */
class Port(
    private val dispatcher: Dispatcher,
    private val workers: Executor,
    private val uploadsDir: File,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val uploads = ConcurrentHashMap<String, File>()
    private val streams = ConcurrentHashMap<String, Waiting>()

    private class Waiting(val content: Content, val until: Long)

    /** One message from the page. [send] answers it, from any thread. */
    fun receive(message: ByteArray, send: (ByteArray) -> Unit) {
        val frame = Frame.read(message) ?: return
        val id = frame.header.optLong("id", -1)
        if (id < 0) return
        // A new document: what the one before left half done goes, before any call of this one runs.
        if (frame.header.optBoolean("hello")) return reset()
        workers.execute {
            val part = frame.header.opt("part") as? String
            if (part != null) {
                send(reply(id, gather(part, frame)))
            } else {
                call(frame) { send(reply(id, it)) }
            }
        }
    }

    private fun call(frame: Frame.Incoming, answer: (Reply) -> Unit) {
        val used = ArrayList<Content>()
        val method = frame.header.opt("method") as? String ?: ""
        val args = try {
            frame.value("args") { token -> uploads.remove(token)?.let(::UploadContent)?.also(used::add) } as? Map<*, *>
        } catch (error: BridgeFailure) {
            used.forEach(Content::release)
            answer(Reply.Refused(error.failure, error.message.orEmpty()))
            return
        }
        @Suppress("UNCHECKED_CAST")
        dispatcher.call(method, args as Map<String, Any?>? ?: emptyMap()) { reply ->
            used.forEach(Content::release)
            answer(reply)
        }
    }

    /** Adds a part to the bytes the page is sending. A part says where it goes, so a wrong order is seen. */
    private fun gather(token: String, frame: Frame.Incoming): Reply = try {
        // The name of the file is ours, from a number, whatever the page calls it.
        val file = uploads.getOrPut(token) {
            if (uploads.size >= MAX_UPLOADS) throw BridgeFailure(Failure.QUOTA, "Too many files are being sent at once.")
            uploadsDir.mkdirs()
            File.createTempFile("upload", null, uploadsDir)
        }
        val offset = frame.header.optLong("offset", -1)
        if (offset != file.length()) throw BridgeFailure(Failure.OPERATION, "A part of the bytes is missing.")
        RandomAccessFile(file, "rw").use {
            it.seek(offset)
            it.write(frame.body().bytes())
        }
        Reply.Value(null)
    } catch (error: BridgeFailure) {
        uploads.remove(token)?.delete()
        Reply.Refused(error.failure, error.message.orEmpty())
    } catch (error: java.io.IOException) {
        uploads.remove(token)?.delete()
        Reply.Refused(Failure.QUOTA, "The bytes could not be kept: ${error.message}")
    }

    private fun reply(id: Long, reply: Reply): ByteArray {
        val header = when (reply) {
            is Reply.Value -> mapOf("id" to id, "ok" to true) + if (reply.value == Unit) emptyMap() else mapOf("value" to reply.value)
            is Reply.Refused -> refusal(id, reply)
        }
        return try {
            Frame.write(header, INLINE_LIMIT, ::stream)
        } catch (error: Throwable) {
            // The file went, or there was no memory for it, between its being found and its being sent.
            Frame.write(refusal(id, Reply.Refused(Failure.NOT_READABLE, "The answer could not be sent: ${error.message}")), INLINE_LIMIT, ::stream)
        }
    }

    private fun refusal(id: Long, reply: Reply.Refused) = mapOf("id" to id, "ok" to false, "name" to reply.failure, "message" to reply.message)

    fun event(name: String, detail: Any?): ByteArray = Frame.write(mapOf("event" to name, "detail" to detail), INLINE_LIMIT, ::stream)

    /** Keeps bytes for one fetch. The token cannot be guessed, is used once, and goes stale. */
    private fun stream(content: Content): String {
        dropStale()
        val token = ByteArray(32).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        streams[token] = Waiting(content, now() + STREAM_LIFE_MS)
        return token
    }

    /** The bytes behind a token, once. */
    fun takeStream(token: String): Content? {
        dropStale()
        return streams.remove(token)?.content
    }

    private fun dropStale() {
        for ((token, waiting) in streams) if (waiting.until < now() && streams.remove(token, waiting)) waiting.content.release()
    }

    /** Drops what a page that is gone left half done. */
    fun reset() {
        uploads.keys.toList().forEach { uploads.remove(it)?.delete() }
        streams.keys.toList().forEach { streams.remove(it)?.content?.release() }
        uploadsDir.listFiles()?.forEach(File::delete)
    }

    companion object {
        /** Bytes in one message. More are fetched. */
        const val INLINE_LIMIT = 4L * 1024 * 1024
        const val STREAM_LIFE_MS = 60_000L
        const val MAX_UPLOADS = 16
        /** Where the page fetches bytes too large for a message. The rest of the path is the token. */
        const val STREAM_PATH = "/__native/bytes/"
        private val random = SecureRandom()

        /** The script that puts the port on the page, with what it must know before the first call. */
        fun script(template: String, info: JSONObject): String = template.replace("\"__INFO__\"", info.toString())
    }
}
