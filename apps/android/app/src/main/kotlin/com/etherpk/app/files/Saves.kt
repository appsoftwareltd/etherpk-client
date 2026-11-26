package com.etherpk.app.files

import com.etherpk.app.bridge.Arguments
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.Handler
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/** Where the person said a copy goes. */
interface SaveTarget {
    val name: String
    fun commit(from: File)
    /** Nothing is to be saved. What the dialog made for it goes. */
    fun abandon()
}

/** `save.*`. The parts gather in a private file, and the place the person chose is written at the end. */
class Saves(private val dir: File, private val choose: (name: String, type: String) -> CompletableFuture<SaveTarget>) {
    private class Save(val target: SaveTarget, val file: File)

    private val saves = ConcurrentHashMap<String, Save>()

    val handlers: Map<String, Handler> = mapOf(
        "save.open" to { args -> choose(SharedFiles.safeName(args.text("name"), 1), args.text("type")).thenApply(::opened) },
        "save.write" to ::write,
        "save.commit" to { args -> finish(args) { it.target.commit(it.file) } },
        "save.abort" to { args -> finish(args) { it.target.abandon() } },
    )

    private fun opened(target: SaveTarget): Map<String, Any?> {
        val id = UUID.randomUUID().toString()
        dir.mkdirs()
        saves[id] = Save(target, File.createTempFile("save", null, dir))
        return mapOf("save" to id, "name" to target.name)
    }

    private fun write(args: Arguments) {
        val save = saves[args.text("save")] ?: throw over()
        synchronized(save) {
            FileOutputStream(save.file, true).use { out -> args.content("bytes").open().use { it.copyTo(out) } }
        }
    }

    private fun finish(args: Arguments, act: (Save) -> Unit) {
        val save = saves.remove(args.text("save")) ?: throw over()
        synchronized(save) {
            try {
                act(save)
            } finally {
                save.file.delete()
            }
        }
    }

    private fun over() = BridgeFailure(Failure.NOT_FOUND, "The save is over.")

    /** The page went with saves open. */
    fun abandonAll() {
        saves.keys.toList().forEach { id -> saves.remove(id)?.let { it.target.abandon(); it.file.delete() } }
    }
}
