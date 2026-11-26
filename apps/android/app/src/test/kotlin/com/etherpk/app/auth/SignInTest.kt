package com.etherpk.app.auth

import com.etherpk.app.bridge.BridgeFailure
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ISSUER = "https://accounts.example"

/** An issuer with single-use refresh tokens, as the account site's are. A replay ends every sign-in. */
private class FakeIssuer(private val now: () -> Long, private val pass: (Long) -> Unit = {}) : Http {
    val log = ArrayList<String>()
    var current = "refresh-0"
    private var answered: Pair<String, String>? = null
    private var rotatedAt = 0L
    var ended = false
    var nonce = ""
    var audience = "etherpk-installed"
    var iss = ISSUER
    /**
     * What to do with a request in place of answering it: null to answer. `lost` never reaches the
     * issuer. `late` acts first and then loses the answer at once, `stall` acts and then loses it when
     * the whole budget has passed. `bare` acts and answers with no refresh token. `refuse` answers 400.
     */
    val faults = ArrayDeque<String?>()
    private val serial = AtomicInteger()

    override fun ask(url: String, headers: Map<String, String>, form: String?, budgetMs: Int): HttpAnswer {
        if (form == null) return HttpAnswer(200, METADATA)
        val fields = form.split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        log.add(fields["grant_type"] ?: "revoke")
        assertEquals(ISSUER, headers["Origin"])
        assertEquals("application/x-www-form-urlencoded", headers["Content-Type"])
        if (fields["grant_type"] != null) assertEquals("urn:etherpk:managed-sync", fields["resource"])
        assertEquals("etherpk-installed", fields["client_id"])
        val fault = faults.removeFirstOrNull()
        if (fault == "lost") throw NotSent("unreachable")
        if (fault == "busy") return HttpAnswer(503, "")
        if (fault == "refuse") return HttpAnswer(400, "{\"error\":\"invalid_grant\"}")
        val answer = act(url, fields)
        if (fault == "late") throw IOException("timed out")
        if (fault == "stall") {
            pass(budgetMs.toLong())
            throw IOException("timed out")
        }
        if (fault == "bare") return HttpAnswer(200, JSONObject(answer.body).apply { remove("refresh_token") }.toString())
        return answer
    }

    @Synchronized private fun act(url: String, fields: Map<String, String>): HttpAnswer {
        if (url.endsWith("/revoke")) {
            if (fields["token"] == current) current = "revoked" else ended = true
            return HttpAnswer(200, "")
        }
        if (fields["grant_type"] == "authorization_code") {
            assertEquals("com.etherpk.app:/auth/callback", fields["redirect_uri"])
            return HttpAnswer(200, tokens(withId = true))
        }
        assertEquals("openid profile email offline_access sync", fields["scope"])
        val sent = fields["refresh_token"]!!
        if (ended) return HttpAnswer(400, "{\"error\":\"invalid_grant\"}")
        answered?.let { (spent, answer) -> if (sent == spent && now() - rotatedAt <= 30_000) return HttpAnswer(200, answer) }
        if (sent != current) {
            ended = true
            return HttpAnswer(400, "{\"error\":\"invalid_grant\"}")
        }
        val answer = tokens(withId = false)
        answered = sent to answer
        rotatedAt = now()
        return HttpAnswer(200, answer)
    }

    private fun tokens(withId: Boolean): String {
        val number = serial.incrementAndGet()
        current = "refresh-$number"
        val json = JSONObject().put("access_token", "access-$number").put("refresh_token", current).put("expires_in", 900)
        if (withId) json.put("id_token", "x." + Base64.getUrlEncoder().withoutPadding().encodeToString(JSONObject(mapOf("iss" to iss, "aud" to audience, "nonce" to nonce, "exp" to (now() / 1000 + 60))).toString().toByteArray()) + ".y")
        return json.toString()
    }

    companion object {
        val METADATA: String = JSONObject(
            mapOf(
                "issuer" to ISSUER, "authorization_endpoint" to "$ISSUER/api/auth/oauth2/authorize", "token_endpoint" to "$ISSUER/api/auth/oauth2/token",
                "revocation_endpoint" to "$ISSUER/api/auth/oauth2/revoke", "code_challenge_methods_supported" to listOf("S256"),
            ),
        ).toString()
    }
}

private class FakeStore(var kept: String? = null) : TokenStore {
    val log = ArrayList<String>()
    var full = false
    override fun load() = kept
    override fun save(refreshToken: String) {
        if (full) throw IOException("full")
        log.add("save $refreshToken")
        kept = refreshToken
    }
    override fun clear() { kept = null }
}

private class FakeBrowser(private val answer: (Map<String, String>) -> String?) : SignInBrowser {
    var opened = 0
    var closed = 0
    override fun open(url: String, accept: (String) -> Boolean): CompletableFuture<String?> {
        opened++
        assertTrue(url.startsWith("$ISSUER/api/auth/oauth2/authorize?"))
        val query = URI(url).rawQuery.split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        return CompletableFuture.completedFuture(answer(query)?.takeIf(accept))
    }
    override fun close() { closed++ }
}

class SignInTest {
    private var time = 1_000_000_000L
    private val issuer = FakeIssuer({ time }, { time += it })
    private val store = FakeStore()
    private var browser = FakeBrowser { query ->
        issuer.nonce = query["nonce"]!!
        "com.etherpk.app:/auth/callback?code=c&state=${query["state"]}&iss=${ISSUER.replace(":", "%3A")}"
    }

    private fun app(browser: SignInBrowser = this.browser, store: TokenStore = this.store) =
        SignIn(Issuer(SignInConfig(ISSUER), issuer, { time }), store, browser, now = { time }, wait = { time += it })

    private fun refusal(body: () -> Any?): String = runCatching { body() }.exceptionOrNull().let { (it as? BridgeFailure)?.failure ?: it?.javaClass?.simpleName ?: "nothing" }

    @Test fun signsInAndKeepsTheRefreshTokenBeforeItAnswers() {
        val app = app()
        assertFalse(app.signedIn())
        assertNull(app.accessToken(false))
        assertEquals("access-1", app.signIn().accessToken)
        assertEquals(listOf("save refresh-1"), store.log)
        assertTrue(app.signedIn())
        assertEquals("access-1", app.accessToken(false)!!.accessToken)
        assertEquals(listOf("authorization_code"), issuer.log)
    }

    @Test fun askWithTheParametersTheIssuerNeeds() {
        var seen = emptyMap<String, String>()
        app(FakeBrowser { seen = it; null }).let { assertEquals("AbortError", refusal { it.signIn() }) }
        assertEquals("code", seen["response_type"])
        assertEquals("etherpk-installed", seen["client_id"])
        assertEquals("com.etherpk.app:/auth/callback", seen["redirect_uri"])
        assertEquals("openid profile email offline_access sync", seen["scope"])
        assertEquals("urn:etherpk:managed-sync", seen["resource"])
        assertEquals("S256", seen["code_challenge_method"])
        for (name in listOf("state", "nonce", "code_challenge")) assertEquals(name, 43, seen[name]!!.length)
        assertFalse(seen.containsKey("prompt"))
    }

    @Test fun aWrongNonceAudienceOrIssuerIsNotKept() {
        for (spoil in listOf<() -> Unit>({ issuer.audience = "another" }, { issuer.iss = "https://other.example" })) {
            spoil()
            assertNotEquals("nothing", refusal { app().signIn() })
        }
        issuer.audience = "etherpk-installed"
        issuer.iss = ISSUER
        val wrong = FakeBrowser { issuer.nonce = "another"; "com.etherpk.app:/auth/callback?code=c&state=${it["state"]}&iss=$ISSUER" }
        assertNotEquals("nothing", refusal { app(wrong).signIn() })
        assertNull(store.kept)
    }

    @Test fun callbacksThatAreNotThisAttempts() {
        val attempt = Attempt("state", "nonce", "verifier")
        val config = SignInConfig(ISSUER)
        fun read(address: String) = readCallback(address, attempt, config)
        val iss = "iss=https%3A%2F%2Faccounts.example"
        assertEquals(Callback.Code("c"), read("com.etherpk.app:/auth/callback?code=c&state=state&$iss"))
        assertEquals(Callback.Denied, read("com.etherpk.app:/auth/callback?error=access_denied&state=state&$iss"))
        assertEquals(Callback.Failed("server_error"), read("com.etherpk.app:/auth/callback?error=server_error&state=state&$iss"))
        for (address in listOf(
            "com.etherpk.app:/auth/callback?code=c&state=other&$iss", "com.etherpk.app:/auth/callback?code=c&$iss", "com.etherpk.app:/auth/callback?code=c&state=state",
            "com.etherpk.app:/auth/callback?code=c&state=state&iss=https%3A%2F%2Fother.example", "com.etherpk.app:/auth/callback?code=c&state=state&state=state&$iss",
            "com.etherpk.app:/auth/callback?state=state&$iss", "com.etherpk.app:/other?code=c&state=state&$iss", "com.etherpk.app://host/auth/callback?code=c&state=state&$iss",
            "https://accounts.example/auth/callback?code=c&state=state&$iss", "not an address", "",
        )) assertEquals(address, Callback.Other, read(address))
    }

    @Test fun aCodeIsExchangedOnce() {
        issuer.faults.addLast("late")
        assertEquals("NetworkError", refusal { app().signIn() })
        assertEquals(listOf("authorization_code"), issuer.log)
        assertNull(store.kept)
    }

    @Test fun refreshesWhenUnderAMinuteIsLeftAndWhenForced() {
        val app = app().also { it.signIn() }
        time += 839_000
        assertEquals("access-1", app.accessToken(false)!!.accessToken)
        time += 2_000
        assertEquals("access-2", app.accessToken(false)!!.accessToken)
        assertEquals("refresh-2", store.kept)
        assertEquals("access-3", app.accessToken(true)!!.accessToken)
    }

    @Test fun aRestartCarriesOnWithTheKeptToken() {
        app().signIn()
        val after = app()
        assertTrue(after.signedIn())
        assertEquals("access-2", after.accessToken(false)!!.accessToken)
    }

    @Test fun aLostAnswerIsAskedForAgainWithinTheWindow() {
        val app = app().also { it.signIn() }
        issuer.faults.addLast("late")
        assertEquals("access-2", app.accessToken(true)!!.accessToken)
        assertFalse(issuer.ended)
        assertEquals(listOf("authorization_code", "refresh_token", "refresh_token"), issuer.log)
    }

    /** A stalled answer used the whole budget of the first attempt, and the repeat still came in time. */
    @Test fun aStalledAnswerIsAskedForAgainWithinTheWindow() {
        val app = app().also { it.signIn() }
        issuer.faults.addLast("stall")
        assertEquals("access-2", app.accessToken(true)!!.accessToken)
        assertFalse(issuer.ended)
        assertEquals("refresh-2", store.kept)
        assertEquals("access-3", app.accessToken(true)!!.accessToken)
        assertFalse(issuer.ended)
    }

    /** Every answer lost until the window closed: this device signs in again, and the others stay signed in. */
    @Test fun aTokenSentWithNoAnswerIsNeverSentAfterTheWindow() {
        val app = app().also { it.signIn() }
        repeat(5) { issuer.faults.addLast("stall") }
        assertNull(app.accessToken(true))
        assertFalse(app.signedIn())
        assertNull(store.kept)
        val sent = issuer.log.count { it == "refresh_token" }
        time += 60_000
        assertNull(app.accessToken(true))
        assertNull(app().accessToken(true))
        assertEquals(sent, issuer.log.count { it == "refresh_token" })
        assertFalse(issuer.ended)
    }

    @Test fun anAnswerWithNoRefreshTokenEndsTheSignInHereAlone() {
        val app = app().also { it.signIn() }
        issuer.faults.addLast("bare")
        assertNull(app.accessToken(true))
        assertNull(store.kept)
        time += 60_000
        assertNull(app().accessToken(true))
        assertFalse(issuer.ended)
        assertEquals(listOf("authorization_code", "refresh_token"), issuer.log)
    }

    @Test fun aRefusedCodeIsAFailureWithAName() {
        issuer.faults.addLast("refuse")
        val error = runCatching { app().signIn() }.exceptionOrNull() as BridgeFailure
        assertEquals("OperationError", error.failure)
        assertEquals("The issuer refused the sign-in.", error.message)
        assertNull(store.kept)
    }

    @Test fun anIssuerThatCannotBeReachedIsANetworkErrorAndKeepsTheSignIn() {
        for (fault in listOf("lost", "busy")) {
            val app = app().also { it.signIn() }
            repeat(2) { issuer.faults.addLast(fault) }
            assertEquals("NetworkError", refusal { app.accessToken(true) })
            assertTrue(app.signedIn())
            assertEquals(issuer.current, store.kept)
            assertTrue(app.accessToken(true)!!.accessToken.startsWith("access-"))
        }
    }

    @Test fun aRefusalEndsTheSignIn() {
        val app = app().also { it.signIn() }
        issuer.ended = true
        assertNull(app.accessToken(true))
        assertFalse(app.signedIn())
        assertNull(store.kept)
        assertNull(app.accessToken(false))
        assertEquals(listOf("authorization_code", "refresh_token"), issuer.log)
    }

    @Test fun aStoreThatFailsHoldsNoSpentToken() {
        val app = app().also { it.signIn() }
        store.full = true
        assertEquals("access-2", app.accessToken(true)!!.accessToken)
        assertNull(store.kept)
        assertTrue(app.signedIn())
    }

    @Test fun signOutForgetsFirstAndRevokesTheLastToken() {
        val app = app().also { it.signIn(); it.accessToken(true) }
        app.signOut()
        assertFalse(app.signedIn())
        assertNull(store.kept)
        assertFalse(issuer.ended)
        assertEquals("revoke", issuer.log.last())
        app.signOut()
        assertEquals(1, issuer.log.count { it == "revoke" })
    }

    @Test fun signOutOfflineStillForgets() {
        val app = app().also { it.signIn() }
        issuer.faults.addLast("lost")
        app.signOut()
        assertFalse(app.signedIn())
        assertNull(store.kept)
    }

    /** Property: many callers at once, with an issuer that loses answers, never send a spent token late. */
    @Test fun oneRefreshAtATimeWhateverTheOrder() {
        val random = Random(20261125)
        repeat(40) {
            val issuer = FakeIssuer({ time })
            val store = FakeStore("refresh-0")
            val app = SignIn(Issuer(SignInConfig(ISSUER), issuer, { time }), store, browser, now = { time }, wait = {})
            repeat(6) { if (random.nextInt(3) == 0) issuer.faults.addLast(listOf("late", "lost", "busy").random(random)) else issuer.faults.addLast(null) }
            val start = CountDownLatch(1)
            val callers = List(8) { index ->
                CompletableFuture.supplyAsync {
                    start.await()
                    runCatching { if (index == 7) app.signedIn() else app.accessToken(index % 2 == 0) }
                }
            }
            start.countDown()
            callers.forEach { it.get(20, TimeUnit.SECONDS) }
            assertFalse("the issuer saw a spent token", issuer.ended)
            // Whatever was lost, the kept token is the last one the app was given.
            if (store.log.isNotEmpty()) assertEquals(store.log.last().removePrefix("save "), store.kept)
        }
    }

    @Test fun callersAtOnceShareOneRefreshEvenWhenForced() {
        val gate = CountDownLatch(1)
        val held = CountDownLatch(1)
        val slow = Http { url, headers, form, budget ->
            if (form != null && "refresh_token=" in form) {
                held.countDown()
                gate.await()
            }
            issuer.ask(url, headers, form, budget)
        }
        val app = SignIn(Issuer(SignInConfig(ISSUER), slow, { time }), store, browser, now = { time }, wait = {}).also { it.signIn() }
        val first = CompletableFuture.supplyAsync { app.accessToken(true) }
        held.await()
        val second = CompletableFuture.supplyAsync { app.accessToken(true) }
        Thread.sleep(200)
        gate.countDown()
        assertEquals("access-2", first.get(10, TimeUnit.SECONDS)!!.accessToken)
        assertEquals("access-2", second.get(10, TimeUnit.SECONDS)!!.accessToken)
        assertEquals(1, issuer.log.count { it == "refresh_token" })
    }

    @Test fun aBuildWithNoIssuerHasNoSignIn() {
        val app = SignIn(null, store, browser)
        assertFalse(app.signedIn())
        assertNull(app.accessToken(true))
        assertEquals("NotSupportedError", refusal { app.signIn() })
    }

    @Test fun issuersAndEndpointsAreChecked() {
        for (good in listOf(ISSUER, "http://127.0.0.1:5475", "http://localhost:5475")) assertEquals(good, checkedIssuer(good))
        for (bad in listOf("", "$ISSUER/", "$ISSUER/path", "http://accounts.example", "https://a@accounts.example", "ftp://accounts.example", "accounts.example")) assertNull(bad, checkedIssuer(bad))
        val metadata = JSONObject(FakeIssuer.METADATA)
        assertEquals("$ISSUER/api/auth/oauth2/token", checkedEndpoints(metadata, ISSUER).token)
        for ((name, value) in listOf("issuer" to "https://other.example", "token_endpoint" to "https://other.example/token", "token_endpoint" to "https://a@accounts.example/token", "revocation_endpoint" to "http://accounts.example/x", "code_challenge_methods_supported" to "S256", "authorization_endpoint" to 7)) {
            val spoiled = JSONObject(FakeIssuer.METADATA).put(name, value)
            assertEquals(name, "WrongAnswer", refusal { checkedEndpoints(spoiled, ISSUER) })
        }
    }
}
