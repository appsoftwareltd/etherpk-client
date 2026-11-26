package com.etherpk.testapp

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Sends EtherPK what its extras say. `send`: `share` with `text` and `files` (names of TestShares, with
 * commas), `view` with one file, or `process` with `text`, which is asked for as a result.
 */
class SendActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uris = intent.getStringExtra("files").orEmpty().split(',').filter { it.isNotEmpty() }.map { Uri.parse("content://com.etherpk.testapp.shares/$it") }
        when (intent.getStringExtra("send")) {
            "share" -> startActivity(share(uris))
            "view" -> startActivity(grant(Intent(Intent.ACTION_VIEW).setDataAndType(uris.single(), "text/markdown"), uris).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            "process" -> startActivityForResult(Intent(Intent.ACTION_PROCESS_TEXT).setPackage(APP).setType("text/plain").putExtra(Intent.EXTRA_PROCESS_TEXT, intent.getStringExtra("text")), 1)
        }
        finish()
    }

    private fun share(uris: List<Uri>): Intent {
        val share = if (uris.size > 1) Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris)) else Intent(Intent.ACTION_SEND)
        if (uris.size == 1) share.putExtra(Intent.EXTRA_STREAM, uris.single())
        intent.getStringExtra("text")?.let { share.putExtra(Intent.EXTRA_TEXT, it) }
        intent.getStringExtra("title")?.let { share.putExtra(Intent.EXTRA_SUBJECT, it) }
        return grant(share.setType(if (uris.isEmpty()) "text/plain" else "*/*"), uris)
    }

    private fun grant(sent: Intent, uris: List<Uri>): Intent {
        if (uris.isNotEmpty()) sent.clipData = ClipData(null, arrayOf("*/*"), ClipData.Item(uris.first())).also { clip -> uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) } }
        return sent.setPackage(APP).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private companion object {
        const val APP = "com.etherpk.app"
    }
}
