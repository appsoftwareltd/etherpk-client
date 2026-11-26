package com.etherpk.app

import android.net.Uri
import com.etherpk.app.auth.SignInBrowser
import com.etherpk.app.files.SaveTarget
import java.util.concurrent.CompletableFuture

/** What the shell's methods need of the activity on the screen. Every call is made on the main thread. */
interface Screen {
    fun pickFolder(): CompletableFuture<Uri?>
    fun createDocument(name: String, type: String): CompletableFuture<SaveTarget>
    fun openExternal(url: String)
    fun print(): CompletableFuture<Unit>
    fun setTheme(dark: Boolean)
    fun closeAnswered(allow: Boolean)
    /** The first item of the clipboard, or null. */
    fun clipboardItem(): android.content.ClipData.Item?
    fun send(message: ByteArray)
    val signInBrowser: SignInBrowser
}
