package com.etherpk.app.update

import com.etherpk.app.auth.Http
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import com.etherpk.app.folders.replaceFile
import java.io.File

/** What a person reads when the check fails. The log has the reason. */
const val CHECK_FAILED = "Could not check for an update. Check your connection and try again."

/**
 * Whether a newer EtherPK is out, from the signed feed. The person downloads it from the release's
 * page. Off when the build has no feed address or no key to trust.
 */
class Updates(
    private val feedUrl: String,
    private val keys: List<UpdateKey>,
    private val current: String,
    private val sequenceFile: File,
    private val http: Http,
    private val changed: (Map<String, Any?>) -> Unit,
    private val log: (String, Throwable) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val on = feedUrl.isNotEmpty() && keys.isNotEmpty()
    private val turn = Any()
    @Volatile private var status: Map<String, Any?> = mapOf("state" to if (on) "idle" else "off")

    fun status(): Map<String, Any?> = status

    private fun set(next: Map<String, Any?>): Map<String, Any?> {
        status = next
        changed(next)
        return next
    }

    /** One check at a time. A second asker waits, and looks again only if the first did not answer. */
    fun check(): Map<String, Any?> {
        if (!on) return status
        val asked = status
        return synchronized(turn) {
            if (status !== asked && status["state"] != "failed") status else look()
        }
    }

    private fun look(): Map<String, Any?> {
        val before = status
        set(mapOf("state" to "checking"))
        return try {
            set(newer()?.let(::available) ?: mapOf("state" to "idle"))
        } catch (error: Exception) {
            log("The update feed was not taken.", error)
            // An update already on offer stays on offer when a later look fails.
            set(if (before["state"] == "available") before else mapOf("state" to "failed", "message" to CHECK_FAILED))
        }
    }

    private fun available(release: Release): Map<String, Any?> = mapOf(
        "state" to "available",
        "version" to release.version,
        "install" to false,
        "required" to (UpdateFeed.compare(current, release.minimumVersion) < 0),
        "page" to release.page,
    )

    private fun newer(): Release? {
        val answer = http.ask(feedUrl, mapOf("Cache-Control" to "no-cache"), null, BUDGET_MS)
        if (answer.status != 200) throw IllegalStateException("The feed was answered with ${answer.status}.")
        val highest = highestSequence()
        val payload = UpdateFeed.read(answer.body, keys, highest, now())
        if (payload.sequence > highest) replaceFile(sequenceFile, payload.sequence.toString().toByteArray())
        val release = payload.channels["stable"]?.get("android") ?: return null
        return release.takeIf { UpdateFeed.compare(it.version, current) > 0 }
    }

    private fun highestSequence(): Long = if (sequenceFile.exists()) sequenceFile.readText().toLongOrNull() ?: 0 else 0

    fun install(): Nothing = throw BridgeFailure(Failure.NOT_SUPPORTED, "The person downloads this one.")

    private companion object {
        const val BUDGET_MS = 30_000
    }
}
