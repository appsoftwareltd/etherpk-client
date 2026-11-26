package com.etherpk.app

import android.content.Context
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** The WebView is a part of the system that updates on its own. This app needs a recent one. */
object WebViewVersion {
    /** Safe areas and the keyboard are right from here, and everything the Client uses is there. */
    const val OLDEST = 144

    /** The package to update, or null when the device's WebView will do. */
    fun problem(context: Context): Problem? {
        val current = WebViewCompat.getCurrentWebViewPackage(context) ?: return Problem(null)
        val features = listOf(WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER, WebViewFeature.DOCUMENT_START_SCRIPT)
        val good = major(current.versionName) >= OLDEST && features.all(WebViewFeature::isFeatureSupported)
        return if (good) null else Problem(current.packageName)
    }

    class Problem(val packageName: String?)

    /** 0 for a version that says nothing. */
    fun major(version: String?): Int = version?.substringBefore('.')?.toIntOrNull() ?: 0
}
