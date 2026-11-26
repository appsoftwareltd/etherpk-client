package com.etherpk.app.auth

import com.etherpk.app.bridge.BridgeFailure
import com.etherpk.app.bridge.Failure
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Where the refresh token is kept between starts. */
interface TokenStore {
    fun load(): String?
    /** On the disk when this returns. */
    fun save(refreshToken: String)
    fun clear()
}

/** The system browser, as a sign-in uses it. */
interface SignInBrowser {
    /** Opens [url]. Completes with the address the browser came back to, or null when the person closed it. */
    fun open(url: String, accept: (String) -> Boolean): CompletableFuture<String?>
    fun close()
}

class Grant(val accessToken: String, val expiresAt: Long)

/**
 * The app's one sign-in. The refresh token stays here and the page is given access tokens.
 *
 * The refresh token is single use, and one used again later ends the account's sign-in on every
 * device. So everything that reads or changes it takes its turn, one at a time, and a new one is on
 * the disk before the access token that came with it is answered.
 */
class SignIn(
    private val issuer: Issuer?,
    private val store: TokenStore,
    private val browser: SignInBrowser,
    private val log: (String, Throwable) -> Unit = { _, _ -> },
    private val now: () -> Long = System::currentTimeMillis,
    private val wait: (Long) -> Unit = Thread::sleep,
) {
    private val turn = Any()
    private var loaded = false
    private var refreshToken: String? = null
    @Volatile private var grant: Grant? = null
    @Volatile private var signedInNow: Boolean? = null

    private fun configured(): Issuer = issuer ?: throw BridgeFailure(Failure.NOT_SUPPORTED, "This build has no sign-in.")

    private fun token(): String? {
        if (!loaded) {
            refreshToken = store.load()
            loaded = true
        }
        return refreshToken
    }

    /** Answered without the network, and without waiting for a refresh that is using it. */
    fun signedIn(): Boolean {
        if (issuer == null) return false
        val known = signedInNow
        return known ?: synchronized(turn) { token() != null }.also { signedInNow = it }
    }

    fun signIn(): Grant = asFailure {
        val issuer = configured()
        browser.close()
        val endpoints = issuer.discover()
        val attempt = Attempt.fresh()
        val returned = browser.open(authorizeUrl(issuer.config, endpoints, attempt)) { readCallback(it, attempt, issuer.config) != Callback.Other }
        val address = try {
            returned.get(ATTEMPT_MS, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.TimeoutException) {
            null
        } catch (error: java.util.concurrent.ExecutionException) {
            throw error.cause ?: error
        }
        when (val callback = address?.let { readCallback(it, attempt, issuer.config) }) {
            is Callback.Code -> synchronized(turn) { keep(issuer.exchange(callback.code, attempt)) }
            is Callback.Failed -> throw BridgeFailure(Failure.OPERATION, "The sign-in failed: ${callback.error.take(100)}")
            else -> throw BridgeFailure(Failure.ABORT, "The person did not sign in.")
        }
    }

    /** Store first, answer second. */
    private fun keep(tokens: TokenSet): Grant {
        refreshToken = tokens.refreshToken
        loaded = true
        signedInNow = true
        val fresh = Grant(tokens.accessToken, tokens.expiresAt)
        grant = fresh
        try {
            store.save(tokens.refreshToken)
        } catch (error: Exception) {
            // Still signed in until the app ends. The token in the store is spent, and using it again
            // would end the account's sign-in on every device, so better none than that one.
            log("The sign-in could not be kept.", error)
            store.clear()
        }
        return fresh
    }

    /** Null when nobody is signed in or the issuer has ended the sign-in. NetworkError when it cannot be reached. */
    fun accessToken(forceRefresh: Boolean): Grant? {
        if (!signedIn()) return null
        // Read before the turn: a caller that waited for another's refresh takes what that one got.
        val before = grant
        return asFailure {
            synchronized(turn) {
                val current = grant
                val fresh = current != null && current.expiresAt - now() > REFRESH_WHEN_LEFT_MS
                when {
                    current != null && fresh && (!forceRefresh || current !== before) -> current
                    else -> refresh()
                }
            }
        }
    }

    private fun refresh(): Grant? {
        val token = token() ?: return null
        return try {
            keep(refreshWithinTheWindow(token))
        } catch (error: SignInOver) {
            log("The sign-in is over.", error)
            forget()
            null
        } catch (error: TokenSpent) {
            // Signed out here alone. Sending the token again would end the account's other devices.
            log("The refresh token may be spent and its answer was lost, so this device signs in again.", error)
            forget()
            null
        }
    }

    /**
     * A refresh, repeated while the issuer still repeats its answer to the same token. Once a request
     * may have reached the issuer, the token may be spent: it is sent again only while the repeat
     * window is open, and never after. Each attempt has a budget short enough that a repeat still
     * reaches the issuer inside the window, counted from before the first one was sent.
     */
    private fun refreshWithinTheWindow(token: String): TokenSet {
        // Before the token is sent, so that a wrong or missing discovery answer leaves it unspent.
        configured().discover()
        var firstSent: Long? = null
        var unsent = 0
        var lastFailure: Exception? = null
        while (true) {
            val budget = when (val sent = firstSent) {
                null -> ATTEMPT_BUDGET_MS
                else -> minOf(ATTEMPT_BUDGET_MS, sent + REPEAT_WINDOW_MS - REPEAT_MARGIN_MS - now())
            }
            if (firstSent != null && budget < SHORTEST_ATTEMPT_MS) throw TokenSpent(lastFailure)
            val asked = now()
            try {
                return configured().refresh(token, budget.toInt())
            } catch (error: IssuerUnavailable) {
                // Never sent, and nothing sent before it: the token is as it was. One more try, then
                // the page is told the issuer cannot be reached and asks another time.
                if (!error.mayHaveActed && firstSent == null && ++unsent > 1) throw error
                if (error.mayHaveActed && firstSent == null) firstSent = asked
                lastFailure = error
            } catch (error: WrongAnswer) {
                // The issuer answered and the answer cannot be used, so it has spent the token.
                throw TokenSpent(error)
            }
            wait(REPEAT_AFTER_MS)
        }
    }

    /** A refresh token sent with no answer, and the window for sending it again has closed. */
    private class TokenSpent(cause: Throwable?) : Exception("The refresh token was sent and no answer came back.", cause)

    private fun forget() {
        refreshToken = null
        loaded = true
        signedInNow = false
        grant = null
        store.clear()
    }

    fun signOut() {
        browser.close()
        if (!signedIn()) return
        // In turn, so a refresh on its way has ended and the token revoked is the last one issued.
        // Revoking one already spent would end the account's other devices.
        val last = synchronized(turn) { token().also { forget() } } ?: return
        try {
            configured().revoke(last)
        } catch (error: Exception) {
            log("The sign-in was forgotten here and could not be revoked.", error)
        }
    }

    private fun <T> asFailure(body: () -> T): T = try {
        body()
    } catch (error: IssuerUnavailable) {
        throw BridgeFailure(Failure.NETWORK, error.message.orEmpty(), error)
    } catch (error: SignInOver) {
        // A code that was refused at the exchange: expired, or used already.
        throw BridgeFailure(Failure.OPERATION, "The issuer refused the sign-in.", error)
    } catch (error: WrongAnswer) {
        throw BridgeFailure(Failure.OPERATION, "The issuer's answer could not be used.", error)
    }

    private companion object {
        /** A person may register, find a second factor or reset a password on the way. */
        const val ATTEMPT_MS = 15 * 60 * 1000L
        const val REFRESH_WHEN_LEFT_MS = 60_000L
        /** The issuer repeats its answer to a refresh token used again within this long. */
        const val REPEAT_WINDOW_MS = 30_000L
        const val REPEAT_AFTER_MS = 2_000L
        /** Short enough that the first attempt, the pause and a repeat all fit inside the window. */
        const val ATTEMPT_BUDGET_MS = 10_000L
        /** A repeat must reach the issuer this long before the window closes, for clocks that differ. */
        const val REPEAT_MARGIN_MS = 3_000L
        /** A repeat with less time than this is not tried. */
        const val SHORTEST_ATTEMPT_MS = 3_000L
    }
}
