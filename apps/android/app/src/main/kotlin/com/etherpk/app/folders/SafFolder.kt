package com.etherpk.app.folders

import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.OpenContent
import java.io.Closeable
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

/**
 * A chosen folder reached through the system's document provider, which needs no permission beyond the
 * person's choice. It is slower than a path, a write goes into the file itself, and changes other
 * programs make are not reported.
 */
class SafFolder(private val tree: SafTree, private val base: List<String>) : FolderFiles {
    override fun check() {
        if (!tree.permitted()) throw BridgeFailure(Failure.NOT_ALLOWED, "The app has no permission for this folder.")
        if (tree.find(base)?.directory == true) return
        // Asked again from the root, with nothing remembered, before the folder is called gone: the
        // page asks the person to choose a gone folder again, so a wrong answer costs them a step.
        tree.forget(base)
        if (tree.find(base)?.directory != true) throw folderGone()
    }

    override fun list(path: List<String>, stamps: Boolean): List<ListedEntry> {
        val directory = directoryAt(path)
        return tree.children(directory.id, base + path).filterNot { isPartialName(it.name) }
            .map { ListedEntry(composed(it.name), it.directory, if (stamps && !it.directory) it.stamp else null) }
    }

    override fun stat(path: List<String>): Found? = find(path)?.let { Found(it.directory, if (it.directory) null else it.stamp) }

    override fun canonicalPath(path: List<String>): List<String>? {
        // The name in a listing, as a document found by an id made from the name says that name back.
        var at = tree.find(base) ?: throw folderGone()
        return path.map { part ->
            if (!at.directory) return null
            val all = tree.children(at.id)
            at = all.firstOrNull { it.name == part } ?: all.firstOrNull { composed(it.name) == composed(part) }
                ?: all.firstOrNull { composed(it.name).equals(composed(part), ignoreCase = true) }?.takeIf { find(path) != null } ?: return null
            composed(at.name)
        }
    }

    override fun read(path: List<String>): ReadFile = tree.asking {
        repeat(READ_TRIES) {
            val before = fileAt(path)
            val opened = tree.resolver.openFileDescriptor(tree.uriOf(before.id), "r") ?: throw nothingAt(path)
            val stream = ParcelFileDescriptor.AutoCloseInputStream(opened)
            if (before.stamp.size > SMALL_READ) {
                if (opened.statSize == before.stamp.size) return@asking ReadFile(before.stamp, OpenContent(stream, before.stamp.size))
                stream.close()
            } else {
                val bytes = stream.use { it.readBytes() }
                val after = tree.document(before.id)?.stamp
                if (after == before.stamp && bytes.size.toLong() == before.stamp.size) return@asking ReadFile(before.stamp, BytesContent(bytes))
            }
        }
        throw BridgeFailure(Failure.BUSY, "The file keeps changing while it is read.")
    }

    /**
     * One question to the provider for each file, in place of three, several at once. A file written
     * between the question and the read has a size other than its stamp's, and is read alone.
     */
    override fun readMany(paths: List<List<String>>): List<ReadFile?> = tree.asking {
        val listings = java.util.concurrent.ConcurrentHashMap<List<String>, java.util.Optional<Map<String, SafDocument>>>()
        val reads = paths.map { path -> READERS.submit<ReadFile?> { readListed(path, listings) } }
        val read = reads.map {
            try {
                it.get()
            } catch (error: java.util.concurrent.ExecutionException) {
                throw error.cause ?: error
            }
        }
        read.also { if (it.all { one -> one == null }) check() }
    }

    /** Each open is a question to the provider's process, which answers several at once. */
    private fun readListed(path: List<String>, listings: MutableMap<List<String>, java.util.Optional<Map<String, SafDocument>>>): ReadFile? = tree.asking {
        if (path.isEmpty()) return@asking null
        // Where an id is a path, one question finds a file. Elsewhere one listing finds a directory's.
        val document = if (tree.idsArePaths) {
            find(path)
        } else {
            val listing = listings.computeIfAbsent(path.dropLast(1)) {
                java.util.Optional.ofNullable(find(path.dropLast(1))?.takeIf { it.directory }?.let { directory -> tree.children(directory.id, base + path.dropLast(1)).associateBy { composed(it.name) } })
            }.orElse(null)
            listing?.get(composed(path.last()))
        } ?: return@asking null
        if (document.directory) return@asking null
        if (document.stamp.size > SMALL_READ) return@asking super.readMany(listOf(path)).single()
        val bytes = try {
            tree.resolver.openInputStream(tree.uriOf(document.id))?.use { it.readBytes() }
        } catch (_: java.io.FileNotFoundException) {
            null
        }
        when {
            bytes == null -> super.readMany(listOf(path)).single()
            bytes.size.toLong() == document.stamp.size -> ReadFile(document.stamp, BytesContent(bytes))
            else -> read(path)
        }
    }

    override fun write(path: List<String>, content: Content, createDirectories: Boolean, ifStamp: IfStamp?): FileStamp = tree.asking {
        if (createDirectories) makeDirectories(path.dropLast(1)) else directoryAt(path.dropLast(1))
        synchronized(FileLocks.of(tree.uri to base + path)) {
            val there = find(path)
            if (there?.directory == true) throw notAFile(path)
            checkIfStamp(there?.stamp, ifStamp)
            replace(there, path, content)
        }
    }

    /**
     * A provider has no rename over a file that is there. Where it can rename, the new content goes
     * into a document of its own first. Once that is whole, the old file moves aside, the new one takes
     * its name and the old one is deleted, so a write that fails part way leaves the file as it was.
     * Where the provider cannot rename, the file itself is written, which a failure part way through
     * leaves short.
     */
    private fun replace(there: SafDocument?, path: List<String>, content: Content): FileStamp {
        val partial = path.dropLast(1) + partialName()
        val staged = create(partial, OTHER_TYPE)
        val renames = staged.flags and Document.FLAG_SUPPORTS_RENAME != 0 && (there == null || there.flags and Document.FLAG_SUPPORTS_RENAME != 0)
        if (!renames) {
            deleteQuietly(staged.id)
            tree.forget(base + partial)
            return put(there?.id ?: create(path, OTHER_TYPE).id, path, content)
        }
        try {
            put(staged.id, partial, content)
        } catch (error: Exception) {
            deleteQuietly(staged.id)
            throw error
        } finally {
            tree.forget(base + partial)
        }
        tree.forget(base + path)
        val aside = there?.let { rename(it.id, partialName()) }
        val id = try {
            rename(staged.id, path.last()).also { id ->
                if (tree.document(id)?.name?.let(::composed) != composed(path.last())) throw refusedName(path)
            }
        } catch (error: Exception) {
            aside?.let { rename(it, path.last()) }
            deleteQuietly(staged.id)
            throw error
        }
        // What is left if this fails is hidden from the page by its name, and holds the old content.
        aside?.let(::deleteQuietly)
        tree.remember(base + path, id)
        return tree.document(id)?.stamp ?: throw nothingAt(path)
    }

    private fun partialName() = PARTIAL_PREFIX + UUID.randomUUID() + PARTIAL_SUFFIX

    private fun deleteQuietly(id: String) {
        try {
            DocumentsContract.deleteDocument(tree.resolver, tree.uriOf(id))
        } catch (_: Exception) {
            // A partial file left behind is hidden from the page by its name.
        }
    }

    /** Writes a document and reads it back, as a provider may keep less than it was given and say nothing. */
    private fun put(id: String, path: List<String>, content: Content): FileStamp {
        repeat(WRITE_TRIES) {
            val uri = tree.uriOf(id)
            val opened = tree.resolver.openFileDescriptor(uri, "wt") ?: throw nothingAt(path)
            opened.use { descriptor ->
                FileOutputStream(descriptor.fileDescriptor).let { out ->
                    content.open().use { it.copyTo(out) }
                    out.flush()
                    // Not every provider's file is one that can be synced.
                    try { descriptor.fileDescriptor.sync() } catch (_: java.io.SyncFailedException) {}
                }
            }
            if (holds(uri, content)) tree.document(id)?.let { written -> if (written.stamp.size == content.size) return written.stamp }
        }
        throw BridgeFailure(Failure.OPERATION, "The file did not keep what was written to it.")
    }

    private fun holds(uri: Uri, content: Content): Boolean {
        val stored = tree.resolver.openInputStream(uri) ?: return false
        return stored.use { one -> content.open().use { other -> same(one, other) } }
    }

    private fun same(one: InputStream, other: InputStream): Boolean {
        val left = one.buffered(64 * 1024)
        val right = other.buffered(64 * 1024)
        while (true) {
            val byte = left.read()
            if (byte != right.read()) return false
            if (byte < 0) return true
        }
    }

    /** A new document with exactly the name asked for. A provider makes up another when it is taken or not one it takes. */
    private fun create(path: List<String>, type: String): SafDocument {
        val parent = directoryAt(path.dropLast(1))
        val made = DocumentsContract.createDocument(tree.resolver, tree.uriOf(parent.id), type, path.last()) ?: throw refusedName(path)
        val document = tree.document(DocumentsContract.getDocumentId(made)) ?: throw nothingAt(path)
        if (composed(document.name) != composed(path.last())) {
            DocumentsContract.deleteDocument(tree.resolver, made)
            throw refusedName(path)
        }
        tree.remember(base + path, document.id)
        return document
    }

    private fun refusedName(path: List<String>) = BridgeFailure(Failure.TYPE_MISMATCH, "The folder does not take the name ${path.joinToString("/")}.")

    override fun createDirectory(path: List<String>) { tree.asking { makeDirectories(path) } }

    private fun makeDirectories(path: List<String>) {
        path.indices.forEach { index ->
            val part = path.take(index + 1)
            synchronized(tree.making) {
                val there = find(part) ?: create(part, Document.MIME_TYPE_DIR)
                if (!there.directory) throw notADirectory(part)
            }
        }
    }

    override fun remove(path: List<String>): Unit = tree.asking {
        val document = find(path) ?: return@asking
        try {
            DocumentsContract.deleteDocument(tree.resolver, tree.uriOf(document.id))
        } catch (_: java.io.FileNotFoundException) {
            // Gone since it was found, which is what was asked.
        }
        tree.forget(base + path)
    }

    override fun move(from: List<String>, to: List<String>): Unit = tree.asking {
        val source = find(from) ?: throw nothingAt(from)
        val parent = directoryAt(to.dropLast(1))
        val canonicalFrom = canonicalPath(from) ?: throw nothingAt(from)
        val canonicalParent = canonicalPath(to.dropLast(1)) ?: throw nothingAt(to)
        if (source.directory && canonicalParent.take(canonicalFrom.size) == canonicalFrom) {
            throw BridgeFailure(Failure.INVALID_MODIFICATION, "${to.joinToString("/")} is inside ${from.joinToString("/")}.")
        }
        synchronized(tree.making) {
            val taken = canonicalPath(to)
            if (taken != null && taken != canonicalFrom) throw BridgeFailure(Failure.INVALID_MODIFICATION, "Something is already at ${to.joinToString("/")}.")
            if (canonicalFrom == canonicalParent + to.last()) return@asking
            try {
                relocate(source, from, parent, canonicalParent == canonicalFrom.dropLast(1), to)
            } finally {
                tree.forget(base + from)
                tree.forget(base + to)
            }
        }
    }

    /**
     * A provider renames inside a directory and moves between directories under the name there was, so
     * a move to another name is both. It goes through a name nothing has, as a provider that finds one
     * taken (its own, in other case, included) adds a number to it.
     */
    private fun relocate(source: SafDocument, from: List<String>, parent: SafDocument, inPlace: Boolean, to: List<String>) {
        val needsMove = !inPlace
        if (source.flags and Document.FLAG_SUPPORTS_RENAME == 0 || (needsMove && source.flags and Document.FLAG_SUPPORTS_MOVE == 0)) {
            copyTree(source, to)
            DocumentsContract.deleteDocument(tree.resolver, tree.uriOf(source.id))
            return
        }
        val between = PARTIAL_PREFIX + UUID.randomUUID() + PARTIAL_SUFFIX
        val home = directoryAt(from.dropLast(1)).id
        var id = rename(source.id, between)
        var away = false
        try {
            if (needsMove) {
                id = moveBetween(id, home, parent.id)
                away = true
            }
            id = rename(id, to.last())
            if (tree.document(id)?.name?.let(::composed) != composed(to.last())) throw refusedName(to)
        } catch (error: Exception) {
            putBack(id, between, if (away) parent.id else null, home, from)
            throw error
        }
    }

    private fun moveBetween(id: String, from: String, to: String): String {
        val moved = DocumentsContract.moveDocument(tree.resolver, tree.uriOf(id), tree.uriOf(from), tree.uriOf(to))
            ?: throw BridgeFailure(Failure.NOT_SUPPORTED, "The folder cannot move a document.")
        return DocumentsContract.getDocumentId(moved)
    }

    /** Returns a document whose move failed part way to where it was. */
    private fun putBack(id: String, between: String, away: String?, home: String, from: List<String>) {
        try {
            val back = if (away == null) id else moveBetween(rename(id, between), away, home)
            rename(back, from.last())
        } catch (error: Exception) {
            throw BridgeFailure(Failure.OPERATION, "${from.joinToString("/")} could not be moved, and is under a name of its own in the folder.", error)
        }
    }

    private fun rename(id: String, name: String): String {
        // Null from a provider that keeps the id.
        val renamed = DocumentsContract.renameDocument(tree.resolver, tree.uriOf(id), name) ?: return id
        return DocumentsContract.getDocumentId(renamed)
    }

    /** For a provider that cannot move: everything is copied first, and the source goes last. */
    private fun copyTree(source: SafDocument, to: List<String>) {
        if (source.directory) {
            create(to, Document.MIME_TYPE_DIR)
            tree.children(source.id).forEach { copyTree(it, to + composed(it.name)) }
            return
        }
        val bytes = tree.resolver.openInputStream(tree.uriOf(source.id))?.use { it.readBytes() } ?: throw nothingAt(to)
        put(create(to, OTHER_TYPE).id, to, BytesContent(bytes))
    }

    override fun walk(path: List<String>, skip: Set<String>, limit: Int): Walked {
        val files = ArrayList<String>()
        fun below(directory: SafDocument, at: List<String>): Boolean {
            for (entry in tree.children(directory.id, base + at)) {
                val name = composed(entry.name)
                if (isPartialName(name)) continue
                if (entry.directory) {
                    if (name !in skip && below(entry, at + name)) return true
                } else {
                    if (files.size >= limit) return true
                    files.add((at + name).joinToString("/"))
                }
            }
            return false
        }
        val truncated = below(directoryAt(path), path)
        return Walked(files, truncated)
    }

    override fun watch(changed: (List<String>?) -> Unit, lost: () -> Unit): Closeable =
        throw BridgeFailure(Failure.NOT_SUPPORTED, "The system does not report changes in this folder.")

    private fun find(path: List<String>): SafDocument? = tree.find(base + path)

    private fun directoryAt(path: List<String>): SafDocument {
        val found = find(path) ?: throw if (path.indices.any { find(path.take(it + 1))?.directory == false }) notADirectory(path) else nothingAt(path)
        if (!found.directory) throw notADirectory(path)
        return found
    }

    private fun fileAt(path: List<String>): SafDocument {
        val found = find(path) ?: throw nothingAt(path)
        if (found.directory) throw notAFile(path)
        return found
    }

    private companion object {
        /** A type no provider adds an extension for. */
        const val OTHER_TYPE = "application/octet-stream"
        const val SMALL_READ = 1024 * 1024L
        const val READ_TRIES = 4
        const val WRITE_TRIES = 2
        val READERS: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newFixedThreadPool(4) { Thread(it, "folder-read").apply { isDaemon = true } }
    }
}
