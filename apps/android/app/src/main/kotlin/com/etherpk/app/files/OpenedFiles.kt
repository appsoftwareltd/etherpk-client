package com.etherpk.app.files

import com.etherpk.app.bridge.Arguments
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.Handler
import com.etherpk.app.folders.FileStamp
import com.etherpk.app.folders.IfStamp
import com.etherpk.app.folders.ReadFile
import com.etherpk.app.folders.ifStamp
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** One file the person shared, opened or chose. */
interface FileSource {
    val name: String
    val type: String
    fun stamp(): FileStamp
    fun read(): ReadFile
    fun open(): InputStream
    fun write(content: Content, ifStamp: IfStamp?): FileStamp
    /** The app is done with it. */
    fun release()
}

/** Files by the ids the page knows them by. An id lasts as long as the app's process. */
class OpenedFiles {
    private val files = ConcurrentHashMap<String, FileSource>()

    val handlers: Map<String, Handler> = mapOf(
        "files.read" to { args -> get(args).let { file -> file.read().let { mapOf("bytes" to it.content) + describe(args.text("file"), file, it.stamp) } } },
        "files.readPart" to { args -> mapOf("bytes" to part(get(args).open(), args.whole("offset"), args.whole("length"))) },
        "files.write" to { args -> get(args).write(args.content("bytes"), ifStamp(args)).let { mapOf("lastModified" to it.lastModified, "size" to it.size) } },
        "files.release" to { args -> files.remove(args.text("file"))?.release().let { } },
    )

    /** A `FileInfo` of the file, under a new id. */
    fun add(file: FileSource): Map<String, Any?> {
        val id = UUID.randomUUID().toString()
        files[id] = file
        return describe(id, file, file.stamp())
    }

    private fun get(args: Arguments): FileSource =
        files[args.text("file")] ?: throw BridgeFailure(Failure.NOT_ALLOWED, "The app has no permission for this file.")

    private fun describe(id: String, file: FileSource, stamp: FileStamp) = mapOf(
        "id" to id, "name" to file.name, "size" to stamp.size, "lastModified" to stamp.lastModified, "type" to file.type, "displayPath" to null,
    )

    private fun part(stream: InputStream, offset: Long, length: Long): Content = stream.use {
        // The page asks for what it can hold, and a part larger than this would not fit a heap.
        val wanted = length.coerceAtMost(MOST_AT_ONCE).toInt()
        var left = offset
        while (left > 0) {
            val skipped = it.skip(left)
            if (skipped <= 0) {
                if (it.read() < 0) return@use BytesContent(ByteArray(0))
                left -= 1
            } else {
                left -= skipped
            }
        }
        val bytes = ByteArray(wanted)
        var at = 0
        while (at < wanted) {
            val count = it.read(bytes, at, wanted - at)
            if (count < 0) break
            at += count
        }
        BytesContent(bytes, 0, at)
    }

    private companion object {
        const val MOST_AT_ONCE = 64L * 1024 * 1024
    }
}
