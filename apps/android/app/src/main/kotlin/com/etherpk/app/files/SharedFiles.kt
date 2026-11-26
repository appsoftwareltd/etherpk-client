package com.etherpk.app.files

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.OpenContent
import com.etherpk.app.folders.FileStamp
import com.etherpk.app.folders.IfStamp
import com.etherpk.app.folders.ReadFile
import com.etherpk.app.folders.composed
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/** One stream another app shared, before any of it is read. Nothing it says about itself is trusted. */
class Offered(val name: String?, val type: String?, val open: () -> InputStream?)

/** What was kept of a share, and how many files were not. */
class Received(val files: List<FileSource>, val missed: Int)

/**
 * Copies what another app shared into the app's private storage at once, as the permission to read it
 * may end with the screen that received it. Copies have names of ours: a name an app gives its file
 * can be a path to somewhere else.
 */
class SharedFiles(private val dir: File, private val mostFiles: Int = MOST_FILES, private val mostBytes: Long = MOST_BYTES) {
    /** Drops what a start of the app before this one left. No id leads to it. */
    fun clear() { dir.deleteRecursively() }

    fun receive(offered: List<Offered>): Received {
        dir.mkdirs()
        val kept = ArrayList<FileSource>()
        var left = mostBytes
        for (one in offered.take(mostFiles)) {
            val file = File(dir, UUID.randomUUID().toString())
            val size = copy(one, file, left)
            if (size == null) {
                file.delete()
                continue
            }
            left -= size
            kept.add(SharedFile(file, safeName(one.name, kept.size + 1), one.type?.takeIf(::isType) ?: ""))
        }
        return Received(kept, offered.size - kept.size)
    }

    /** The bytes copied, or null when there are too many or the app that shared them fails. */
    private fun copy(offered: Offered, to: File, limit: Long): Long? = try {
        offered.open()?.use { stream -> to.outputStream().use { out -> copyUpTo(stream, out, limit) } }
    } catch (_: IOException) {
        null
    } catch (_: RuntimeException) {
        // Another app's provider: a security refusal, or any exception it lets through.
        null
    }

    private fun copyUpTo(from: InputStream, to: java.io.OutputStream, limit: Long): Long? {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val count = from.read(buffer)
            if (count < 0) return total
            total += count
            if (total > limit) return null
            to.write(buffer, 0, count)
        }
    }

    companion object {
        /**
         * The Client's limits for one share (MAX_SHARED_FILES and MAX_SHARED_BYTES in
         * apps/client/src/lib/share/share-limits.ts). The page keeps no more, so the shell copies no more.
         */
        const val MOST_FILES = 20
        const val MOST_BYTES = 100L * 1024 * 1024
        private const val LONGEST_NAME = 120

        /** A name to show and to suggest, with nothing in it that means anything to a file system. */
        fun safeName(name: String?, number: Int): String {
            val last = composed(name.orEmpty()).substringAfterLast('/').substringAfterLast('\\')
            val shown = last.filter { !it.isISOControl() && it.category != CharCategory.FORMAT && it !in "<>:\"|?*" }.trim().trimStart('.')
            if (shown.isEmpty()) return "Shared file $number"
            if (shown.length <= LONGEST_NAME) return shown
            val extension = shown.substringAfterLast('.', "").take(10)
            return shown.take(LONGEST_NAME - extension.length - 1).trimEnd() + if (extension.isEmpty()) "" else ".$extension"
        }
    }
}

private class SharedFile(private val file: File, override val name: String, override val type: String) : FileSource {
    private val stamp = FileStamp(file.lastModified(), file.length())
    override fun stamp() = stamp
    override fun open(): InputStream = try {
        file.inputStream()
    } catch (error: IOException) {
        throw BridgeFailure(Failure.NOT_FOUND, "The shared file is gone.", error)
    }
    override fun read() = ReadFile(stamp, if (stamp.size <= SMALL) BytesContent(open().use { it.readBytes() }) else OpenContent(open(), stamp.size))
    override fun write(content: Content, ifStamp: IfStamp?): FileStamp = throw BridgeFailure(Failure.NO_MODIFICATION, "A shared file cannot be written.")
    override fun release() { file.delete() }

    private companion object {
        const val SMALL = 1024 * 1024L
    }
}

/** A media type as `type/subtype`, with nothing else in it. What another app says a file is may be anything. */
fun isType(type: String) = type.length <= 127 && type.matches(Regex("[\\w.+-]+/[\\w.+-]+"))
