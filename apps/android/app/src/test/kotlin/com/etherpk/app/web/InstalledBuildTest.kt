package com.etherpk.app.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstalledBuildTest {
    private val files = mapOf(
        "index.html" to "<p>shell</p>", "csp.txt" to "default-src 'self'\n", "_app/env.js" to "env", "_app/immutable/a.js" to "a", "favicon.svg" to "<svg/>",
        "__etherpk-ebook/reader.html" to "<p>reader</p>", "__etherpk-ebook/reader.html.csp.txt" to "default-src 'none'", "demo-graph/pages/Tea & Cake.md" to "tea",
    )
    private val asked = ArrayList<String>()
    private val build = InstalledBuild { asked.add(it); files[it]?.byteInputStream() }

    private fun serve(path: String, navigation: Boolean = false, method: String = "GET") = build.serve(method, path, navigation)
    private fun body(served: Served) = served.body!!.readBytes().decodeToString()

    @Test fun aFileIsAnsweredWithItsType() {
        val served = serve("/_app/immutable/a.js")
        assertEquals("a", body(served))
        assertEquals("text/javascript", served.mime)
        assertEquals("nosniff", served.headers["X-Content-Type-Options"])
        assertTrue(served.headers["Cache-Control"]!!.contains("immutable"))
        assertEquals("no-cache", serve("/_app/env.js").headers["Cache-Control"])
        assertEquals("image/svg+xml", serve("/favicon.svg").mime)
        assertEquals("tea", body(serve("/demo-graph/pages/Tea%20&%20Cake.md")))
    }

    @Test fun everyAnswerCarriesAPolicy() {
        for (path in listOf("/", "/_app/env.js", "/nowhere", "/__etherpk-ebook/reader.html")) {
            assertTrue(path, serve(path, navigation = true).headers["Content-Security-Policy"]!!.startsWith("default-src"))
        }
        assertEquals("default-src 'self'", serve("/graphs", navigation = true).headers["Content-Security-Policy"])
        assertEquals("default-src 'none'", serve("/__etherpk-ebook/reader.html", navigation = true).headers["Content-Security-Policy"])
    }

    @Test fun aNavigationToAnAppAddressGetsTheShell() {
        for (path in listOf("/", "/graphs", "/graph/folder/Notes/d/Garden", "/graph/folder/Notes/d/Release%201.2", "/graph/folder/a/d/100%25", "/share", "/extension-sign-in", "//")) {
            val served = serve(path, navigation = true)
            assertEquals(path, 200, served.status)
            assertEquals("<p>shell</p>", body(served))
            assertEquals("text/html", served.mime)
            assertEquals("no-store", served.headers["Cache-Control"])
        }
    }

    /** The cases every shell is checked against, which the Client's rule and the desktop app read too. */
    private val serving = org.json.JSONObject(
        java.io.File(System.getProperty("etherpk.repository")!!, "packages/native-bridge/test-vectors/installed-build-serving.json").readText(),
    )

    @Test fun pageAddressesAreTheClients() {
        val cases = serving.getJSONArray("pageAddresses")
        assertTrue(cases.length() >= 20)
        for (at in 0 until cases.length()) {
            val case = cases.getJSONArray(at)
            assertEquals(case.getString(0), case.getBoolean(1), InstalledBuild.isPageAddress(case.getString(0)))
        }
    }

    @Test fun everyShellAnswersAlike() {
        val files = serving.getJSONObject("files")
        val shared = InstalledBuild { path -> if (files.has(path)) files.getString(path).byteInputStream() else null }
        val requests = serving.getJSONArray("requests")
        for (at in 0 until requests.length()) {
            val request = requests.getJSONObject(at)
            val method = request.optString("method", "GET")
            val name = "$method ${request.getString("path")} navigation=${request.getBoolean("navigation")}"
            val served = shared.serve(method, request.getString("path"), request.getBoolean("navigation"))
            assertEquals(name, request.getInt("status"), served.status)
            if (request.has("body")) assertEquals(name, request.getString("body"), served.body!!.readBytes().decodeToString())
            assertEquals(name, request.getString("policy"), served.headers["Content-Security-Policy"])
        }
    }

    @Test fun whatIsNotThereIsA404AndNeverTheShell() {
        for (path in listOf("/graphs", "/missing.js", "/api/v1/x")) assertEquals(path, 404, serve(path).status)
        for (path in listOf("/_app/missing.js", "/api/v1/x", "/auth/login", "/extensions/a/b.js", "/__native/bytes/x", "/demo-graph/x.md", "/favicon.png", "/%zz")) {
            assertEquals(path, 404, serve(path, navigation = true).status)
        }
    }

    @Test fun theAppsFilesAreReadAndNotWritten() {
        for (method in listOf("POST", "PUT", "DELETE", "OPTIONS")) assertEquals(405, serve("/", navigation = true, method = method).status)
    }

    @Test fun noPathLeadsOutOfTheBuildOrToAPolicy() {
        for (path in listOf("/../secret", "/_app/../../secret", "/%2e%2e/secret", "/..%2fsecret", "/_app/%5c..%5csecret", "/a%00b", "//etc/hosts", "/csp.txt", "/__etherpk-ebook/reader.html.csp.txt")) {
            asked.clear()
            assertEquals(path, 404, serve(path).status)
            assertEquals(path, emptyList<String>(), asked)
        }
    }

    @Test fun addressesOfTheAppAndOfOthers() {
        assertTrue(isAppUrl("https://installed.app.etherpk.com/graphs?a=[b]#c d"))
        for (url in listOf("http://installed.app.etherpk.com/", "https://installed.app.etherpk.com:8443/", "https://installed.app.etherpk.com.example/", "https://a@installed.app.etherpk.com/", "https://example.com/", "javascript:1", "")) assertFalse(url, isAppUrl(url))
        assertEquals("/graph/a?b#c", addressWithin("https://installed.app.etherpk.com/graph/a?b#c"))
        assertEquals("/", addressWithin("https://installed.app.etherpk.com"))
        assertNull(addressWithin("https://example.com/graph"))
    }

    @Test fun onlyWebMailAndPhoneAddressesAreOpened() {
        for (url in listOf("https://example.com/a b?q=[1]", "HTTP://example.com", "mailto:someone@example.com", "tel:+441234567890")) assertEquals(url, openableUrl(url))
        for (url in listOf("file:///etc/hosts", "javascript:alert(1)", "data:text/html,x", "intent://x#Intent;end", "content://a/b", "etherpk:/graph", "market://details", "not an address", "", "https:", "https://", "mailto:", " ", "android-app://x")) assertNull(url, openableUrl(url))
    }

    @Test fun anEtherpkLinkIsPassedOnAsItIs() {
        assertEquals("etherpk:/graph/sync/a/d/b#task=1-c", etherpkLink("etherpk:/graph/sync/a/d/b#task=1-c"))
        for (url in listOf("https://example.com", "etherpkx:/a", "etherpk:/a\nb", "etherpk:/" + "a".repeat(9000))) assertNull(etherpkLink(url))
    }
}
