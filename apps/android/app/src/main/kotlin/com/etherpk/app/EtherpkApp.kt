package com.etherpk.app

import android.app.Application
import android.webkit.WebView

class EtherpkApp : Application() {
    /** Created with the first activity: a process started for something else needs none of it. */
    val shell: Shell by lazy { Shell(this) }

    override fun onCreate() {
        super.onCreate()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }
}
