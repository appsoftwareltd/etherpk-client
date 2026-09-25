/**
 * Whether a markdown image target (`![alt](target)`) is something an `<img>` can show.
 *
 * Image syntax over a non-image happens: a Logseq import writes `![Benefit summary.pdf](../assets/…pdf)`
 * for every attachment, and a hand-typed `![doc](https://…/report.pdf)` is an easy slip. Rendering those
 * through the embed gives a broken-image icon and nothing to click, so every consumer of image syntax
 * — the embed, the structural analysis behind it, and the two link augmentations that take over when
 * it is *not* an image — asks this one rule.
 *
 * The rule is by extension, and generous about its absence: a web url with no file extension
 * (`https://picsum.photos/200`, `https://example.com`) is treated as an image, because that is the
 * common shape of a hosted picture, and a `data:` / `blob:` url is always one.
 */

import { isImageExt } from '$lib/storage/fs/asset-store'

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const INLINE_DATA = /^(?:data|blob):/i

/** The path part of `target`: a url's pathname, or a relative reference minus any `?query` / `#hash`. */
function pathOf(target: string): string {
    if (HAS_SCHEME.test(target)) {
        try {
            return new URL(target).pathname
        } catch {
            // Not a parseable url — fall through and read it as a path.
        }
    }
    return target.replace(/[?#].*$/, '')
}

/**
 * Urls an `<img>` can take as its `src` as-is, with no [[Asset Store]] lookup. Anything else is
 * read as an [[Asset Reference]] and resolved to object-url bytes. Asked by both surfaces that
 * render a picture — the editor's embed and the references [[View]] — so a remote image behaves
 * the same in each.
 */
const DIRECT_URL = /^(?:https?|data|blob):/i

export function isDirectImageUrl(target: string): boolean {
    return DIRECT_URL.test(target.trim())
}

/** True when `![…](target)` should render as an image rather than as a link to the file. */
export function isImageTarget(target: string): boolean {
    const raw = target.trim()
    if (INLINE_DATA.test(raw)) return true
    const path = pathOf(raw)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return true // no extension to judge by — a hosted picture, not a document
    return isImageExt(name.slice(dot + 1))
}
