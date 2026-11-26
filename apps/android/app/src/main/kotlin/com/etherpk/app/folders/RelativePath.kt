package com.etherpk.app.folders

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.text.Normalizer

private const val MAX_PATH = 4096

/**
 * A path from the page as its parts, or null for one that must be refused (`checkedRelativePath` in
 * packages/native-bridge). The empty path is the folder itself. This is the first check of two: what
 * the path reaches on the disk is checked too, as a link inside a folder can point out of it.
 */
fun checkedRelativePath(path: String): List<String>? {
    if (path.length > MAX_PATH) return null
    if (path.isEmpty()) return emptyList()
    val parts = path.split('/')
    return if (parts.any { part -> part.isEmpty() || part == "." || part == ".." || part.any { it == '\\' || it < ' ' } }) null else parts
}

fun relativePath(path: String): List<String> =
    checkedRelativePath(path) ?: throw BridgeFailure(Failure.SECURITY, "The path leads out of the folder.")

/** As [relativePath], for a call that must never act on the chosen folder itself. */
fun pathBelowFolder(path: String): List<String> =
    relativePath(path).ifEmpty { throw BridgeFailure(Failure.SECURITY, "The chosen folder itself cannot be changed.") }

/** A name as the page has it. A disk may store it decomposed. */
fun composed(name: String): String = Normalizer.normalize(name, Normalizer.Form.NFC)

/** The name of the file a write is made in before it takes the real one's place. Listings leave it out. */
const val PARTIAL_PREFIX = ".etherpk-"
const val PARTIAL_SUFFIX = ".crswap"
fun isPartialName(name: String): Boolean = name.startsWith(PARTIAL_PREFIX) && name.endsWith(PARTIAL_SUFFIX)
