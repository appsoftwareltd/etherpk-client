package com.etherpk.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Parcelable
import androidx.core.content.IntentCompat
import com.etherpk.app.files.Offered
import com.etherpk.app.files.displayName
import com.etherpk.app.files.isType
import com.etherpk.app.web.etherpkLink

/** What an intent asks of the app. Any app can send one, so nothing in it is trusted. */
sealed interface Received {
    class Link(val url: String) : Received
    class SignInReturn(val address: String) : Received
    class Share(val title: String, val text: String, val streams: List<Uri>, val type: String?) : Received
    /** [writable] when the app that sent it let EtherPK write it. */
    class Document(val uri: Uri, val type: String, val writable: Boolean) : Received
    data object Nothing : Received
}

private const val MOST_TEXT = 100_000
private const val MOST_TITLE = 1_000

/** Reads an intent. Extras another app made up may not even unpack, and then there is nothing in it. */
fun readIntent(intent: Intent, ownAuthority: String): Received = try {
    when (intent.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> readShare(intent, ownAuthority)
        Intent.ACTION_PROCESS_TEXT -> text(intent, Intent.EXTRA_PROCESS_TEXT).let { if (it.isEmpty()) Received.Nothing else Received.Share("", it, emptyList(), null) }
        Intent.ACTION_VIEW -> readView(intent, ownAuthority)
        else -> Received.Nothing
    }
} catch (_: RuntimeException) {
    Received.Nothing
}

private fun text(intent: Intent, name: String, limit: Int = MOST_TEXT): String = intent.getCharSequenceExtra(name)?.toString().orEmpty().take(limit)

private fun readShare(intent: Intent, ownAuthority: String): Received {
    val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Parcelable::class.java).orEmpty()
    } else {
        listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Parcelable::class.java))
    }
    val title = text(intent, Intent.EXTRA_SUBJECT, MOST_TITLE).ifEmpty { text(intent, Intent.EXTRA_TITLE, MOST_TITLE) }
    // Files only with the sender's permission to read them, which the system adds to a share when the
    // sender may give it. Without it EtherPK would read them with its own rights.
    val files = if (grants(intent, Intent.FLAG_GRANT_READ_URI_PERMISSION)) streams.filterIsInstance<Uri>().filter { isContent(it, ownAuthority) } else emptyList()
    val share = Received.Share(title, text(intent, Intent.EXTRA_TEXT), files, intent.type)
    return if (share.title.isEmpty() && share.text.isEmpty() && share.streams.isEmpty()) Received.Nothing else share
}

private fun readView(intent: Intent, ownAuthority: String): Received {
    val uri = intent.data ?: return Received.Nothing
    val address = uri.toString()
    return when (uri.scheme?.lowercase()) {
        "etherpk" -> etherpkLink(address)?.let { Received.Link(it) } ?: Received.Nothing
        "com.etherpk.app" -> Received.SignInReturn(address)
        "content" -> if (isContent(uri, ownAuthority) && grants(intent, Intent.FLAG_GRANT_READ_URI_PERMISSION)) {
            Received.Document(uri, intent.type?.takeIf(::isType).orEmpty(), grants(intent, Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
        } else {
            Received.Nothing
        }
        else -> Received.Nothing
    }
}

/** Whether the sender gave EtherPK this permission for the intent's content. */
fun grants(intent: Intent, flag: Int): Boolean = intent.flags and flag != 0

/**
 * Another app's content. Not a `file:` path, which would be read with this app's own rights, and not
 * this app's own provider, which would hand its private files back to it as if they were shared.
 */
private fun isContent(uri: Uri, ownAuthority: String): Boolean {
    val authority = uri.authority?.substringAfterLast('@') ?: return false
    return uri.scheme == "content" && !authority.equals(ownAuthority, ignoreCase = true) && !authority.startsWith("$ownAuthority.", ignoreCase = true)
}

fun offered(resolver: ContentResolver, uri: Uri, type: String?): Offered = Offered(
    displayName(resolver, uri),
    (try { resolver.getType(uri) } catch (_: RuntimeException) { null }) ?: type?.takeUnless { '*' in it },
) { resolver.openInputStream(uri) }
