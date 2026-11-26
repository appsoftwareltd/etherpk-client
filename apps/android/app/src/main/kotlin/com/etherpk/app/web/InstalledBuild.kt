package com.etherpk.app.web

import java.io.InputStream

/** What is answered for one address of the app's own host. */
class Served(val status: Int, val reason: String, val mime: String, val charset: String?, val headers: Map<String, String>, val body: InputStream?)

/**
 * Answers every address of the app's own host from the Installed Build in the APK, and never from the
 * network. A file is answered as it is. A page's address, which names no file, is answered with the
 * shell page, whose script opens it. Anything else is a 404. These are `installedAnswer`'s rules in
 * apps/client/installed-build.ts, which the desktop app answers with, checked by the same cases.
 */
class InstalledBuild(private val open: (path: String) -> InputStream?) {
    private val shellPolicy: String by lazy { text("csp.txt") ?: throw IllegalStateException("The Installed Build has no csp.txt.") }

    /** [path] is the address's path as it was sent, and [navigation] whether a document is being loaded. */
    fun serve(method: String, path: String, navigation: Boolean): Served {
        if (method != "GET" && method != "HEAD") return plain(405, "Method Not Allowed")
        val file = decoded(path) ?: return plain(404, "Not Found")
        if (isFileName(file)) open(file)?.let { return found(file, it) }
        if (!navigation || !isPageAddress(path)) return plain(404, "Not Found")
        return served("text/html", shellPolicy, "no-store", open(SHELL) ?: throw IllegalStateException("The Installed Build has no $SHELL."))
    }

    private fun found(file: String, body: InputStream): Served {
        val mime = mimeOf(file)
        val policy = (if (mime == "text/html") text("$file.csp.txt") else null) ?: shellPolicy
        // Everything under here is named by its content, so it never changes under one name.
        val cache = if (file.startsWith("_app/immutable/")) "public, max-age=31536000, immutable" else "no-cache"
        return served(mime, policy, cache, body)
    }

    /** The policy goes with every answer, not only with pages: a worker takes the policy of its own script. */
    private fun served(mime: String, policy: String, cache: String, body: InputStream) =
        Served(200, "OK", mime, if (isText(mime)) "utf-8" else null, COMMON + mapOf("Content-Security-Policy" to policy, "Cache-Control" to cache), body)

    private fun plain(status: Int, reason: String) =
        Served(status, reason, "text/plain", "utf-8", COMMON + mapOf("Content-Security-Policy" to "default-src 'none'", "Cache-Control" to "no-store"), reason.byteInputStream())

    /**
     * The path with its escapes undone, or null for one that is not escaped right. Bytes that are not
     * UTF-8 are refused, as the Client's `decodeURIComponent` refuses them, where `URLDecoder` would put
     * a replacement character in their place and the path would be taken for an address of the app.
     */
    private fun decoded(path: String): String? {
        val bytes = java.io.ByteArrayOutputStream()
        var at = 0
        while (at < path.length) {
            val char = path[at]
            if (char == '%') {
                if (at + 2 >= path.length) return null
                val byte = path.substring(at + 1, at + 3).toIntOrNull(16) ?: return null
                bytes.write(byte)
                at += 3
            } else {
                // A plus sign in a path is a plus sign.
                bytes.write(char.toString().toByteArray(Charsets.UTF_8))
                at += 1
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(bytes.toByteArray())).toString().removePrefix("/")
        } catch (_: java.nio.charset.CharacterCodingException) {
            null
        }
    }

    /** Whether a path may be looked for among the build's files. The policies are not files of the app. */
    private fun isFileName(path: String) =
        path.split('/').none { it.isEmpty() || it == "." || it == ".." || it.any { char -> char == '\\' || char < ' ' } } && !path.endsWith("csp.txt")

    private fun text(path: String): String? = open(path)?.use { it.readBytes().toString(Charsets.UTF_8).trim() }

    companion object {
        private const val SHELL = "index.html"
        private val NOT_PAGES = Regex("^/(?:api|auth|_app|extensions|demo-graph|__native|__etherpk-[a-z]+)(?:/|$)")
        private val WORKSPACE = Regex("^/(?:graph|folder|g)/")
        private val FILE_NAME = Regex("\\.[^/]*$")

        /**
         * Whether an address that names no file is the app's to show (isPageAddress in
         * apps/client/installed-build.ts). The unit test reads the cases every shell is checked against,
         * packages/native-bridge/test-vectors/installed-build-serving.json. A workspace's address may
         * end in a file's name, so only outside one does a dot in the last part mean a file.
         */
        fun isPageAddress(path: String): Boolean {
            if (NOT_PAGES.containsMatchIn(path)) return false
            return WORKSPACE.containsMatchIn(path) || !FILE_NAME.containsMatchIn(path)
        }

        private val COMMON = mapOf(
            "X-Content-Type-Options" to "nosniff",
            "Referrer-Policy" to "strict-origin-when-cross-origin",
            "Cross-Origin-Resource-Policy" to "same-origin",
        )
        private val MIMES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css", "json" to "application/json",
            "md" to "text/markdown", "txt" to "text/plain", "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg", "webp" to "image/webp", "gif" to "image/gif", "ico" to "image/x-icon", "woff2" to "font/woff2",
            "woff" to "font/woff", "ttf" to "font/ttf", "wasm" to "application/wasm", "pdf" to "application/pdf", "epub" to "application/epub+zip",
            "webmanifest" to "application/manifest+json", "xml" to "application/xml", "mp4" to "video/mp4", "webm" to "video/webm",
        )

        fun mimeOf(file: String): String = MIMES[file.substringAfterLast('/').substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
        private fun isText(mime: String) = mime.startsWith("text/") || mime == "application/json" || mime == "image/svg+xml" || mime == "application/manifest+json"
    }
}
