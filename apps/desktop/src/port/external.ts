/** Addresses another program may be asked to open: the web, mail and the telephone. Never a file or a program's own scheme. */
const OPENABLE = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * The address, normalised, or null for one that is not opened. A mail address goes without its
 * query: some mail programs take `attach=` with a path on the computer, and the page has no business
 * attaching a file to a message.
 */
export function openableUrl(url: string): string | null {
    if (!URL.canParse(url)) return null
    const parsed = new URL(url)
    if (!OPENABLE.has(parsed.protocol)) return null
    if (parsed.protocol === 'mailto:') {
        parsed.search = ''
        parsed.hash = ''
    }
    return parsed.href
}
