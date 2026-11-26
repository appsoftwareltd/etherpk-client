package com.etherpk.app.folders

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Failure
import java.io.Closeable

/** Whole epoch milliseconds and bytes. */
data class FileStamp(val lastModified: Long, val size: Long)

class ListedEntry(val name: String, val directory: Boolean, val stamp: FileStamp?)

/** What is at a path: a directory, or a file with its stamp. */
class Found(val directory: Boolean, val stamp: FileStamp?)

class ReadFile(val stamp: FileStamp, val content: Content)

class Walked(val files: List<String>, val truncated: Boolean)

/** What must hold for a write to go through. */
sealed interface IfStamp {
    data object Absent : IfStamp
    data class Is(val stamp: FileStamp) : IfStamp
}

/**
 * The files of one chosen folder. Paths are parts below it, already checked by [relativePath].
 *
 * Every method says NotFoundError when the folder itself is gone, so that it is never read as a folder
 * with nothing in it, and NotAllowedError when its permission is.
 */
interface FolderFiles {
    /** Throws when the folder cannot be used. */
    fun check()
    fun list(path: List<String>, stamps: Boolean): List<ListedEntry>
    fun stat(path: List<String>): Found?
    /** The path as the disk spells it, composed. Null when nothing is there. */
    fun canonicalPath(path: List<String>): List<String>?
    fun read(path: List<String>): ReadFile
    /** Many files, in the order asked, with null for one that is not there or is a directory. */
    fun readMany(paths: List<List<String>>): List<ReadFile?> = paths.map { path ->
        try {
            read(path)
        } catch (error: BridgeFailure) {
            if (error.failure != Failure.NOT_FOUND && error.failure != Failure.TYPE_MISMATCH) throw error
            // A folder that went while this ran is not a folder of files that are not there.
            check()
            null
        }
    }
    fun write(path: List<String>, content: Content, createDirectories: Boolean, ifStamp: IfStamp?): FileStamp
    fun createDirectory(path: List<String>)
    fun remove(path: List<String>)
    fun move(from: List<String>, to: List<String>)
    fun walk(path: List<String>, skip: Set<String>, limit: Int): Walked
    /** Reports paths that changed, or null when it cannot say which. [lost] is called if it stops working. */
    fun watch(changed: (List<String>?) -> Unit, lost: () -> Unit): Closeable
}

fun nothingAt(path: List<String>) = BridgeFailure(Failure.NOT_FOUND, "Nothing is at ${path.joinToString("/")}.")
fun notAFile(path: List<String>) = BridgeFailure(Failure.TYPE_MISMATCH, "${path.joinToString("/")} is a folder.")
fun notADirectory(path: List<String>) = BridgeFailure(Failure.TYPE_MISMATCH, "${path.joinToString("/")} is a file.")
fun folderGone(cause: Throwable? = null) = BridgeFailure(Failure.NOT_FOUND, "The folder is gone.", cause)

fun checkIfStamp(current: FileStamp?, ifStamp: IfStamp?) {
    val holds = when (ifStamp) {
        null -> true
        IfStamp.Absent -> current == null
        is IfStamp.Is -> current == ifStamp.stamp
    }
    if (!holds) throw BridgeFailure(Failure.NO_MODIFICATION, "The file is not what it was.")
}
