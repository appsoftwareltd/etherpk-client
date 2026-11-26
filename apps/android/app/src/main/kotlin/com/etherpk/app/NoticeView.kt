package com.etherpk.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.net.toUri

/** A plain screen for when there is no page to show: a heading, what it means, and one thing to do. */
object NoticeView {
    fun oldWebView(context: Context, problem: WebViewVersion.Problem, dark: Boolean): View =
        notice(context, dark, R.string.old_webview_heading, context.getString(R.string.old_webview_text), R.string.old_webview_action) {
            openStore(context, problem.packageName ?: "com.google.android.webview")
        }

    fun pageStopped(context: Context, dark: Boolean, again: () -> Unit): View =
        notice(context, dark, R.string.page_stopped_heading, context.getString(R.string.page_stopped_text), R.string.page_stopped_action, again)

    private fun openStore(context: Context, packageName: String) {
        for (address in listOf("market://details?id=$packageName", "https://play.google.com/store/apps/details?id=$packageName")) {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, address.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return
            } catch (_: ActivityNotFoundException) {
                // A device with no store has a browser, or neither.
            }
        }
    }

    fun notice(context: Context, dark: Boolean, heading: Int, text: String, action: Int, act: () -> Unit): View {
        fun dp(value: Int) = (value * context.resources.displayMetrics.density).toInt()
        val (ink, muted, paper) = if (dark) Triple(Color.rgb(0xf5, 0xf5, 0xf5), Color.rgb(0xd4, 0xd4, 0xd4), Color.rgb(0x0f, 0x0f, 0x0f)) else Triple(Color.rgb(0x17, 0x17, 0x17), Color.rgb(0x40, 0x40, 0x40), Color.WHITE)
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
        }
        column.addView(TextView(context).apply {
            setText(heading)
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            isAccessibilityHeading = true
        })
        column.addView(TextView(context).apply {
            this.text = text
            setTextColor(muted)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setPadding(0, dp(12), 0, dp(24))
        })
        column.addView(
            Button(context).apply {
                setText(action)
                isAllCaps = false
                setTextColor(paper)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                background = GradientDrawable().apply { setColor(ink); cornerRadius = dp(8).toFloat() }
                stateListAnimator = null
                minHeight = dp(48)
                setPadding(dp(20), dp(12), dp(20), dp(12))
                setOnClickListener { act() }
            },
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT),
        )
        return ScrollView(context).apply {
            isFillViewport = true
            setBackgroundColor(paper)
            addView(column)
        }
    }
}
