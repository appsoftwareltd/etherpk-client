package com.etherpk.app.web

import java.net.URI
import java.net.URISyntaxException

/** The app's own origin. The host answers nothing on the network: every request to it stays in the app. */
const val APP_HOST = "installed.app.etherpk.com"
const val APP_ORIGIN = "https://$APP_HOST"

private val OPENABLE = setOf("http", "https", "mailto", "tel")
private const val LONGEST_LINK = 8192

/** An address another app may be asked to open, or null. The web, mail and the telephone, and nothing else. */
fun openableUrl(url: String): String? {
    val trimmed = url.trim()
    val uri = parsed(trimmed) ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme !in OPENABLE) return null
    val complete = if (scheme == "http" || scheme == "https") !uri.rawAuthority.isNullOrEmpty() else !uri.rawSchemeSpecificPart.isNullOrEmpty()
    return trimmed.takeIf { complete }
}

/** Whether an address is a page of the app. */
fun isAppUrl(url: String): Boolean {
    val uri = parsed(url) ?: return false
    return uri.scheme == "https" && uri.host == APP_HOST && uri.port == -1 && uri.rawUserInfo == null
}

/** The part of an app address kept for a later start: from the path on. */
fun addressWithin(url: String): String? = if (isAppUrl(url)) url.removePrefix(APP_ORIGIN).ifEmpty { "/" } else null

/** An `etherpk:` link another app opened, or null for one that is not the app's kind. */
fun etherpkLink(url: String): String? = url.takeIf { it.length <= LONGEST_LINK && it.startsWith("etherpk:", ignoreCase = true) && it.none { char -> char < ' ' } }

/** Java's parser refuses characters a browser passes on, a space or a bracket in a query among them. */
private fun parsed(url: String): URI? = try {
    URI(url.replace(Regex("[ \"<>\\\\^`{|}\\[\\]]")) { "%" + "%02X".format(it.value[0].code) })
} catch (_: URISyntaxException) {
    null
}
