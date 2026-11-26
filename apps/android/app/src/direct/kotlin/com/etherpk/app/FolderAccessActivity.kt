package com.etherpk.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * What All files access changes, and the way to Android's own switch for it. Opened by holding the
 * app's icon, and from the app's page in Android's settings. The app never asks for it unprompted.
 */
class FolderAccessActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
    }

    override fun onResume() {
        super.onResume()
        val on = Environment.isExternalStorageManager()
        val text = getString(if (on) R.string.folder_access_on else R.string.folder_access_off)
        val view = NoticeView.notice(this, resources.configuration.isNightModeActive, R.string.folder_access_heading, text, R.string.folder_access_action, ::openSettings)
        ViewCompat.setOnApplyWindowInsetsListener(view) { shown, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            shown.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(view)
    }

    private fun openSettings() {
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, "package:$packageName".toUri()))
        } catch (_: ActivityNotFoundException) {
            // Some devices have only the list of every app.
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
        }
    }
}
