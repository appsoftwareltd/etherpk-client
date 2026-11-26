package com.etherpk.testapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException
import java.util.UUID

/**
 * A document provider whose ids say nothing, that adds a number to a name that is taken, and that a
 * test can ask to act as another program. It stands for every provider that is not shared storage.
 */
class TestDocuments : DocumentsProvider() {
    private val files = HashMap<String, File>()
    private val ids = HashMap<File, String>()
    private val top get() = File(context!!.cacheDir, "documents")
    private var canMove = true

    override fun onCreate(): Boolean = true

    @Synchronized private fun idOf(file: File): String = ids.getOrPut(file) { UUID.randomUUID().toString().also { files[it] = file } }

    @Synchronized private fun fileOf(id: String): File = (if (id == ROOT) top else files[id])?.takeIf { it.exists() } ?: throw FileNotFoundException("Missing file for $id")

    @Synchronized private fun moved(from: File, to: File) {
        for ((file, id) in ids.toMap()) {
            if (file != from && !file.startsWith(from)) continue
            val now = if (file == from) to else File(to, file.relativeTo(from).path)
            ids.remove(file)
            ids[now] = id
            files[id] = now
        }
    }

    private fun row(cursor: MatrixCursor, id: String, file: File) {
        val flags = Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_DIR_SUPPORTS_CREATE or
            if (canMove) Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE else 0
        cursor.newRow().add(Document.COLUMN_DOCUMENT_ID, id).add(Document.COLUMN_DISPLAY_NAME, file.name)
            .add(Document.COLUMN_MIME_TYPE, if (file.isDirectory) Document.MIME_TYPE_DIR else "text/plain")
            .add(Document.COLUMN_LAST_MODIFIED, file.lastModified()).add(Document.COLUMN_SIZE, file.length()).add(Document.COLUMN_FLAGS, flags)
    }

    override fun queryRoots(projection: Array<out String>?): Cursor = MatrixCursor(arrayOf(DocumentsContract.Root.COLUMN_ROOT_ID))

    override fun queryDocument(id: String, projection: Array<out String>?): Cursor = MatrixCursor(COLUMNS).also { row(it, id, fileOf(id)) }

    override fun queryChildDocuments(parent: String, projection: Array<out String>?, order: String?): Cursor =
        MatrixCursor(COLUMNS).also { cursor -> fileOf(parent).listFiles()!!.forEach { row(cursor, idOf(it), it) } }

    override fun isChildDocument(parent: String, child: String): Boolean = fileOf(child).startsWith(fileOf(parent))

    override fun findDocumentPath(parent: String?, child: String): DocumentsContract.Path {
        val path = generateSequence(fileOf(child)) { it.parentFile }.takeWhile { it != fileOf(parent!!) }.toList().reversed()
        return DocumentsContract.Path(null, listOf(parent!!) + path.map(::idOf))
    }

    override fun openDocument(id: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileOf(id), ParcelFileDescriptor.parseMode(mode))

    private fun free(parent: File, name: String): File = generateSequence(0) { it + 1 }.map { if (it == 0) File(parent, name) else File(parent, "$name ($it)") }.first { !it.exists() }

    @Synchronized override fun createDocument(parent: String, type: String, name: String): String {
        val file = free(fileOf(parent), name)
        if (type == Document.MIME_TYPE_DIR) file.mkdir() else file.createNewFile()
        return idOf(file)
    }

    override fun deleteDocument(id: String) { fileOf(id).deleteRecursively() }

    override fun renameDocument(id: String, name: String): String? {
        val file = fileOf(id)
        val to = free(file.parentFile!!, name)
        file.renameTo(to)
        moved(file, to)
        return null
    }

    override fun moveDocument(id: String, from: String, to: String): String {
        val file = fileOf(id)
        val target = File(fileOf(to), file.name)
        check(!target.exists())
        file.renameTo(target)
        moved(file, target)
        return id
    }

    /** What a test asks another program to do. */
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val act = method.removePrefix("test:")
        if (act == method) return super.call(method, arg, extras)
        val file = if (arg.isNullOrEmpty()) top else File(top, arg)
        val answer = Bundle()
        when (act) {
            "clear" -> { top.deleteRecursively(); top.mkdirs(); files.clear(); ids.clear(); canMove = extras!!.getBoolean("canMove") }
            "write" -> { file.parentFile!!.mkdirs(); file.writeText(extras!!.getString("text")!!) }
            "read" -> answer.putString("text", if (file.isFile) file.readText() else null)
            "makeDirectory" -> file.mkdirs()
            "remove" -> file.deleteRecursively()
            "names" -> answer.putStringArray("names", file.list().orEmpty())
            "id" -> answer.putString("id", if (file == top) ROOT else idOf(file))
        }
        return answer
    }

    companion object {
        const val AUTHORITY = "com.etherpk.testapp.documents"
        const val ROOT = "root"
        private val COLUMNS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_SIZE, Document.COLUMN_FLAGS)
    }
}

/** Gives the app a tree of the provider, as the system's dialog does. */
class TestDocumentsGrant : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val tree = DocumentsContract.buildTreeDocumentUri(TestDocuments.AUTHORITY, intent.getStringExtra("id"))
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        context.grantUriPermission("com.etherpk.app", tree, flags)
        setResultCode(1)
    }
}
