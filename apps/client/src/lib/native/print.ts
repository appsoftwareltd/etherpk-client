/**
 * Printing through the shell, in an app whose page cannot open the print dialog itself (a WebView has
 * no `window.print`). The shell prints the page as it stands and answers once the dialog is over.
 */
import { hasNativeFeature, nativeBridge } from './bridge.js'

/** Print the page. Null where the page prints for itself. `limitMs` is for a shell that never answers. */
export function shellPrint(limitMs: number): Promise<'printed' | 'unknown'> | null {
    const bridge = nativeBridge()
    if (!bridge || !hasNativeFeature('print')) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'unknown'>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), limitMs)
    })
    const printed = bridge.call('shell.print', {}).then(() => 'printed' as const)
    return Promise.race([printed, late]).finally(() => clearTimeout(timer))
}
