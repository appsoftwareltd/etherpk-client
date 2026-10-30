/**
 * A protected page keeps no [[Bookmark]]s (ADR 0159): a bookmark stores its line's text, and the
 * text of a [[Protected Document]] must not stay in anyone's list. The editor never bookmarks
 * protected text and writes nothing back while a page is protected, but it removes nothing. This
 * module removes them wherever the page was protected: here, on another device, in another tab, or
 * by an agent, which the workspace learns from the search index and from the `protection:changed`
 * event.
 *
 * **Which pages.** The index flags a page `protected` when a cipher fence appears anywhere in its
 * stored text, but a Protected Document is a page whose whole body is one fence, and a person can
 * bookmark a line beside a fence on any other page. So the flag only says which pages to read: each
 * flagged page someone has bookmarked is read, and judged by `documentProtection`, the rule the
 * editor uses. What a page read as is kept until the page changes ({@link ProtectedBookmarkSweeper.forget}),
 * so a bookmark beside a stray fence does not cost a read on every sweep.
 *
 * **Whose bookmarks.** The person's own go through their list, with one notice. On a synced graph
 * every other Member's go too, in the graph ({@link MemberBookmarks}), as a rename moves every
 * Member's lists: each bookmark holds a line of the page's text in the clear.
 *
 * Framework-free and injected, so the workspace only says when to sweep and where the answers
 * come from.
 */
import { type Bookmark, conceptKeyOf } from '$lib/document/bookmarks/bookmarks'
import type { ConceptCandidate } from '$lib/document/index-db'
import { documentProtection } from '$lib/document/protection/cipher-fence'

/** The notice a sweep posts, which the workspace takes down when the graph closes. */
export const PROTECTED_BOOKMARKS_NOTICE_ID = 'protected-bookmarks'

/** Pages to their stored text, null for one that could not be read. */
export type PageTextReader = (pages: readonly string[]) => Promise<ReadonlyMap<string, string | null>>

/**
 * Every identity key the index flags `protected` (a cipher fence somewhere in the stored text), to
 * the name of the page it opens: a page or journal its own name, an alias the page it names. Only
 * these pages can be Protected Documents.
 */
export function fencedPages(candidates: Iterable<Pick<ConceptCandidate, 'display' | 'key' | 'kind' | 'canonical' | 'protected'>>): Map<string, string> {
    const pages = new Map<string, string>()
    for (const candidate of candidates) {
        if (!candidate.protected) continue
        const page = candidate.kind === 'alias' ? candidate.canonical : candidate.display
        if (page !== undefined) pages.set(conceptKeyOf(candidate.key), page)
    }
    return pages
}

/**
 * Stored text on a folder graph, for the sweep: an open document's buffer, which holds a protect
 * before the autosave writes it to the file, else the file.
 */
export function folderDocumentTexts(store: { documentText(target: string): Promise<string | null> }): PageTextReader {
    return async (pages) => {
        const out = new Map<string, string | null>()
        for (const page of pages) out.set(page, await store.documentText(page).catch(() => null))
        return out
    }
}

/** The bookmarks whose page is protected, and each such page's name once, as the first bookmark spells it. */
export function bookmarksOnProtectedPages(
    bookmarks: readonly Bookmark[],
    protectedKeys: ReadonlySet<string>,
): { ids: string[]; concepts: string[] } {
    const ids: string[] = []
    const concepts = new Map<string, string>()
    for (const bookmark of bookmarks) {
        const key = conceptKeyOf(bookmark.concept)
        if (!protectedKeys.has(key)) continue
        ids.push(bookmark.id)
        if (!concepts.has(key)) concepts.set(key, bookmark.concept.trim())
    }
    return { ids, concepts: [...concepts.values()] }
}

/** The one notice for a sweep that removed `count` bookmarks from the pages `concepts` names. */
export function protectedBookmarksNotice(count: number, concepts: readonly string[]): string {
    const what = count === 1 ? 'the bookmark' : `${count} bookmarks`
    const where = concepts.length === 1 ? `"${concepts[0]}"` : `${concepts.length} protected pages`
    return `Removed ${what} from ${where}: a protected page keeps no bookmarks.`
}

/** Every Member's bookmarks on a synced graph (ADR 0159), the person's own among them. */
export interface MemberBookmarks {
    /** The concepts any Member has bookmarked. */
    concepts(): Iterable<string>
    /** Remove every Member's bookmarks whose concept key is one of `conceptKeys`. */
    removeOn(conceptKeys: readonly string[]): void
}

export interface ProtectedBookmarkSweeperDeps {
    /** The pages the index flags now, as {@link fencedPages} gives them. */
    fencedPages: () => ReadonlyMap<string, string>
    /** The stored text of each named page, null for one that could not be read. */
    readTexts: PageTextReader
    /** The person's bookmarks now. */
    bookmarks: () => readonly Bookmark[]
    remove: (ids: readonly string[]) => Promise<void>
    /** Every Member's bookmarks: on a synced graph only. Absent, or null, on a folder graph. */
    everyMember?: () => MemberBookmarks | null
    notify: (text: string) => void
    /** A refused removal (offline, a refusing persist). The next sweep tries again. */
    onError?: (error: Error) => void
    /** How long {@link ProtectedBookmarkSweeper.schedule} gathers requests: an open re-verifies every document. */
    delayMs?: number
}

export interface ProtectedBookmarkSweeper {
    /** Sweep once after the delay, however many times this is called meanwhile. */
    schedule(): void
    /** Sweep now. A call during a sweep makes that sweep run once more, and resolves with it. */
    sweep(): Promise<void>
    /**
     * The stored text of `page` changed, so what it was read as no longer holds. Without a page,
     * every page's: the graph's names moved, or protection changed.
     */
    forget(page?: string): void
    /** Cancel a scheduled sweep, and sweep nothing more. */
    dispose(): void
}

export function createProtectedBookmarkSweeper(deps: ProtectedBookmarkSweeperDeps): ProtectedBookmarkSweeper {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running: Promise<void> | null = null
    let again = false
    let disposed = false
    /** Whether each page, by its key, read as a Protected Document when it was last read. */
    const readAs = new Map<string, boolean>()
    /** Counts every forget, so a read that a change overtook is used once but not kept. */
    let changes = 0

    function onError(error: unknown): void {
        deps.onError?.(error instanceof Error ? error : new Error(String(error)))
    }

    /**
     * The keys, aliases included, of the flagged pages a bookmark is on that read as Protected
     * Documents now. Reads only the pages not read since they last changed.
     */
    async function protectedKeys(fenced: ReadonlyMap<string, string>, bookmarked: Iterable<string>): Promise<Set<string>> {
        // The flagged pages someone has bookmarked, by the page's own key, with the page's name.
        const pages = new Map<string, string>()
        for (const concept of bookmarked) {
            const page = fenced.get(conceptKeyOf(concept))
            if (page !== undefined) pages.set(conceptKeyOf(page), page)
        }
        // What each of them reads as now: as last read while the page has not changed since, else read.
        const verdicts = new Map<string, boolean>()
        const unread: [pageKey: string, page: string][] = []
        for (const [pageKey, page] of pages) {
            const known = readAs.get(pageKey)
            if (known === undefined) unread.push([pageKey, page])
            else verdicts.set(pageKey, known)
        }
        if (unread.length > 0) {
            const before = changes
            const texts = await deps.readTexts(unread.map(([, page]) => page))
            for (const [pageKey, page] of unread) {
                const text = texts.get(page)
                // Not read is not judged: its bookmarks stay, and the next sweep reads it again.
                if (typeof text !== 'string') continue
                const isProtected = documentProtection(text).kind === 'document'
                verdicts.set(pageKey, isProtected)
                // Kept only when nothing changed during the read. A page that changed meanwhile may
                // read differently now: this sweep goes by what it read, and the next reads again.
                if (changes === before) readAs.set(pageKey, isProtected)
            }
        }
        return keysOf(fenced, (pageKey) => verdicts.get(pageKey) === true)
    }

    async function sweepOnce(): Promise<void> {
        const fenced = deps.fencedPages()
        if (fenced.size === 0) return
        const members = deps.everyMember?.() ?? null
        const bookmarked = [...deps.bookmarks().map((b) => b.concept), ...(members ? members.concepts() : [])]
        const keys = await protectedKeys(fenced, bookmarked)
        if (keys.size === 0) return
        // The person's own, through their list, so the Sidebar and the editor follow and the
        // notice can say what went.
        const { ids, concepts } = bookmarksOnProtectedPages(deps.bookmarks(), keys)
        if (ids.length > 0) {
            try {
                await deps.remove(ids)
                deps.notify(protectedBookmarksNotice(ids.length, concepts))
            } catch (error) {
                onError(error)
            }
        }
        // Then every Member's, in the graph. A refusal of the person's own does not keep the
        // others' line text in the clear.
        if (members) {
            try {
                members.removeOn([...keys])
            } catch (error) {
                onError(error)
            }
        }
    }

    function sweep(): Promise<void> {
        if (disposed) return Promise.resolve()
        if (running) {
            again = true
            return running
        }
        running = (async () => {
            do {
                again = false
                try {
                    await sweepOnce()
                } catch (error) {
                    // A read that failed (the store closing under it, say): nothing was judged, so
                    // the bookmarks stay and the next sweep tries again. Never an unhandled rejection
                    // from the timer that started it.
                    onError(error)
                }
            } while (again && !disposed)
        })().finally(() => {
            running = null
        })
        return running
    }

    return {
        schedule() {
            if (disposed || timer) return
            timer = setTimeout(() => {
                timer = undefined
                void sweep()
            }, deps.delayMs ?? 250)
        },
        sweep,
        forget(page) {
            changes += 1
            if (page === undefined) readAs.clear()
            else readAs.delete(conceptKeyOf(page))
        },
        dispose() {
            disposed = true
            if (timer) clearTimeout(timer)
            timer = undefined
        },
    }
}

/** Every flagged key whose page, by the page's own key, `isProtected` answers true for. */
function keysOf(fenced: ReadonlyMap<string, string>, isProtected: (pageKey: string) => boolean): Set<string> {
    const keys = new Set<string>()
    for (const [key, page] of fenced) if (isProtected(conceptKeyOf(page))) keys.add(key)
    return keys
}
