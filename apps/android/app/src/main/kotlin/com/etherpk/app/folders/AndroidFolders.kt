package com.etherpk.app.folders

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import androidx.core.net.toUri
import com.etherpk.app.BuildConfig
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Whether the person has let the app reach shared storage by path. Only the direct build can ask. */
fun hasAllFilesAccess(): Boolean = BuildConfig.ALL_FILES_ACCESS && Environment.isExternalStorageManager()

/** Folders on Android: chosen in the system's dialog, reached by path where the person has allowed it. */
class AndroidFolders(
    private val context: Context,
    private val ask: () -> CompletableFuture<Uri?>,
    /** Where the dialog's answer is taken up: keeping the permission and reading the name ask the provider. */
    private val background: java.util.concurrent.Executor,
    private val byPath: () -> Boolean = ::hasAllFilesAccess,
) : FolderSystem {
    private val trees = ConcurrentHashMap<String, SafTree>()
    private val watchThread = Executors.newSingleThreadScheduledExecutor { Thread(it, "folder-watch") }

    override fun pick(): CompletableFuture<PickedTree> = ask().thenApplyAsync({ uri ->
        if (uri == null) throw BridgeFailure(Failure.ABORT, "The person cancelled.")
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
            context.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (error: SecurityException) {
            throw BridgeFailure(Failure.NOT_ALLOWED, "The folder cannot be written.", error)
        }
        PickedTree(uri.toString(), nameOf(uri))
    }, background)

    private fun tree(uri: String): SafTree = trees.getOrPut(uri) { SafTree(context, uri.toUri()) }

    private fun nameOf(uri: Uri): String = tree(uri.toString()).root()?.name ?: throw folderGone()

    override fun files(grant: FolderGrant): FolderFiles {
        val directory = directoryOf(grant)
        return if (directory != null) DirectFolder(directory.toPath(), ::watch) else SafFolder(tree(grant.tree), grant.path)
    }

    private fun watch(root: java.nio.file.Path, changed: (List<String>?) -> Unit, lost: () -> Unit) = InotifyWatch(root, watchThread, changed, lost)

    /** The folder's path, when the app may use it. */
    private fun directoryOf(grant: FolderGrant): File? {
        if (!byPath()) return null
        val top = primaryPath(grant.tree.toUri()) ?: return null
        return (top + grant.path).fold(Environment.getExternalStorageDirectory()) { at, part -> File(at, part) }
    }

    override fun displayPath(grant: FolderGrant): String? {
        val top = primaryPath(grant.tree.toUri()) ?: return null
        return (listOf(Environment.getExternalStorageDirectory().path) + top + grant.path).joinToString("/")
    }

    override fun treePath(above: String, below: String): List<String>? {
        if (above == below) return emptyList()
        val (one, other) = above.toUri() to below.toUri()
        if (one.authority != other.authority) return null
        if (one.authority == SafTree.EXTERNAL_STORAGE) return pathBetween(DocumentsContract.getTreeDocumentId(one), DocumentsContract.getTreeDocumentId(other))
        return findPath(one, other)
    }

    /** From one shared storage id down to another: `primary:Notes` to `primary:Notes/pages` is `pages`. */
    private fun pathBetween(above: String, below: String): List<String>? {
        val top = if (above.endsWith(":")) above else "$above/"
        return if (above == below) emptyList() else if (below.startsWith(top)) below.removePrefix(top).split('/') else null
    }

    /** Another provider's ids say nothing, so it is asked. One that cannot say has no relation to show. */
    private fun findPath(above: Uri, below: Uri): List<String>? = try {
        val id = DocumentsContract.getTreeDocumentId(below)
        val ids = DocumentsContract.findDocumentPath(context.contentResolver, DocumentsContract.buildDocumentUriUsingTree(above, id))?.path
        ids?.drop(1)?.map { tree(above.toString()).document(it)?.name ?: return null }
    } catch (_: Exception) {
        null
    }

    override fun release(tree: String) {
        trees.remove(tree)
        try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.releasePersistableUriPermission(tree.toUri(), flags)
        } catch (_: SecurityException) {
            // The person took it back first.
        }
    }

    companion object {
        /** The parts below shared storage a tree is at, or null for one on another volume or of another provider. */
        fun primaryPath(tree: Uri): List<String>? {
            if (tree.authority != SafTree.EXTERNAL_STORAGE) return null
            val id = DocumentsContract.getTreeDocumentId(tree)
            if (!id.startsWith("primary:")) return null
            return id.removePrefix("primary:").split('/').filter { it.isNotEmpty() }.takeIf { parts -> parts.none { it == ".." || it == "." } }
        }
    }
}
