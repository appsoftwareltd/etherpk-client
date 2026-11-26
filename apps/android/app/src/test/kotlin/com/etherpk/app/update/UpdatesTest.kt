package com.etherpk.app.update

import com.etherpk.app.auth.Http
import com.etherpk.app.auth.HttpAnswer
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.Instant
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    private val vectors = JSONObject(File(System.getProperty("etherpk.repository"), "packages/native-bridge/test-vectors/update-feed.json").readText())
    private val keys = vectors.getJSONArray("keys").let { all -> List(all.length()) { all.getJSONObject(it) } }.map { UpdateKey(it.getString("id"), it.getString("publicKey")) }
    private val cases = vectors.getJSONArray("cases").let { all -> List(all.length()) { all.getJSONObject(it) } }
    private val good = cases.first { it.getString("name") == "good" }.getString("feed")
    private val dir = Files.createTempDirectory("etherpk-updates").toFile()
    private val now = Instant.parse("2029-01-01T00:00:00.000Z").toEpochMilli()
    private val told = ArrayList<Any?>()

    @After fun clear() { dir.deleteRecursively() }

    /** The cases every reader of the feed must agree on. */
    @Test fun everyVectorHasItsOutcome() {
        assertTrue(cases.size >= 30)
        for (case in cases) {
            val outcome = try {
                UpdateFeed.read(case.getString("feed"), keys, case.getLong("highestSequence"), Instant.parse(case.getString("now")).toEpochMilli())
                "ok"
            } catch (problem: FeedProblem) {
                problem.problem
            }
            assertEquals(case.getString("name"), case.getString("outcome"), outcome)
        }
    }

    private fun updates(current: String, feedUrl: String = "https://downloads.example/feed.json", keys: List<UpdateKey> = this.keys, http: Http = Http { _, _, _, _ -> HttpAnswer(200, good) }) =
        Updates(feedUrl, keys, current, File(dir, "sequence"), http, { told.add(it["state"]) }, now = { now })

    @Test fun anOlderAppIsOfferedTheReleasesPage() {
        val updates = updates("1.0.5")
        val expected = mapOf("state" to "available", "version" to "1.1.0", "install" to false, "required" to false, "page" to "https://downloads.example/1.1.0")
        assertEquals(expected, updates.check())
        assertEquals(expected, updates.status())
        assertEquals(listOf("checking", "available"), told)
        assertEquals("10", File(dir, "sequence").readText())
        assertEquals(true, updates("0.9.0").check()["required"])
    }

    @Test fun theCurrentOneAndANewerOneAreOfferedNothing() {
        assertEquals("idle", updates("1.1.0").check()["state"])
        assertEquals("idle", updates("1.10.0").check()["state"])
    }

    @Test fun withNoFeedOrNoKeyItIsOffAndAsksNothing() {
        val asked = Http { _, _, _, _ -> throw AssertionError("asked") }
        assertEquals(mapOf("state" to "off"), updates("1.0.0", keys = emptyList(), http = asked).check())
        assertEquals(mapOf("state" to "off"), updates("1.0.0", feedUrl = "", http = asked).check())
        assertEquals(emptyList<Any>(), told)
    }

    @Test fun aFailureSaysSoAndAnOfferOutlastsIt() {
        var answer: () -> HttpAnswer = { throw IOException("offline") }
        val updates = updates("1.0.5") { _, _, _, _ -> answer() }
        assertEquals(mapOf("state" to "failed", "message" to CHECK_FAILED), updates.check())
        answer = { HttpAnswer(404, "") }
        assertEquals("failed", updates.check()["state"])
        answer = { HttpAnswer(200, good) }
        assertEquals("available", updates.check()["state"])
        answer = { throw IOException("offline") }
        assertEquals("available", updates.check()["state"])
    }

    @Test fun anOlderFeedIsRefusedAfterANewerOne() {
        File(dir, "sequence").writeText("11")
        assertEquals("failed", updates("1.0.5").check()["state"])
    }

    @Test fun versionsCompareByNumber() {
        for ((a, b) in listOf("1.2.0" to "1.10.0", "0.9.9" to "1.0.0", "1.0.0" to "1.0.1")) {
            assertTrue(UpdateFeed.compare(a, b) < 0)
            assertTrue(UpdateFeed.compare(b, a) > 0)
        }
        assertEquals(0, UpdateFeed.compare("1.2.3", "1.2.3"))
    }

    @Test fun aPrereleaseComesBeforeItsRelease() {
        val ordered = listOf("1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1-rc.1", "1.0.1")
        for ((index, a) in ordered.withIndex()) for ((other, b) in ordered.withIndex()) {
            assertEquals("$a against $b", index.compareTo(other).coerceIn(-1, 1), UpdateFeed.compare(a, b).coerceIn(-1, 1))
        }
        assertEquals(0, UpdateFeed.compare("1.0.0+build.5", "1.0.0"))
        // A prerelease of the feed's version is offered the release, and the release itself is not.
        assertEquals("available", updates("1.1.0-rc.1").check()["state"])
        File(dir, "sequence").delete()
        assertTrue(updates("1.1.0").check()["state"] != "available")
    }

    /** Property: the order is an order, over versions made at random, with prereleases among them. */
    @Test fun versionsAreInOneOrder() {
        val random = kotlin.random.Random(20261126)
        fun version(): String {
            val core = List(3) { random.nextInt(3) }.joinToString(".")
            if (random.nextBoolean()) return core
            val words = listOf("alpha", "beta", "rc", "0", "1", "11", "2")
            return core + "-" + List(random.nextInt(1, 4)) { words.random(random) }.joinToString(".")
        }
        repeat(System.getenv("ANDROID_FUZZ_RUNS")?.toInt() ?: 2000) {
            val (a, b, c) = Triple(version(), version(), version())
            val ab = UpdateFeed.compare(a, b).coerceIn(-1, 1)
            assertEquals("$a $b", -ab, UpdateFeed.compare(b, a).coerceIn(-1, 1))
            if (ab <= 0 && UpdateFeed.compare(b, c) <= 0) assertTrue("$a $b $c", UpdateFeed.compare(a, c) <= 0)
            if (a == b) assertEquals(0, ab)
        }
    }
}
