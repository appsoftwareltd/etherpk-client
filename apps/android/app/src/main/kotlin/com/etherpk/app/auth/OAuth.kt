package com.etherpk.app.auth

import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Signing in to EtherPK: the messages to the issuer, and the checks on what it answers. The
 * authorization code flow with PKCE (RFC 7636) in the system browser, returning to an address only
 * this app takes (RFC 8252). The app is a public client and holds no secret.
 */
class SignInConfig(
    /** An origin, with no slash at the end. */
    val issuer: String,
    val clientId: String = "etherpk-installed",
    val resource: String = "urn:etherpk:managed-sync",
    val scope: String = "openid profile email offline_access sync",
    val redirectUri: String = "com.etherpk.app:/auth/callback",
)

class Endpoints(val authorize: String, val token: String, val revoke: String?)

/** One sign-in on its way through the browser. In memory only. */
class Attempt(val state: String, val nonce: String, val verifier: String) {
    companion object {
        fun fresh() = Attempt(random(32), random(32), random(64))
    }
}

class TokenSet(val accessToken: String, val refreshToken: String, val expiresAt: Long)

/**
 * The issuer did not answer, or not with an answer about this sign-in. [mayHaveActed] is false when
 * the request cannot have reached it, so a refresh token sent with it is still unspent.
 */
class IssuerUnavailable(message: String, cause: Throwable? = null, val mayHaveActed: Boolean = true) : Exception(message, cause)

/** The issuer answered that the sign-in is over. */
class SignInOver(message: String) : Exception(message)

/** The answer is not one this app may act on. */
class WrongAnswer(message: String) : Exception(message)

/** The issuer of a build, or null for none. Plain http is for a developer's own computer. */
fun checkedIssuer(issuer: String): String? {
    val uri = parsed(issuer) ?: return null
    val loopback = uri.host == "127.0.0.1" || uri.host == "localhost"
    if (originOf(uri) != issuer) return null
    return issuer.takeIf { uri.scheme == "https" || (uri.scheme == "http" && loopback) }
}

/** Every address the app will send a token to is on the issuer's own origin. */
fun checkedEndpoints(metadata: JSONObject, issuer: String): Endpoints {
    if (metadata.opt("issuer") != issuer) throw WrongAnswer("The metadata is not of this issuer.")
    val methods = metadata.opt("code_challenge_methods_supported") as? JSONArray
    if (methods == null || (0 until methods.length()).none { methods.opt(it) == "S256" }) throw WrongAnswer("The issuer does not take PKCE with S256.")
    fun endpoint(name: String): String {
        val value = metadata.opt(name) as? String ?: throw WrongAnswer("The metadata has no $name.")
        val uri = parsed(value)
        if (uri == null || originOf(uri) != issuer || uri.rawUserInfo != null) throw WrongAnswer("The $name is not on the issuer's origin.")
        return value
    }
    return Endpoints(
        authorize = endpoint("authorization_endpoint"),
        token = endpoint("token_endpoint"),
        revoke = if (metadata.has("revocation_endpoint")) endpoint("revocation_endpoint") else null,
    )
}

fun authorizeUrl(config: SignInConfig, endpoints: Endpoints, attempt: Attempt): String {
    val challenge = base64Url(MessageDigest.getInstance("SHA-256").digest(attempt.verifier.toByteArray(Charsets.US_ASCII)))
    val query = form(
        "response_type" to "code",
        "client_id" to config.clientId,
        "redirect_uri" to config.redirectUri,
        "scope" to config.scope,
        "resource" to config.resource,
        "state" to attempt.state,
        "nonce" to attempt.nonce,
        "code_challenge" to challenge,
        "code_challenge_method" to "S256",
    )
    return endpoints.authorize + (if ('?' in endpoints.authorize) "&" else "?") + query
}

sealed interface Callback {
    data class Code(val code: String) : Callback
    data object Denied : Callback
    data class Failed(val error: String) : Callback
    /** Not this attempt's. The attempt goes on waiting. */
    data object Other : Callback
}

/** What a returning address says. One with another state, or that another issuer made (RFC 9207), is not this attempt's. */
fun readCallback(address: String, attempt: Attempt, config: SignInConfig): Callback {
    val uri = parsed(address) ?: return Callback.Other
    val expected = parsed(config.redirectUri)!!
    if (uri.scheme != expected.scheme || uri.rawAuthority != null || uri.rawPath != expected.rawPath) return Callback.Other
    val query = fields(uri.rawQuery.orEmpty())
    fun single(name: String) = query[name]?.singleOrNull()
    if (single("state") != attempt.state || single("iss") != config.issuer) return Callback.Other
    val error = single("error")
    if (error != null) return if (error == "access_denied") Callback.Denied else Callback.Failed(error)
    return single("code")?.takeIf { it.isNotEmpty() }?.let { Callback.Code(it) } ?: Callback.Other
}

/** Decoded, not verified: it came straight from the issuer over TLS (OpenID Connect Core 3.1.3.7, point 6). */
fun checkIdToken(idToken: Any?, config: SignInConfig, nonce: String, now: Long) {
    val claims = try {
        JSONObject(String(Base64.getUrlDecoder().decode((idToken as? String).orEmpty().split('.').getOrNull(1).orEmpty()), Charsets.UTF_8))
    } catch (_: IllegalArgumentException) {
        null
    } catch (_: JSONException) {
        null
    }
    val audience = claims?.opt("aud")
    val ours = audience == config.clientId || (audience is JSONArray && audience.length() == 1 && audience.opt(0) == config.clientId)
    val ahead = (claims?.opt("exp") as? Number)?.let { it.toLong() * 1000 > now } ?: false
    if (claims == null || claims.opt("iss") != config.issuer || claims.opt("nonce") != nonce || !ours || !ahead) throw WrongAnswer("The ID token is not for this sign-in.")
}

class Issuer(val config: SignInConfig, private val http: Http, private val now: () -> Long = System::currentTimeMillis) {
    @Volatile private var endpoints: Endpoints? = null

    fun discover(): Endpoints = endpoints ?: run {
        val answer = ask("${config.issuer}/.well-known/openid-configuration", mapOf("Accept" to "application/json"), null, DISCOVERY_BUDGET_MS)
        // Discovery carries no token, so nothing is spent whatever happens to it.
        if (answer.status != 200) throw IssuerUnavailable("Discovery was answered with ${answer.status}.", mayHaveActed = false)
        val metadata = try {
            JSONObject(answer.body)
        } catch (error: JSONException) {
            throw IssuerUnavailable("The metadata could not be read.", error, mayHaveActed = false)
        }
        checkedEndpoints(metadata, config.issuer).also { endpoints = it }
    }

    private fun ask(url: String, headers: Map<String, String>, form: String?, budgetMs: Int): HttpAnswer = try {
        http.ask(url, headers, form, budgetMs)
    } catch (error: NotSent) {
        throw IssuerUnavailable(error.message.orEmpty(), error, mayHaveActed = false)
    } catch (error: IOException) {
        throw IssuerUnavailable(error.message.orEmpty(), error, mayHaveActed = form != null)
    }

    private fun json(answer: HttpAnswer): JSONObject = try {
        JSONObject(answer.body)
    } catch (error: JSONException) {
        throw IssuerUnavailable("The answer (${answer.status}) could not be read.", error)
    }

    /** A form post from the app itself. The issuer's framework refuses one with no Origin of its own. */
    private fun post(url: String, form: String, budgetMs: Int): HttpAnswer {
        val headers = mapOf("Origin" to config.issuer, "Content-Type" to "application/x-www-form-urlencoded", "Accept" to "application/json")
        return ask(url, headers, form, budgetMs)
    }

    private fun tokens(form: String, budgetMs: Int): Pair<TokenSet, Any?> {
        val token = discover().token
        val asked = now()
        val answer = post(token, form, budgetMs)
        if (answer.status == 400 || answer.status == 401) throw SignInOver("The issuer answered ${answer.status}.")
        // 429 and 503 say the request was turned away before it was acted on. Any other answer may
        // come after the issuer has spent the token, from the issuer or from a proxy in front of it.
        if (answer.status != 200) throw IssuerUnavailable("The issuer answered ${answer.status}.", mayHaveActed = answer.status != 429 && answer.status != 503)
        val body = json(answer)
        val access = body.opt("access_token") as? String
        val refresh = body.opt("refresh_token") as? String
        if (access == null || refresh == null) throw WrongAnswer("The answer holds no tokens.")
        val seconds = (body.opt("expires_in") as? Number)?.toLong()?.takeIf { it > 0 } ?: 900
        return TokenSet(access, refresh, asked + seconds * 1000) to body.opt("id_token")
    }

    /** Asked once and never again: a code presented twice ends the tokens issued for it. */
    fun exchange(code: String, attempt: Attempt): TokenSet {
        val (tokens, idToken) = tokens(
            form(
                "grant_type" to "authorization_code", "code" to code, "client_id" to config.clientId,
                "redirect_uri" to config.redirectUri, "code_verifier" to attempt.verifier, "resource" to config.resource,
            ),
            EXCHANGE_BUDGET_MS,
        )
        checkIdToken(idToken, config, attempt.nonce, now())
        return tokens
    }

    fun refresh(refreshToken: String, budgetMs: Int): TokenSet = tokens(
        form(
            "grant_type" to "refresh_token", "refresh_token" to refreshToken, "client_id" to config.clientId,
            "scope" to config.scope, "resource" to config.resource,
        ),
        budgetMs,
    ).first

    fun revoke(refreshToken: String) {
        val revoke = discover().revoke ?: return
        val answer = post(revoke, form("token" to refreshToken, "token_type_hint" to "refresh_token", "client_id" to config.clientId), REVOKE_BUDGET_MS)
        if (answer.status != 200) throw IssuerUnavailable("The revocation was answered with ${answer.status}.")
    }

    private companion object {
        const val DISCOVERY_BUDGET_MS = 5_000
        const val EXCHANGE_BUDGET_MS = 10_000
        const val REVOKE_BUDGET_MS = 10_000
    }
}

private val secureRandom = SecureRandom()
private fun random(bytes: Int) = base64Url(ByteArray(bytes).also(secureRandom::nextBytes))
private fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
private fun encoded(value: String): String = URLEncoder.encode(value, "UTF-8")
fun form(vararg fields: Pair<String, String>): String = fields.joinToString("&") { (name, value) -> encoded(name) + "=" + encoded(value) }

private fun fields(query: String): Map<String, List<String>> = query.split('&').filter { it.isNotEmpty() }.groupBy(
    { decoded(it.substringBefore('=')) },
    { decoded(it.substringAfter('=', "")) },
)

private fun decoded(value: String): String = try {
    URLDecoder.decode(value, "UTF-8")
} catch (_: IllegalArgumentException) {
    value
}

private fun parsed(address: String): URI? = try {
    URI(address)
} catch (_: URISyntaxException) {
    null
}

private fun originOf(uri: URI): String? {
    val host = uri.host ?: return null
    return uri.scheme + "://" + host.lowercase() + if (uri.port == -1) "" else ":${uri.port}"
}
