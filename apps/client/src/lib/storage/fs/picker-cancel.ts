/**
 * A system picker (a folder or a file) that the person closed without choosing rejects with an
 * `AbortError`. That is a choice, not a failure: the caller says nothing and leaves the page as it
 * was. Every other rejection is a failure the caller reports.
 *
 * Read by name rather than `instanceof DOMException`, so an error from another realm (an iframe,
 * a test's stand-in) is told apart the same way.
 */
export function isPickerCancel(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
