package com.etherpk.app.folders

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Process
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.io.FileNotFoundException
import java.util.concurrent.ConcurrentHashMap

/** One document of a tree, as its provider describes it now. */
class SafDocument(val id: String, val name: String, val directory: Boolean, val stamp: FileStamp, val flags: Int)

/**
 * A tree the person chose, reached through the system's document provider. It finds documents by path
 * and remembers their ids, since every question to a provider goes to another process.
 */
class SafTree(private val context: Context, val uri: Uri) {
    val resolver: ContentResolver = context.contentResolver
    private val rootId: String = DocumentsContract.getTreeDocumentId(uri)
    /** The ids of shared storage are paths, so a child's id is known without listing its directory. */
    val idsArePaths = uri.authority == EXTERNAL_STORAGE
    private val ids = ConcurrentHashMap<List<String>, String>()
    /** Held to make a directory, so two calls do not make two. */
    val making = Any()

    fun uriOf(id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(uri, id)

    fun permitted(): Boolean {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        return context.checkUriPermission(uri, Process.myPid(), Process.myUid(), flags) == PackageManager.PERMISSION_GRANTED
    }

    fun root(): SafDocument? = document(rootId)

    /** The document at a path from the tree's root, or null. */
    fun find(path: List<String>): SafDocument? {
        if (path.isEmpty()) return root()
        ids[path]?.let { known ->
            // Where ids are not paths, a directory above may have another name now.
            val document = if (idsArePaths || find(path.dropLast(1)) != null) document(known) else null
            // An id can outlive its place: another program may have moved the document it names.
            if (document != null && composed(document.name) == composed(path.last())) return document
            forget(path)
        }
        val parent = find(path.dropLast(1)) ?: return null
        if (!parent.directory) return null
        val found = child(parent, path.last()) ?: return null
        ids[path] = found.id
        return found
    }

    private fun child(parent: SafDocument, name: String): SafDocument? {
        if (idsArePaths) {
            document(childId(parent.id, name))?.let { return it }
            // ASCII has one form, so there is no other spelling to look for.
            if (name.all { it.code < 128 }) return null
        }
        val all = children(parent.id)
        return all.firstOrNull { it.name == name } ?: all.firstOrNull { composed(it.name) == composed(name) }
    }

    private fun childId(parent: String, name: String) = if (parent.endsWith(":")) parent + name else "$parent/$name"

    /** The documents directly in a directory, remembered under [path] when it is given. */
    fun children(id: String, path: List<String>? = null): List<SafDocument> {
        val all = query(DocumentsContract.buildChildDocumentsUriUsingTree(uri, id)) { cursor -> generateSequence { if (cursor.moveToNext()) read(cursor) else null }.filterNotNull().toList() }
        if (path != null) all.forEach { ids[path + composed(it.name)] = it.id }
        return all
    }

    /** A document by its id, or null when it is not there. */
    fun document(id: String): SafDocument? = try {
        query(uriOf(id)) { if (it.moveToFirst()) read(it) else null }
    } catch (error: BridgeFailure) {
        if (error.failure == Failure.NOT_FOUND) null else throw error
    }

    /**
     * A provider answers no cursor at all when its process has died or is starting again. That is not
     * a folder or a document that is gone, which a provider says with an exception or no rows.
     */
    private fun <T> query(address: Uri, read: (Cursor) -> T): T {
        val cursor = try {
            resolver.query(address, COLUMNS, null, null, null)
        } catch (error: Exception) {
            throw named(error)
        } ?: throw BridgeFailure(Failure.OPERATION, "The app that keeps the folder did not answer.")
        return cursor.use(read)
    }

    private fun read(cursor: Cursor): SafDocument? {
        val id = cursor.getString(0) ?: return null
        val name = cursor.getString(1) ?: return null
        val directory = cursor.getString(2) == Document.MIME_TYPE_DIR
        val modified = if (cursor.isNull(3)) 0 else cursor.getLong(3)
        val size = if (cursor.isNull(4)) 0 else cursor.getLong(4)
        return SafDocument(id, name, directory, FileStamp(modified, size), cursor.getInt(5))
    }

    /** Forgets the ids at a path and below it. */
    fun forget(path: List<String>) {
        ids.keys.removeIf { it.size >= path.size && it.subList(0, path.size) == path }
    }

    fun remember(path: List<String>, id: String) { ids[path] = id }

    /** Runs a question to the provider, and names what it threw. Any provider may throw anything. */
    fun <T> asking(body: () -> T): T = try {
        body()
    } catch (error: BridgeFailure) {
        throw error
    } catch (error: Exception) {
        throw named(error)
    }

    private fun named(error: Exception): BridgeFailure {
        val said = generateSequence<Throwable>(error) { it.cause }.joinToString { "${it.javaClass.simpleName}: ${it.message}" }
        return when {
            error is BridgeFailure -> error
            error is FileNotFoundException || "FileNotFoundException" in said || "Missing file" in said -> BridgeFailure(Failure.NOT_FOUND, said, error)
            error is SecurityException -> BridgeFailure(if (permitted()) Failure.NOT_FOUND else Failure.NOT_ALLOWED, said, error)
            error is UnsupportedOperationException -> BridgeFailure(Failure.NOT_SUPPORTED, said, error)
            "ENOSPC" in said || "No space" in said -> BridgeFailure(Failure.QUOTA, said, error)
            else -> BridgeFailure(Failure.OPERATION, said, error)
        }
    }

    companion object {
        const val EXTERNAL_STORAGE = "com.android.externalstorage.documents"
        private val COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_SIZE, Document.COLUMN_FLAGS,
        )
    }
}
