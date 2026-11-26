package com.etherpk.app.folders

import android.os.FileObserver
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Changes gathered until they settle, then told as one. */
class Gathered(private val timer: ScheduledExecutorService, private val tell: (List<String>?) -> Unit) {
    private val paths = LinkedHashSet<String>()
    private var everything = false
    private var waiting: ScheduledFuture<*>? = null
    private var since = 0L

    @Synchronized fun add(path: String) {
        if (paths.size >= MOST_PATHS) everything = true else paths.add(path)
        val now = System.nanoTime() / 1_000_000
        if (waiting == null) since = now
        waiting?.cancel(false)
        waiting = timer.schedule(::flush, minOf(SETTLE_MS, since + LONGEST_WAIT_MS - now).coerceAtLeast(0), TimeUnit.MILLISECONDS)
    }

    private fun flush() {
        val told = synchronized(this) {
            if (waiting == null) return
            waiting = null
            val all = if (everything) null else paths.toList()
            paths.clear()
            everything = false
            all
        }
        tell(told)
    }

    @Synchronized fun cancel() {
        waiting?.cancel(false)
        waiting = null
    }

    private companion object {
        const val SETTLE_MS = 100L
        const val LONGEST_WAIT_MS = 1_000L
        const val MOST_PATHS = 1_000
    }
}

/**
 * One platform observer for each directory, shared by whoever watches it. Android gives every observer
 * in a process one inotify, where a directory watched twice is one watch: ending either ends both.
 *
 * Observers are shared by the directory itself, its device and inode, and not by its path. inotify
 * watches an inode, so a directory renamed by another program is the same watch under its new name,
 * and two watches that each follow the rename must find one observer there, not make a second that
 * ends the first.
 */
private object Observers {
    private class Shared(val observer: FileObserver, val listeners: MutableSet<(Int, String?) -> Unit>)

    private val shared = HashMap<Any, Shared>()
    private val keys = HashMap<(Int, String?) -> Unit, Any>()

    /** False when the directory is gone, which its parent's watch reports. */
    @Synchronized fun add(directory: File, listener: (Int, String?) -> Unit): Boolean {
        val key = keyOf(directory) ?: return false
        keys[listener] = key
        val there = shared[key]
        if (there != null) {
            there.listeners.add(listener)
            return true
        }
        val observer = object : FileObserver(directory, MASK) {
            override fun onEvent(event: Int, path: String?) = told(key, event, path)
        }
        shared[key] = Shared(observer, linkedSetOf(listener))
        observer.startWatching()
        return true
    }

    private fun keyOf(directory: File): Any? = try {
        Files.readAttributes(directory.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS).fileKey() ?: directory.path
    } catch (_: IOException) {
        null
    }

    private fun told(key: Any, event: Int, path: String?) {
        val listeners = synchronized(this) { shared[key]?.listeners?.toList() }
        listeners?.forEach { it(event, path) }
    }

    @Synchronized fun remove(listener: (Int, String?) -> Unit) {
        val key = keys.remove(listener) ?: return
        val there = shared[key] ?: return
        there.listeners.remove(listener)
        if (there.listeners.isNotEmpty()) return
        there.observer.stopWatching()
        shared.remove(key)
    }

    private const val MASK = FileObserver.CREATE or FileObserver.CLOSE_WRITE or FileObserver.MODIFY or FileObserver.DELETE or
        FileObserver.MOVED_FROM or FileObserver.MOVED_TO or FileObserver.DELETE_SELF or FileObserver.MOVE_SELF
}

/**
 * Watches a directory tree with inotify, one watch to a directory, added as directories appear. All
 * the work after an event is on [timer]'s one thread.
 */
class InotifyWatch(private val root: Path, private val timer: ScheduledExecutorService, changed: (List<String>?) -> Unit, private val lost: () -> Unit) : Closeable {
    private val watched = HashMap<String, (Int, String?) -> Unit>()
    private val gathered = Gathered(timer, changed)
    @Volatile private var closed = false

    init {
        addTree("", report = false)
        if (closed) throw BridgeFailure(Failure.NOT_SUPPORTED, "The folder could not be watched.")
        if (synchronized(watched) { watched.isEmpty() }) throw folderGone()
    }

    private fun addTree(directory: String, report: Boolean) {
        val file = fileOf(directory)
        if (file.name in NOT_WATCHED) return
        synchronized(watched) {
            // Asked under the lock that close() takes, so an observer is never added after it.
            if (closed || watched.containsKey(directory)) return
            if (watched.size >= MOST_DIRECTORIES) return lose()
            val listener = listener(directory)
            if (!Observers.add(file, listener)) return
            watched[directory] = listener
        }
        // The watch is first and the listing second, so nothing made between the two is missed.
        for (child in file.listFiles().orEmpty()) {
            val path = below(directory, child.name)
            if (report && !isPartialName(child.name)) gathered.add(composed(path))
            if (isDirectoryHere(child)) addTree(path, report)
        }
    }

    /** A directory, and not a link to one: a link can lead out of the folder, or back up it for ever. */
    private fun isDirectoryHere(file: File) = Files.isDirectory(file.toPath(), LinkOption.NOFOLLOW_LINKS)

    private fun below(directory: String, name: String) = if (directory.isEmpty()) name else "$directory/$name"

    private fun fileOf(directory: String) = if (directory.isEmpty()) root.toFile() else File(root.toFile(), directory)

    private fun listener(directory: String): (Int, String?) -> Unit = { event, path ->
        if (!closed) timer.execute { heard(event and FileObserver.ALL_EVENTS, directory, path) }
    }

    private fun heard(event: Int, directory: String, name: String?) {
        if (closed) return
        if (event and (FileObserver.DELETE_SELF or FileObserver.MOVE_SELF) != 0) {
            if (directory.isEmpty()) lose() else drop(directory)
            return
        }
        if (name == null || isPartialName(name)) return
        val path = below(directory, name)
        gathered.add(composed(path))
        if (event and (FileObserver.CREATE or FileObserver.MOVED_TO) != 0 && isDirectoryHere(File(root.toFile(), path))) addTree(path, report = true)
        if (event and FileObserver.MOVED_FROM != 0) drop(path)
    }

    private fun drop(directory: String) = synchronized(watched) {
        watched.keys.filter { it == directory || it.startsWith("$directory/") }.forEach(::stop)
    }

    private fun stop(directory: String) { watched.remove(directory)?.let(Observers::remove) }

    private fun lose() {
        if (closed) return
        close()
        lost()
    }

    override fun close() {
        closed = true
        gathered.cancel()
        synchronized(watched) {
            watched.keys.toList().forEach(::stop)
        }
    }

    private companion object {
        /** Past this many, watching costs more than the polling it replaces. */
        const val MOST_DIRECTORIES = 5_000
        /** Directories of a program's own files, thousands of them, and no documents. */
        val NOT_WATCHED = setOf(".git", "node_modules")
    }
}
