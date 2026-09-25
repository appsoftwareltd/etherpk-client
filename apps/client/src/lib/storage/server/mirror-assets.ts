/**
 * What each document says its [[Asset]]s are called (ADR 0008, ADR 0027).
 *
 * This decides **names only**, never what exists. A synced graph's assets live encrypted under
 * random ids, and the same asset can be referenced under several stems, because a stem is
 * whatever name that particular reference was pasted with. So a link only resolves when the
 * folder holds a file called what the markdown says, which is what this is for.
 *
 * It deliberately does NOT decide what to download or delete. It once did, and a
 * [[Protected Document]]'s body is ciphertext in a fence, so an attachment used only there was
 * invisible: never downloaded, and deleted from the folder as a stray. Anything the scan failed
 * to see, it removed. The mirror now asks the server which assets the graph holds and reconciles
 * against that, so a name this misses costs a link, never a file.
 *
 * The scan is generous for the same reason it always was: over-including a name asks for one
 * extra copy of bytes already present, which is the harmless direction.
 *
 * Pure: strings and sets.
 */

import { linkTargetPattern } from '$lib/document/markdown-link-target'

/**
 * An asset path inside document text: any number of `../` hops, `assets/`, then the file name up
 * to whatever ends a markdown link, an HTML attribute or a line.
 *
 * The name shares the link-destination grammar, so a parenthesis in a file name does not cut it
 * short, and adds the characters an HTML attribute and markdown brackets cannot hold.
 */
const ASSET_PATH = new RegExp(String.raw`(?:\.\.\/)*assets\/(${linkTargetPattern(String.raw`"'<>\]`)})`, 'g')

/** Every asset file name referenced by a document's text, in first-seen order. */
export function referencedAssetNames(text: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const match of text.matchAll(ASSET_PATH)) {
        // A reference can carry a query or fragment, and can be percent-encoded: the name on
        // disk is neither. A malformed escape is left as written rather than throwing.
        const raw = match[1].split(/[?#]/)[0]
        let name: string
        try {
            name = decodeURIComponent(raw)
        } catch {
            name = raw
        }
        if (name === '' || name.includes('/') || seen.has(name)) continue
        seen.add(name)
        out.push(name)
    }
    return out
}
