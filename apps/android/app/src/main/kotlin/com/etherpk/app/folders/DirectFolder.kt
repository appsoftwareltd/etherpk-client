package com.etherpk.app.folders

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.OpenContent
import java.io.Closeable
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.file.AccessDeniedException
import java.nio.file.DirectoryNotEmptyException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID

/** Watches a directory and everything below it. Android's is inotify ([InotifyWatch]). */
typealias TreeWatch = (root: Path, changed: (List<String>?) -> Unit, lost: () -> Unit) -> Closeable

/**
 * A chosen folder reached by its path, which All files access allows. Writes replace a file in one
 * step, and changes other programs make are reported.
 */
class DirectFolder(private val folder: Path, private val treeWatch: TreeWatch? = null) : FolderFiles {
    /** The folder with every link in its own path followed, found for each call as the folder can go. */
    private fun root(): Path {
        val real = try {
            folder.toRealPath()
        } catch (error: IOException) {
            throw folderGone(error)
        }
        if (!Files.isDirectory(real)) throw folderGone()
        return real
    }

    override fun check() { root() }

    override fun list(path: List<String>, stamps: Boolean): List<ListedEntry> = answering(path) {
        val root = root()
        entries(directoryAt(root, path)).mapNotNull { entry ->
            if (isPartialName(entry.fileName.toString())) return@mapNotNull null
            val attributes = inside(root, entry) ?: return@mapNotNull null
            ListedEntry(nameOf(entry), attributes.isDirectory, if (stamps && !attributes.isDirectory) stampOf(attributes) else null)
        }
    }

    override fun stat(path: List<String>): Found? = answering(path) {
        val attributes = attributesOf(find(root(), path) ?: return@answering null) ?: return@answering null
        Found(attributes.isDirectory, if (attributes.isDirectory) null else stampOf(attributes))
    }

    override fun canonicalPath(path: List<String>): List<String>? = answering(path) {
        var at = root()
        path.map { part ->
            if (!Files.isDirectory(at)) return@answering null
            at = spelled(at, part) ?: return@answering null
            nameOf(at)
        }
    }

    override fun read(path: List<String>): ReadFile = answering(path) {
        val file = fileAt(root(), path)
        // The stamp and the bytes must be of one state of the file. A rename leaves this channel on the
        // old one, and a write in place shows as a stamp that moved.
        repeat(READ_TRIES) {
            val before = stampOf(attributesOf(file) ?: throw nothingAt(path))
            val channel = FileChannel.open(file, StandardOpenOption.READ)
            if (before.size > SMALL_READ) {
                if (channel.size() == before.size) return@answering ReadFile(before, OpenContent(Channels.newInputStream(channel), before.size))
                channel.close()
            } else {
                val bytes = channel.use { Channels.newInputStream(it).readBytes() }
                val after = attributesOf(file)?.let(::stampOf)
                if (after == before && bytes.size.toLong() == before.size) return@answering ReadFile(before, BytesContent(bytes))
            }
        }
        throw BridgeFailure(Failure.BUSY, "The file keeps changing while it is read.")
    }

    override fun write(path: List<String>, content: Content, createDirectories: Boolean, ifStamp: IfStamp?): FileStamp = answering(path) {
        val root = root()
        val parent = if (createDirectories) makeDirectories(root, path.dropLast(1)) else directoryAt(root, path.dropLast(1))
        val target = child(parent, path.last()) ?: parent.resolve(path.last())
        synchronized(FileLocks.of(target)) {
            // Through a link to the file it names, so the link stays. One that leads out is refused.
            val real = if (Files.isSymbolicLink(target)) confined(root, target) ?: throw outside() else target
            val attributes = attributesOf(real)
            if (attributes?.isDirectory == true) throw notAFile(path)
            checkIfStamp(attributes?.let(::stampOf), ifStamp)
            replace(real, content)
        }
    }

    /**
     * Writes beside the file and takes its place. The size is read back, since shared storage has been
     * reported to show a new file as empty, and writing it again puts that right.
     */
    private fun replace(file: Path, content: Content): FileStamp {
        repeat(WRITE_TRIES) {
            val partial = file.resolveSibling(PARTIAL_PREFIX + UUID.randomUUID() + PARTIAL_SUFFIX)
            try {
                FileChannel.open(partial, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE).use { channel ->
                    content.open().use { copy(it, channel) }
                    channel.force(true)
                }
                Files.move(partial, file, ATOMIC_MOVE)
            } catch (error: Throwable) {
                Files.deleteIfExists(partial)
                throw error
            }
            val written = attributesOf(file)?.let(::stampOf)
            if (written?.size == content.size) return written
        }
        throw BridgeFailure(Failure.OPERATION, "The file did not keep what was written to it.")
    }

    private fun copy(from: java.io.InputStream, to: FileChannel) {
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = from.read(buffer)
            if (count < 0) return
            val bytes = ByteBuffer.wrap(buffer, 0, count)
            while (bytes.hasRemaining()) to.write(bytes)
        }
    }

    override fun createDirectory(path: List<String>) { answering(path) { makeDirectories(root(), path) } }

    override fun remove(path: List<String>): Unit = answering(path) {
        val root = root()
        val parent = find(root, path.dropLast(1)) ?: return@answering
        val target = child(parent, path.last()) ?: return@answering
        // The entry itself goes. What a link leads to is not touched.
        removeTree(target)
    }

    private fun removeTree(entry: Path) {
        if (Files.isDirectory(entry, NOFOLLOW_LINKS)) entries(entry).forEach(::removeTree)
        try {
            Files.deleteIfExists(entry)
        } catch (error: DirectoryNotEmptyException) {
            throw BridgeFailure(Failure.BUSY, "Something was added to the folder while it was removed.", error)
        }
    }

    override fun move(from: List<String>, to: List<String>): Unit = answering(from) {
        val root = root()
        val source = child(directoryAt(root, from.dropLast(1)), from.last()) ?: throw nothingAt(from)
        val parent = directoryAt(root, to.dropLast(1))
        if (Files.isDirectory(source, NOFOLLOW_LINKS) && parent.startsWith(source.toRealPath())) {
            throw BridgeFailure(Failure.INVALID_MODIFICATION, "${to.joinToString("/")} is inside ${from.joinToString("/")}.")
        }
        val target = parent.resolve(to.last())
        synchronized(FileLocks.of(target)) {
            val taken = child(parent, to.last())
            if (taken != null && !Files.isSameFile(taken, source)) {
                throw BridgeFailure(Failure.INVALID_MODIFICATION, "Something is already at ${to.joinToString("/")}.")
            }
            if (taken == null) {
                Files.move(source, target, ATOMIC_MOVE)
            } else if (source != target) {
                // The volume ignores case, and to it the two names are one file, so a rename does
                // nothing. Through a third name it changes.
                val between = source.resolveSibling(PARTIAL_PREFIX + UUID.randomUUID() + PARTIAL_SUFFIX)
                Files.move(source, between, ATOMIC_MOVE)
                try {
                    Files.move(between, target, ATOMIC_MOVE)
                } catch (error: IOException) {
                    Files.move(between, source, ATOMIC_MOVE)
                    throw error
                }
            }
        }
    }

    override fun walk(path: List<String>, skip: Set<String>, limit: Int): Walked = answering(path) {
        val root = root()
        val files = ArrayList<String>()
        val visited = HashSet<Path>()
        fun below(directory: Path, prefix: String): Boolean {
            // A link to a directory above would otherwise be walked for ever.
            if (!visited.add(directory.toRealPath())) return false
            for (entry in entries(directory)) {
                val name = nameOf(entry)
                if (isPartialName(name)) continue
                val attributes = inside(root, entry) ?: continue
                if (attributes.isDirectory) {
                    if (name !in skip && below(entry, "$prefix$name/")) return true
                } else {
                    if (files.size >= limit) return true
                    files.add(prefix + name)
                }
            }
            return false
        }
        val truncated = below(directoryAt(root, path), path.joinToString("") { "$it/" })
        Walked(files, truncated)
    }

    override fun watch(changed: (List<String>?) -> Unit, lost: () -> Unit): Closeable {
        val watch = treeWatch ?: throw BridgeFailure(Failure.NOT_SUPPORTED, "This folder cannot be watched.")
        return watch(root(), changed, lost)
    }

    // Finding things. A path is followed one part at a time, so a name stored decomposed is met by its
    // composed form, and each thing found is checked to be inside the folder.

    /** The entry of [directory] that [name] reaches, not followed if it is a link. */
    private fun child(directory: Path, name: String): Path? {
        val exact = directory.resolve(name)
        if (Files.exists(exact, NOFOLLOW_LINKS)) return exact
        // ASCII has one form, so there is no other spelling to look for.
        if (name.all { it.code < 128 }) return null
        return entries(directory).firstOrNull { nameOf(it) == composed(name) }
    }

    /** As [child], by the name the disk has, which on a volume that ignores case may be another. */
    private fun spelled(directory: Path, name: String): Path? {
        val all = entries(directory)
        all.firstOrNull { it.fileName.toString() == name }?.let { return it }
        all.firstOrNull { nameOf(it) == composed(name) }?.let { return it }
        if (!Files.exists(directory.resolve(name), NOFOLLOW_LINKS)) return null
        return all.firstOrNull { nameOf(it).equals(composed(name), ignoreCase = true) }
    }

    /** What [path] reaches, with links followed, or null. Never anything outside [root]. */
    private fun find(root: Path, path: List<String>): Path? {
        var at = root
        for (part in path) {
            if (!Files.isDirectory(at)) return null
            val next = child(at, part) ?: return null
            at = if (Files.isSymbolicLink(next)) confined(root, next) ?: throw outside() else next
        }
        return at
    }

    /** Where a link leads, if that is inside [root]. */
    private fun confined(root: Path, link: Path): Path? = try {
        link.toRealPath().takeIf { it.startsWith(root) }
    } catch (_: IOException) {
        null
    }

    private fun outside() = BridgeFailure(Failure.SECURITY, "The path leads out of the folder.")

    private fun directoryAt(root: Path, path: List<String>): Path {
        val found = find(root, path) ?: throw if (throughAFile(root, path)) notADirectory(path) else nothingAt(path)
        if (!Files.isDirectory(found)) throw notADirectory(path)
        return found
    }

    private fun throughAFile(root: Path, path: List<String>) =
        path.indices.any { count -> find(root, path.take(count + 1))?.let { !Files.isDirectory(it) } ?: false }

    private fun fileAt(root: Path, path: List<String>): Path {
        val found = find(root, path) ?: throw nothingAt(path)
        if (Files.isDirectory(found)) throw notAFile(path)
        return found
    }

    private fun makeDirectories(root: Path, path: List<String>): Path {
        var at = root
        path.forEachIndexed { index, part ->
            val there = find(at, listOf(part), root)
            at = if (there == null) createOne(at.resolve(part)) else there
            if (!Files.isDirectory(at)) throw notADirectory(path.take(index + 1))
        }
        return at
    }

    private fun find(from: Path, path: List<String>, root: Path): Path? {
        val next = child(from, path.single()) ?: return null
        return if (Files.isSymbolicLink(next)) confined(root, next) ?: throw outside() else next
    }

    private fun createOne(directory: Path): Path {
        try {
            Files.createDirectory(directory)
        } catch (_: FileAlreadyExistsException) {
            // Made by another call between the look and the act. Whether it is a directory is checked after.
        }
        return directory
    }

    private fun entries(directory: Path): List<Path> = Files.newDirectoryStream(directory).use { it.toList() }

    private fun nameOf(entry: Path) = composed(entry.fileName.toString())

    /** Null when nothing is there. */
    private fun attributesOf(path: Path): BasicFileAttributes? = try {
        Files.readAttributes(path, BasicFileAttributes::class.java)
    } catch (_: NoSuchFileException) {
        null
    } catch (_: NotDirectoryException) {
        null
    }

    /** An entry's attributes with links followed, or null for one that leads out, nowhere, or is neither a file nor a directory. */
    private fun inside(root: Path, entry: Path): BasicFileAttributes? {
        val attributes = try {
            Files.readAttributes(entry, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            // Gone since it was listed.
            return null
        }
        if (attributes.isOther) return null
        if (!attributes.isSymbolicLink) return attributes
        return confined(root, entry)?.let(::attributesOf)
    }

    private fun stampOf(attributes: BasicFileAttributes) = FileStamp(attributes.lastModifiedTime().toMillis(), attributes.size())

    /** Runs a call, and names what the file system said. */
    private fun <T> answering(path: List<String>, body: () -> T): T = try {
        body()
    } catch (error: FileSystemException) {
        throw named(path, error)
    } catch (error: java.io.IOException) {
        // A channel's write and force throw a plain IOException with the system's words, a full
        // disk among them.
        throw ioNamed(path, error)
    }

    private fun ioNamed(path: List<String>, error: java.io.IOException): BridgeFailure {
        val said = error.message.orEmpty()
        return when {
            "No space" in said || "ENOSPC" in said || "quota" in said || "EDQUOT" in said -> BridgeFailure(Failure.QUOTA, "There is no space left.", error)
            "EIO" in said || "I/O error" in said -> BridgeFailure(Failure.NOT_READABLE, "The storage could not read or write ${path.joinToString("/")}.", error)
            else -> BridgeFailure(Failure.OPERATION, "${path.joinToString("/")}: ${error.javaClass.simpleName} $said", error)
        }
    }

    private fun named(path: List<String>, error: FileSystemException): BridgeFailure {
        val where = path.joinToString("/")
        val reason = error.reason.orEmpty()
        return when {
            error is NoSuchFileException -> BridgeFailure(Failure.NOT_FOUND, "Nothing is at $where.", error)
            error is NotDirectoryException || "Not a directory" in reason -> BridgeFailure(Failure.TYPE_MISMATCH, "$where is a file.", error)
            error is AccessDeniedException || "not permitted" in reason -> BridgeFailure(Failure.NOT_ALLOWED, "The system refused $where.", error)
            error is FileAlreadyExistsException -> BridgeFailure(Failure.INVALID_MODIFICATION, "Something is already at $where.", error)
            "No space" in reason || "quota" in reason -> BridgeFailure(Failure.QUOTA, "There is no space left.", error)
            "Read-only" in reason -> BridgeFailure(Failure.NO_MODIFICATION, "$where is on a read-only volume.", error)
            "too long" in reason || "Invalid argument" in reason -> BridgeFailure(Failure.TYPE_MISMATCH, "The system does not take the name $where.", error)
            "busy" in reason -> BridgeFailure(Failure.BUSY, "$where is in use.", error)
            else -> BridgeFailure(Failure.OPERATION, "$where: ${error.javaClass.simpleName} $reason", error)
        }
    }

    private companion object {
        /** Read into memory. A larger file is handed on as an open stream. */
        const val SMALL_READ = 1024 * 1024L
        const val READ_TRIES = 4
        const val WRITE_TRIES = 2
    }
}

/**
 * A lock for each path being written, so that of two writes that ask for one stamp, one finds it gone.
 * Paths share locks. That costs a wait and nothing else.
 */
object FileLocks {
    private val locks = Array(64) { Any() }
    fun of(path: Any): Any = locks[path.toString().lowercase().hashCode().and(0x7fffffff) % locks.size]
}
