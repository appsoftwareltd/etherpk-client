/**
 * A link to a place in an EBook (`../assets/garden-notes.1a2b3c4d.epub#cfi=epubcfi%28…%29`), and asking a
 * tab to go there. The tab is keyed by the Asset alone, so one Asset is one tab however its links are
 * written, and the place travels beside it: the tab reads the request when it opens, or at once if it
 * is open already. A CFI holds parentheses and `!`, which a markdown link and a fragment both trip on,
 * so it is percent-encoded in full.
 */
import { isEbookCfi } from './ebook-state'

const requests = new Map<string, string>()
const listeners = new Set<() => void>()

/** `#cfi=…` out of a reference's fragment, or null when it holds no place in an EBook. */
export function cfiFromReference(ref: string): string | null {
    const encoded = /#(?:.*&)?cfi=([^&]+)/.exec(ref)?.[1]
    if (encoded === undefined) return null
    try {
        const cfi = decodeURIComponent(encoded)
        return isEbookCfi(cfi) ? cfi : null
    } catch {
        return null
    }
}

/**
 * Words from an EBook, made safe to go into a Document. A title, a chapter's name or a passage can hold
 * markdown, and an image in it would load from wherever it points when the page is opened, so an EBook could
 * learn who read it. It stays readable, and only stops being an image.
 */
export function plainEbookText(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/!\[/g, '! [').trim()
}

/** The fragment of a link to a place in an EBook, with nothing a markdown link trips on. */
export function ebookPlaceFragment(cfi: string): string {
    return `#cfi=${encodeURIComponent(cfi).replace(/[()!']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

/** The markdown link to a place in an EBook. */
export function ebookLinkMarkdown(label: string, ref: string, cfi: string): string {
    const safe = label.replace(/[[\]]/g, '').trim() || 'EBook'
    return `[${safe}](${ref}${ebookPlaceFragment(cfi)})`
}

/** A highlight or note quoted into the journal, with a link back to its passage. */
export function ebookQuoteMarkdown(quote: string, note: string | undefined, label: string, ref: string, cfi: string): string {
    const text = plainEbookText(quote)
    const link = ebookLinkMarkdown(label, ref, cfi)
    const first = text === '' ? `- ${link}\n` : `- ${text} ${link}\n`
    return note ? `${first}  - ${plainEbookText(note)}\n` : first
}

export function requestEbookPlace(target: string, cfi: string): void {
    requests.set(target, cfi)
    for (const listener of listeners) listener()
}

/** Take the request for this tab, if there is one. Answered once. */
export function requestedEbookPlace(target: string): string | null {
    const cfi = requests.get(target)
    if (cfi === undefined) return null
    requests.delete(target)
    return cfi
}

export function subscribeEbookPlaceRequests(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
