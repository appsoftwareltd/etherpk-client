/**
 * The address and policies of the page an EBook reads in (ADR 0181). Two documents, one inside the other:
 *
 * - **The host**, at {@link EBOOK_FRAME_PATH} on the app's own origin, holds no script and no EBook. It is
 *   there to give the reader below a policy of its own, because a document takes its policy from the
 *   document that frames it, and the app's would refuse it.
 * - **The reader**, a `data:` document inside the host, has an opaque origin: no storage, no cookies, no
 *   way into the app. It holds foliate-js and the EBook. A `sandbox` would make the origin opaque too, but
 *   sandbox flags pass down to every frame inside, each with an origin of its own, and foliate has to
 *   read the document in each section's frame. A `data:` document has no flags to pass down, so the
 *   frames it makes share its origin.
 *
 * The policy allows one script, the bundle, and no network. Each section's frame inherits it, so an EBook's
 * own scripts are refused, and nothing in an EBook can report who is reading.
 */
export const EBOOK_FRAME_PATH = '/__etherpk-ebook/reader.html'

const READER_DIRECTIVES = (scriptHash: string) => [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    'img-src blob: data:',
    // An EBook's stylesheets are blobs, and its `style` attributes are its own layout.
    "style-src blob: 'unsafe-inline'",
    'font-src blob: data:',
    'media-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
]

/** The host's policy, in its response. The reader inherits it. */
export function ebookHostPolicy(scriptHash: string): string {
    return [
        ...READER_DIRECTIVES(scriptHash),
        'frame-src data: blob:',
        // Only the app can frame it, so only the app can hand it an EBook or read what it reports.
        "frame-ancestors 'self'",
    ].join('; ')
}

/** The reader's own policy, in a `meta` tag, so it holds in a browser that does not pass the host's down. */
export function ebookReaderPolicy(scriptHash: string): string {
    return [...READER_DIRECTIVES(scriptHash), 'frame-src blob:'].join('; ')
}
