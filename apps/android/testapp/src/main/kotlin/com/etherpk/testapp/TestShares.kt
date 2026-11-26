package com.etherpk.testapp

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** Files another app shares. The last part of an address says how it behaves. */
class TestShares : ContentProvider() {
    override fun onCreate() = true

    override fun getType(uri: Uri): String? = when (uri.lastPathSegment) {
        "throws" -> throw IllegalStateException("made to fail")
        "picture.png" -> "image/png"
        else -> "text/plain"
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor {
        val name = when (uri.lastPathSegment) {
            "throws" -> throw IllegalStateException("made to fail")
            "hostile" -> "../../files/folders.json"
            else -> uri.lastPathSegment
        }
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME)).also { it.newRow().add(name) }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (uri.lastPathSegment == "throws") throw IllegalStateException("made to fail")
        if (uri.lastPathSegment == "missing") throw FileNotFoundException()
        if (uri.lastPathSegment == "endless") return endless()
        val file = File(context!!.cacheDir, "shared-" + uri.lastPathSegment)
        if (uri.lastPathSegment == "picture.png") file.writeBytes(PICTURE) else if (!file.exists()) file.writeText("shared words")
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    private fun endless(): ParcelFileDescriptor {
        val (read, write) = ParcelFileDescriptor.createPipe()
        Thread {
            ParcelFileDescriptor.AutoCloseOutputStream(write).use { out ->
                val block = ByteArray(1024 * 1024)
                try { while (true) out.write(block) } catch (_: java.io.IOException) { /* The reader has had enough. */ }
            }
        }.start()
        return read
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0

    companion object {
        /** One white dot. */
        val PICTURE: ByteArray = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", android.util.Base64.DEFAULT)
    }
}
