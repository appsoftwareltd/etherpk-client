package com.etherpk.app

import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import com.etherpk.app.bridge.failed
import java.util.concurrent.CompletableFuture

/** One of the system's dialogs, asked and answered. Made before the activity starts, as the platform requires. */
class Asker<I, O>(activity: ComponentActivity, contract: ActivityResultContract<I, O>) {
    private var waiting: CompletableFuture<O>? = null
    private val launcher = activity.registerForActivityResult(contract) { answer ->
        val asked = waiting
        waiting = null
        asked?.complete(answer)
    }

    fun ask(input: I): CompletableFuture<O> {
        if (waiting != null) return failed(BridgeFailure(Failure.BUSY, "The dialog is open."))
        val asked = CompletableFuture<O>()
        waiting = asked
        try {
            launcher.launch(input)
        } catch (error: android.content.ActivityNotFoundException) {
            waiting = null
            asked.completeExceptionally(BridgeFailure(Failure.NOT_SUPPORTED, "The device has no such dialog.", error))
        }
        return asked
    }

    /** The activity is going. Nobody will answer. */
    fun end() {
        waiting?.completeExceptionally(BridgeFailure(Failure.ABORT, "The app closed."))
        waiting = null
    }
}
