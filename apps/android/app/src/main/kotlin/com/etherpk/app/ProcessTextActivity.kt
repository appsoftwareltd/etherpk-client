package com.etherpk.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Takes text selected in another app to the app's own screen. Only the text goes on. */
class ProcessTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = try {
            intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        } catch (_: RuntimeException) {
            // Extras another app made up may not unpack.
            null
        }
        if (!text.isNullOrEmpty()) {
            val onwards = Intent(this, MainActivity::class.java).setAction(Intent.ACTION_PROCESS_TEXT).putExtra(Intent.EXTRA_PROCESS_TEXT, text.take(MOST_TEXT))
            startActivity(onwards.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }

    private companion object {
        const val MOST_TEXT = 100_000
    }
}
