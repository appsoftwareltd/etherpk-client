/**
 * A link asked to open a PDF at a page (`../assets/garden-guide.pdf#page=12`). The tab is keyed by
 * the Asset alone, so one Asset is one tab however its links are written (ADR 0054's identity
 * rule), and the page travels beside it: the tab reads the request when it opens, or at once if it
 * is open already.
 */
const requests = new Map<string, number>()
const listeners = new Set<() => void>()

/** `#page=12` out of a reference's fragment, or null. */
export function pageFromReference(ref: string): number | null {
    const page = /#(?:.*&)?page=(\d+)/.exec(ref)?.[1]
    if (page === undefined) return null
    const number = Number.parseInt(page, 10)
    return number >= 1 ? number : null
}

/** A reference with its query and fragment off. */
export function withoutFragment(ref: string): string {
    return ref.split(/[?#]/)[0]
}

export function requestPdfPage(target: string, page: number): void {
    requests.set(target, page)
    for (const listener of listeners) listener()
}

/** Take the request for this tab, if there is one. Answered once. */
export function requestedPdfPage(target: string): number | null {
    const page = requests.get(target)
    if (page === undefined) return null
    requests.delete(target)
    return page
}

/** The reference a person clicked to open a PDF: the Document, and the 1-based line it was on. */
export interface PdfOpenedFrom {
    concept: string
    line: number
}

const openedFrom = new Map<string, PdfOpenedFrom>()

/** Say which reference opened this tab. It travels the same way as a page, for the same reason. */
export function notePdfOpenedFrom(target: string, from: PdfOpenedFrom): void {
    openedFrom.set(target, from)
    for (const listener of listeners) listener()
}

/** Take the reference for this tab, if a new one was clicked. Answered once. */
export function takePdfOpenedFrom(target: string): PdfOpenedFrom | null {
    const from = openedFrom.get(target) ?? null
    openedFrom.delete(target)
    return from
}

export function subscribePdfPageRequests(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}
