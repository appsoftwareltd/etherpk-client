package com.etherpk.app.files

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.system.ErrnoException
import android.system.Os
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.OpenContent
import com.etherpk.app.folders.FileLocks
import com.etherpk.app.folders.FileStamp
import com.etherpk.app.folders.IfStamp
import com.etherpk.app.folders.ReadFile
import com.etherpk.app.folders.checkIfStamp
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

/** What a provider calls a document, as far as it says. */
fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
} catch (_: RuntimeException) {
    // Another app's provider may throw anything.
    null
}

/** One file another app opened in EtherPK, read and written where it is for as long as the system lets it. */
class OpenedDocument(private val resolver: ContentResolver, private val uri: Uri, override val type: String, private val writable: Boolean) : FileSource {
    override val name: String = SharedFiles.safeName(displayName(resolver, uri), 1)

    private fun <T> asking(body: () -> T): T = try {
        body()
    } catch (error: BridgeFailure) {
        throw error
    } catch (error: java.io.FileNotFoundException) {
        throw BridgeFailure(Failure.NOT_FOUND, "The file is gone.", error)
    } catch (error: SecurityException) {
        throw BridgeFailure(Failure.NOT_ALLOWED, "The system no longer lets the app use the file.", error)
    } catch (error: Exception) {
        throw BridgeFailure(Failure.NOT_READABLE, "The app that has the file failed: ${error.message}", error)
    }

    private fun descriptor(): ParcelFileDescriptor = resolver.openFileDescriptor(uri, "r") ?: throw BridgeFailure(Failure.NOT_FOUND, "The file is gone.")

    private fun stampOf(opened: ParcelFileDescriptor): FileStamp = try {
        val stat = Os.fstat(opened.fileDescriptor)
        FileStamp(stat.st_mtim.tv_sec * 1000 + stat.st_mtim.tv_nsec / 1_000_000, stat.st_size)
    } catch (error: ErrnoException) {
        throw BridgeFailure(Failure.NOT_READABLE, "The file says nothing of itself.", error)
    }

    override fun stamp(): FileStamp = asking { descriptor().use(::stampOf) }

    override fun open(): InputStream = asking { ParcelFileDescriptor.AutoCloseInputStream(descriptor()) }

    override fun read(): ReadFile = asking {
        val opened = descriptor()
        val stamp = stampOf(opened)
        val stream = ParcelFileDescriptor.AutoCloseInputStream(opened)
        ReadFile(stamp, if (stamp.size <= SMALL) BytesContent(stream.use { it.readBytes() }) else OpenContent(stream, stamp.size))
    }

    override fun write(content: Content, ifStamp: IfStamp?): FileStamp = synchronized(FileLocks.of(uri)) {
        // Only with the sending app's permission. EtherPK may reach the file with rights of its own (a
        // folder the person chose, or All files access), which the sender did not give.
        if (!writable) throw BridgeFailure(Failure.NO_MODIFICATION, "The app that has the file lets it be read only.")
        checkIfStamp(stamp(), ifStamp)
        try {
            writeInPlace(resolver, uri, content)
        } catch (error: SecurityException) {
            throw BridgeFailure(Failure.NO_MODIFICATION, "The app that has the file lets it be read only.", error)
        }
        stamp()
    }

    override fun release() {}

    private companion object {
        const val SMALL = 1024 * 1024L
    }
}

private fun writeInPlace(resolver: ContentResolver, uri: Uri, content: Content) {
    val opened = resolver.openFileDescriptor(uri, "wt") ?: throw BridgeFailure(Failure.NOT_FOUND, "The file is gone.")
    opened.use { descriptor -> FileOutputStream(descriptor.fileDescriptor).let { out -> content.open().use { it.copyTo(out) } } }
}

/** A document the save dialog made. It is empty until the copy is whole. */
class SavedDocument(private val resolver: ContentResolver, private val uri: Uri, asked: String) : SaveTarget {
    override val name: String = displayName(resolver, uri) ?: asked

    override fun commit(from: File) {
        try {
            from.inputStream().use { input -> (resolver.openOutputStream(uri, "wt") ?: throw BridgeFailure(Failure.NOT_FOUND, "The file is gone.")).use { input.copyTo(it) } }
        } catch (error: BridgeFailure) {
            throw error
        } catch (error: Exception) {
            throw BridgeFailure(if ("ENOSPC" in error.message.orEmpty()) Failure.QUOTA else Failure.OPERATION, "The copy could not be written: ${error.message}", error)
        }
    }

    override fun abandon() {
        try {
            // Only what the dialog made and nobody has written to. A file there before keeps its content.
            val empty = resolver.openFileDescriptor(uri, "r")?.use { it.statSize } == 0L
            if (empty) DocumentsContract.deleteDocument(resolver, uri)
        } catch (_: Exception) {
            // An empty file stays, which the person can delete.
        }
    }
}
