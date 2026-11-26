package com.etherpk.app.bridge

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * One message between the page and the shell: a length, a JSON header of that length, and bytes.
 *
 * Bytes inside the header's values are written as `{"$bytes": [offset, length]}`, a place in the bytes
 * that follow, so nothing is turned into text on its way. port.js is the other end.
 */
object Frame {
    const val BYTES = "\$bytes"
    /** Bytes the page sent before, in parts. */
    const val UPLOAD = "\$upload"
    /** Bytes the page fetches after, being too many for one message. */
    const val STREAM = "\$stream"

    class Incoming(val header: JSONObject, private val message: ByteArray, private val bodyAt: Int) {
        fun body(): BytesContent = BytesContent(message, bodyAt)

        /** One value of the header, with each reference to bytes replaced by them. */
        fun value(name: String, upload: (String) -> Content? = { null }): Any? = decode(header.opt(name), upload)

        private fun decode(value: Any?, upload: (String) -> Content?): Any? = when (value) {
            null, JSONObject.NULL -> null
            is JSONArray -> List(value.length()) { decode(value.opt(it), upload) }
            is JSONObject -> decodeBytes(value, upload) ?: decodeObject(value, upload)
            else -> value
        }

        private fun decodeObject(value: JSONObject, upload: (String) -> Content?): Map<String, Any?> =
            value.keys().asSequence().associateWith { decode(value.opt(it), upload) }

        private fun decodeBytes(value: JSONObject, upload: (String) -> Content?): Content? {
            if (value.length() != 1) return null
            (value.opt(UPLOAD) as? String)?.let { return upload(it) ?: throw BridgeFailure(Failure.OPERATION, "The bytes sent before are gone.") }
            val place = value.opt(BYTES) as? JSONArray ?: return null
            val offset = place.optLong(0, -1)
            val length = place.optLong(1, -1)
            if (offset < 0 || length < 0 || offset + length > message.size - bodyAt) throw BridgeFailure(Failure.OPERATION, "The bytes are outside the message.")
            return BytesContent(message, bodyAt + offset.toInt(), length.toInt())
        }
    }

    /** Null for a message that is not a frame. */
    fun read(message: ByteArray): Incoming? {
        if (message.size < 4) return null
        val length = ByteBuffer.wrap(message).int
        if (length < 2 || length > message.size - 4) return null
        val header = try {
            JSONObject(String(message, 4, length, Charsets.UTF_8))
        } catch (_: JSONException) {
            return null
        }
        return Incoming(header, message, 4 + length)
    }

    /**
     * A message from a header whose values may hold [Content]. Content larger than [inlineLimit] is
     * given to [stream], which answers the token the page fetches it with.
     */
    fun write(header: Map<String, Any?>, inlineLimit: Long, stream: (Content) -> String): ByteArray {
        val body = ByteArrayOutputStream()
        val json = encode(header, body, inlineLimit, stream).toString().toByteArray(Charsets.UTF_8)
        val message = ByteBuffer.allocate(4 + json.size + body.size())
        message.putInt(json.size).put(json).put(body.toByteArray())
        return message.array()
    }

    private fun encode(value: Any?, body: ByteArrayOutputStream, limit: Long, stream: (Content) -> String): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { json -> value.forEach { (key, one) -> json.put(key as String, encode(one, body, limit, stream)) } }
        is List<*> -> JSONArray().also { json -> value.forEach { json.put(encode(it, body, limit, stream)) } }
        // The limit is on the whole message, so many small files do not add up to one no heap can hold.
        is Content -> if (body.size() + value.size > limit) JSONObject().put(STREAM, stream(value)).put("size", value.size) else inline(value, body)
        else -> value
    }

    private fun inline(content: Content, body: ByteArrayOutputStream): JSONObject {
        val offset = body.size()
        content.open().use { it.copyTo(body) }
        content.release()
        return JSONObject().put(BYTES, JSONArray().put(offset).put(body.size() - offset))
    }
}
