package com.etherpk.app.folders

import com.etherpk.app.bridge.Arguments
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.Handler
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/** A tree the person chose in the system's dialog. */
class PickedTree(val tree: String, val name: String)

/** The part of the folders that only the system can answer. */
interface FolderSystem {
    /** Opens the dialog. Fails with AbortError when the person cancels. */
    fun pick(): CompletableFuture<PickedTree>
    fun files(grant: FolderGrant): FolderFiles
    /** Where the folder is, for the person to read. Null where there is no path to show. */
    fun displayPath(grant: FolderGrant): String?
    /** The path from one granted tree down to another, empty when they are one, null when it is not inside. */
    fun treePath(above: String, below: String): List<String>?
    /** The app will not use the tree again. */
    fun release(tree: String)
}

/** `folders.*` and `fs.*`. */
class FolderMethods(
    private val registry: FolderRegistry,
    private val system: FolderSystem,
    private val emit: (event: String, detail: Map<String, Any?>) -> Unit,
    private val log: (String, Throwable) -> Unit = { _, _ -> },
) {
    private val watches = ConcurrentHashMap<String, Closeable>()
    /** Counts the pages. A watch asked for by one page that is gone is closed when it is ready. */
    private var page = 0L
    private val pageLock = Any()

    val handlers: Map<String, Handler> = mapOf(
        "folders.pick" to { _ -> system.pick().thenApply { info(registry.grant(it.tree, emptyList(), it.name)) } },
        "folders.get" to { args -> get(args.text("folder")) },
        "folders.forget" to { args -> registry.forget(args.text("folder"))?.let(system::release).let { } },
        "folders.relation" to ::relation,
        "folders.child" to ::child,
        "fs.list" to { args -> files(args).list(path(args), args.flag("stamps")).map(::listed) },
        "fs.stat" to { args -> files(args).stat(path(args))?.let { found -> mapOf("kind" to kind(found.directory)) + stamped(found.stamp) } },
        "fs.canonicalPath" to { args -> files(args).canonicalPath(path(args))?.joinToString("/") },
        "fs.read" to { args -> read(files(args).read(path(args))) },
        "fs.readMany" to ::readMany,
        "fs.write" to ::write,
        "fs.createDirectory" to { args -> files(args).createDirectory(path(args)) },
        "fs.remove" to { args -> files(args).remove(below(args)) },
        "fs.move" to { args -> files(args).move(below(args, "from"), below(args, "to")) },
        "fs.walk" to ::walk,
        "fs.watch" to ::watch,
        "fs.unwatch" to { args -> watches.remove(args.text("watch"))?.close().let { } },
    )

    /** Ends every watch. The page that asked for them is gone. */
    fun endWatches() {
        val ended = synchronized(pageLock) {
            page++
            watches.keys.toList().mapNotNull { watches.remove(it) }
        }
        ended.forEach(Closeable::close)
    }

    private fun grantOf(id: String) = registry.get(id) ?: throw BridgeFailure(Failure.NOT_ALLOWED, "The app has no permission for this folder.")

    private fun files(args: Arguments): FolderFiles = system.files(grantOf(args.text("folder"))).also { it.check() }
    private fun path(args: Arguments, name: String = "path") = relativePath(args.text(name))
    private fun below(args: Arguments, name: String = "path") = pathBelowFolder(args.text(name))

    private fun info(grant: FolderGrant): Map<String, Any?> =
        mapOf("id" to grant.id, "name" to composed(grant.name), "displayPath" to system.displayPath(grant))

    private fun get(id: String): Map<String, Any?>? {
        val grant = registry.get(id) ?: return null
        return try {
            system.files(grant).check()
            info(grant)
        } catch (error: BridgeFailure) {
            // Gone, or its permission withdrawn: the answer the page asks for. Anything else is a
            // fault, which the page is told of, and not a folder that is not there.
            if (error.failure == Failure.NOT_FOUND || error.failure == Failure.NOT_ALLOWED) return null
            log("The folder could not be checked.", error)
            throw error
        }
    }

    private fun relation(args: Arguments): Map<String, Any?> {
        val above = grantOf(args.text("a"))
        val below = grantOf(args.text("b"))
        listOf(above, below).forEach { system.files(it).check() }
        val down = system.treePath(above.tree, below.tree)?.plus(below.path)
        val path = down?.takeIf { it.take(above.path.size) == above.path }?.drop(above.path.size) ?: reversed(above, below)
        return mapOf("same" to (path?.isEmpty() ?: false), "path" to path)
    }

    /** A folder inside a tree can be above a tree that was chosen on its own: from `Notes` + `a` to `Notes/a/b`. */
    private fun reversed(above: FolderGrant, below: FolderGrant): List<String>? {
        val up = system.treePath(below.tree, above.tree)?.plus(above.path) ?: return null
        return below.path.takeIf { it.take(up.size) == up }?.drop(up.size)
    }

    private fun child(args: Arguments): Map<String, Any?> {
        val grant = grantOf(args.text("folder"))
        val files = files(args)
        val path = path(args)
        val found = files.stat(path) ?: throw nothingAt(path)
        if (!found.directory) throw notADirectory(path)
        val down = grant.path + (files.canonicalPath(path) ?: path)
        return info(registry.grant(grant.tree, down, down.lastOrNull() ?: grant.name))
    }

    private fun listed(entry: ListedEntry) = mapOf("name" to entry.name, "kind" to kind(entry.directory)) + stamped(entry.stamp)
    private fun kind(directory: Boolean) = if (directory) "directory" else "file"
    private fun stamped(stamp: FileStamp?): Map<String, Any?> =
        if (stamp == null) emptyMap() else mapOf("lastModified" to stamp.lastModified, "size" to stamp.size)

    private fun read(file: ReadFile) = mapOf("bytes" to file.content) + stamped(file.stamp)

    private fun readMany(args: Arguments): List<Any?> {
        val files = files(args)
        return files.readMany(args.texts("paths").map(::relativePath)).map { it?.let(::read) }
    }

    private fun write(args: Arguments): Map<String, Any?> {
        val content = args.content("bytes")
        return stamped(files(args).write(below(args), content, args.flag("createDirectories"), ifStamp(args)))
    }

    private fun walk(args: Arguments): Map<String, Any?> {
        val limit = args.whole("limit").coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val walked = files(args).walk(path(args), args.texts("skip").map(::composed).toSet(), limit)
        return mapOf("files" to walked.files, "truncated" to walked.truncated)
    }

    private fun watch(args: Arguments): String {
        val folder = args.text("folder")
        val id = UUID.randomUUID().toString()
        val asked = synchronized(pageLock) { page }
        // A large tree takes a while to watch, and the page may have gone meanwhile.
        val watch = files(args).watch(
            changed = { paths -> if (watches.containsKey(id)) emit("fsChanged", mapOf("folder" to folder, "paths" to paths)) },
            lost = { watches.remove(id)?.close()?.let { emit("watchLost", mapOf("folder" to folder)) } },
        )
        val kept = synchronized(pageLock) { (page == asked).also { if (it) watches[id] = watch } }
        if (!kept) {
            watch.close()
            throw BridgeFailure(Failure.ABORT, "The page that asked for the watch has gone.")
        }
        return id
    }
}

fun ifStamp(args: Arguments): IfStamp? = when (val wanted = args.any("ifStamp")) {
    null -> null
    "absent" -> IfStamp.Absent
    // A stamp with a part of a millisecond is no file's: the write is refused rather than failing.
    is Map<*, *> -> IfStamp.Is(FileStamp(wholeOrNone(wanted["lastModified"]), wholeOrNone(wanted["size"])))
    else -> throw BridgeFailure(Failure.OPERATION, "The argument ifStamp is of the wrong kind.")
}

private fun wholeOrNone(value: Any?): Long {
    val number = (value as? Number)?.toDouble() ?: throw BridgeFailure(Failure.OPERATION, "The argument ifStamp is of the wrong kind.")
    return if (number == Math.rint(number)) number.toLong() else Long.MIN_VALUE
}
