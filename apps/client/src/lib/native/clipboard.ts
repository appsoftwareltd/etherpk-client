/**
 * The clipboard in the Android app. A WebView refuses a page that reads it, so the shell reads it for
 * the page. Only its text: a picture on the clipboard is added to a note by sharing it.
 */
import { nativePlatform, nativeBridge } from './bridge.js'

/** Whether the page may read the clipboard itself. */
export function pageReadsClipboard(): boolean {
    return nativePlatform() !== 'android'
}

/** The clipboard's text as the shell reads it, or null where the page reads it itself. */
export async function shellClipboardText(): Promise<string | null> {
    const bridge = nativeBridge()
    return bridge && !pageReadsClipboard() ? bridge.call('clipboard.readText', {}) : null
}
