package com.etherpk.app.update

import java.net.URI
import java.net.URISyntaxException
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Base64
import org.bouncycastle.math.ec.rfc8032.Ed25519
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** A public key this app trusts for the update feed: an id, and the 32 bytes in base64. */
class UpdateKey(val id: String, val publicKey: String)

class Release(val version: String, val minimumVersion: String, val page: String)

class FeedPayload(val sequence: Long, val channels: Map<String, Map<String, Release>>)

class FeedProblem(val problem: String, message: String) : Exception(message)

/**
 * The signed list of releases, described in apps/desktop/src/update/feed.ts and pinned for both by
 * packages/native-bridge/test-vectors/update-feed.json. Nothing in it is read before its signature is
 * good, and a list older than one already taken, or past its date, is refused.
 *
 * Android has Ed25519 from version 13 and this app runs on 11, so the check is Bouncy Castle's.
 */
object UpdateFeed {
    private val DOMAIN = "etherpk-update-feed-v1\n".toByteArray()
    private const val LONGEST = 256 * 1024
    private const val MOST_SIGNATURES = 16
    private const val MAX_SAFE = 9007199254740991L
    private val VERSION = Regex("(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})")
    private val SHA512 = Regex("[0-9a-f]{128}")
    private val INSTANT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    fun read(feed: String, keys: List<UpdateKey>, highestSequence: Long, now: Long): FeedPayload {
        val json = try {
            JSONObject(String(verifiedPayload(feed, keys), Charsets.UTF_8))
        } catch (_: JSONException) {
            throw FeedProblem("schema", "The payload is not JSON.")
        }
        val expires = instant(json.opt("expires"))
        val sequence = whole(json.opt("sequence"))
        val channels = channels(json.opt("channels"))
        if (json.opt("schema") != 1 || expires == null || sequence == null || channels == null) throw FeedProblem("schema", "The payload is not one this version reads.")
        if (sequence < highestSequence) throw FeedProblem("rollback", "The feed is older than one already taken.")
        if (expires <= now) throw FeedProblem("expired", "The feed has expired.")
        return FeedPayload(sequence, channels)
    }

    private fun verifiedPayload(feed: String, keys: List<UpdateKey>): ByteArray {
        if (feed.toByteArray().size > LONGEST) throw FeedProblem("format", "The feed is too long.")
        val envelope = try {
            JSONObject(feed)
        } catch (_: JSONException) {
            throw FeedProblem("format", "The feed is not JSON.")
        }
        val signatures = envelope.opt("signatures") as? JSONArray ?: throw FeedProblem("format", "The feed is not an envelope.")
        val payload = exactBase64(envelope.opt("payload")) ?: throw FeedProblem("format", "The payload is not base64.")
        val signed = DOMAIN + payload
        for (index in 0 until minOf(signatures.length(), MOST_SIGNATURES)) {
            val entry = signatures.opt(index) as? JSONObject ?: continue
            val key = keys.firstOrNull { it.id == entry.opt("key") }?.let { exactBase64(it.publicKey) }?.takeIf { it.size == Ed25519.PUBLIC_KEY_SIZE } ?: continue
            val signature = exactBase64(entry.opt("signature"))?.takeIf { it.size == Ed25519.SIGNATURE_SIZE } ?: continue
            if (Ed25519.verify(signature, 0, key, 0, signed, 0, signed.size)) return payload
        }
        throw FeedProblem("signature", "No key this app trusts has signed the feed.")
    }

    /** Base64 as it is written once, or null. */
    private fun exactBase64(value: Any?): ByteArray? {
        val text = value as? String ?: return null
        return try {
            Base64.getDecoder().decode(text).takeIf { Base64.getEncoder().encodeToString(it) == text }
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun whole(value: Any?): Long? = when (value) {
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }?.takeIf { it in 1..MAX_SAFE }

    /** A date written one way only: UTC with milliseconds. */
    private fun instant(value: Any?): Long? = try {
        (value as? String)?.let { text -> Instant.parse(text).takeIf { INSTANT.format(it) == text }?.toEpochMilli() }
    } catch (_: DateTimeParseException) {
        null
    }

    private fun channels(value: Any?): Map<String, Map<String, Release>>? {
        val json = value as? JSONObject ?: return null
        return json.keys().asSequence().associateWith { name ->
            val channel = json.opt(name) as? JSONObject ?: return null
            channel.keys().asSequence().associateWith { platform -> release(channel.opt(platform)) ?: return null }
        }
    }

    private fun release(value: Any?): Release? {
        val json = value as? JSONObject ?: return null
        val version = version(json.opt("version")) ?: return null
        val minimum = version(json.opt("minimumVersion")) ?: return null
        val page = https(json.opt("page")) ?: return null
        https(json.opt("url")) ?: return null
        if (whole(json.opt("size")) == null || (json.opt("sha512") as? String)?.matches(SHA512) != true) return null
        return if (compare(minimum, version) > 0) null else Release(version, minimum, page)
    }

    private fun version(value: Any?): String? = (value as? String)?.takeIf { it.matches(VERSION) }

    private fun https(value: Any?): String? = try {
        (value as? String)?.takeIf { URI(it).let { uri -> uri.scheme == "https" && uri.host != null } }
    } catch (_: URISyntaxException) {
        null
    }

    /**
     * Below zero when [a] is older than [b], by Semantic Versioning's order. The app's own version can
     * be a prerelease (`0.52.0-rc.1`), which comes before its release; build data after `+` is passed
     * over. The feed's versions are releases.
     */
    fun compare(a: String, b: String): Int {
        val (leftCore, leftPre) = parts(a)
        val (rightCore, rightPre) = parts(b)
        for (index in 0 until maxOf(leftCore.size, rightCore.size)) {
            val order = leftCore.getOrElse(index) { 0 }.compareTo(rightCore.getOrElse(index) { 0 })
            if (order != 0) return order
        }
        if (leftPre.isEmpty() || rightPre.isEmpty()) return rightPre.size.coerceAtMost(1) - leftPre.size.coerceAtMost(1)
        for (index in 0 until minOf(leftPre.size, rightPre.size)) {
            val order = identifierOrder(leftPre[index], rightPre[index])
            if (order != 0) return order
        }
        return leftPre.size.compareTo(rightPre.size)
    }

    private fun parts(version: String): Pair<List<Long>, List<String>> {
        val plain = version.substringBefore('+')
        val core = plain.substringBefore('-').split('.').map { it.toLongOrNull() ?: 0 }
        val pre = if ('-' in plain) plain.substringAfter('-').split('.') else emptyList()
        return core to pre
    }

    /** Numbers by value and before words, which go by their characters. */
    private fun identifierOrder(one: String, other: String): Int {
        val left = one.toLongOrNull()
        val right = other.toLongOrNull()
        return when {
            left != null && right != null -> left.compareTo(right)
            left != null -> -1
            right != null -> 1
            else -> one.compareTo(other)
        }
    }
}
