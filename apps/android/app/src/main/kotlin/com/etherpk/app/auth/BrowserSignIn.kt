package com.etherpk.app.auth

import android.content.ActivityNotFoundException
import android.os.Handler
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.browser.auth.AuthTabIntent
import androidx.core.net.toUri
import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.util.concurrent.CompletableFuture

/**
 * Signing in through an Auth Tab, which hands the returning address straight back. A browser without
 * one opens a Custom Tab, and the address arrives as a link this app takes ([returned]).
 */
class BrowserSignIn(activity: ComponentActivity) : SignInBrowser {
    private class Waiting(val accept: (String) -> Boolean, val answer: CompletableFuture<String?>)

    private val main = Handler(Looper.getMainLooper())
    private var waiting: Waiting? = null
    private var tabClosed = false
    private var resumed = false
    private val giveUp = Runnable { end(null) }
    private val launcher = AuthTabIntent.registerActivityResultLauncher(activity, ::answered)

    override fun open(url: String, accept: (String) -> Boolean): CompletableFuture<String?> {
        close()
        val answer = CompletableFuture<String?>()
        waiting = Waiting(accept, answer)
        tabClosed = false
        try {
            AuthTabIntent.Builder().build().launch(launcher, url.toUri(), REDIRECT_SCHEME)
        } catch (error: ActivityNotFoundException) {
            waiting = null
            answer.completeExceptionally(BridgeFailure(Failure.NOT_SUPPORTED, "The device has no browser.", error))
        }
        return answer
    }

    private fun answered(result: AuthTabIntent.AuthResult) {
        val address = result.resultUri?.toString()
        if (result.resultCode == AuthTabIntent.RESULT_OK && address != null) {
            returned(address)
            return
        }
        // Closed, or a Custom Tab whose address is on its way as a link of its own.
        tabClosed = true
        if (resumed) giveUpSoon()
    }

    /** An address came back from a browser. False when no sign-in is waiting for it. */
    fun returned(address: String): Boolean {
        val asked = waiting ?: return false
        if (!asked.accept(address)) return false
        end(address)
        return true
    }

    /** A tab that closed while the app was behind it is only known to be closed once the app is in front. */
    fun resumed() {
        resumed = true
        if (waiting != null && tabClosed) giveUpSoon()
    }

    fun paused() {
        resumed = false
        main.removeCallbacks(giveUp)
    }

    private fun giveUpSoon() {
        main.removeCallbacks(giveUp)
        main.postDelayed(giveUp, LINK_MAY_FOLLOW_MS)
    }

    private fun end(address: String?) {
        main.removeCallbacks(giveUp)
        val asked = waiting ?: return
        waiting = null
        asked.answer.complete(address)
    }

    override fun close() = end(null)

    companion object {
        const val REDIRECT_SCHEME = "com.etherpk.app"
        private const val LINK_MAY_FOLLOW_MS = 2_000L
    }
}
