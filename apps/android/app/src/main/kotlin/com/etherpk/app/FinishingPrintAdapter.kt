package com.etherpk.app

import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter

/** The page's own print adapter, and word of when the print dialog is done with it. */
class FinishingPrintAdapter(private val page: PrintDocumentAdapter, private val finished: () -> Unit) : PrintDocumentAdapter() {
    override fun onStart() = page.onStart()

    override fun onLayout(before: PrintAttributes?, now: PrintAttributes?, cancel: CancellationSignal?, result: LayoutResultCallback?, extras: Bundle?) =
        page.onLayout(before, now, cancel, result, extras)

    override fun onWrite(pages: Array<out PageRange>?, to: ParcelFileDescriptor?, cancel: CancellationSignal?, result: WriteResultCallback?) =
        page.onWrite(pages, to, cancel, result)

    override fun onFinish() {
        page.onFinish()
        finished()
    }
}
