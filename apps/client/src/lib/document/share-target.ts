/**
 * The [[Share Target]] (CONTEXT.md; ADR 0087): text or a link handed to EtherPK by another app
 * through the device's share sheet, becoming a [[Quick Note]] in the graph the user picks.
 *
 * Three pure pieces, all framework-free so the rules are pinned down in the Node tier:
 *
 * - **What the note says.** The share sheet hands over up to three fields and apps fill them
 *   inconsistently (Chrome shares a page as `title` + the url in `text`; YouTube puts
 *   "Title https://…" in `text` alone). {@link composeSharedNote} turns whatever arrived into
 *   one string, a page's title made the link's text, and cuts a runaway `text` to the cap.
 * - **Which graph first.** {@link orderShareTargets}: the last-opened graph first (so the common
 *   case is one tap), the rest in the Graphs page's order, the Demo Graph apart and last.
 * - **The wait.** The share page decides only the graph; the workspace adds the note once the
 *   graph is open (ADR 0087). Between the two the text is a {@link PendingShare} in
 *   `sessionStorage`: it survives the unlock prompt, the permission button and a reload, is
 *   consumed once, and dies with the window - closing it at the unlock prompt discards the
 *   share, as cancelling any share sheet does.
 */

import type { GraphRecord } from '$lib/storage/graph-registry'

import { MARKDOWN_LINK, linkGroups } from './markdown-link-target'
import { MAX_QUICK_NOTE_LENGTH } from './quick-notes'
import { isOpenableUrl } from './view/augmentations/markdown-link-core'

/** What the share sheet hands over, as the manifest's `params` name them. Any field may be missing. */
export interface SharedPayload {
    title?: string | null
    text?: string | null
    url?: string | null
}

export interface ComposedShare {
    /** The note's text, exactly what will be captured. */
    text: string
    /** The `text` field was longer than the cap and was cut; the picker says so. */
    truncated: boolean
}

/** A whole string that is one markdown link and nothing else. */
const WHOLE_LINK = new RegExp(`^${MARKDOWN_LINK}$`)

/**
 * `[title](url)` when the link syntax can carry both exactly, else `null`. Composed and then
 * parsed back with the one shared link grammar, rather than escaping by hand, so an unbalanced
 * `)` in a url cannot read as a different link. A bracket anywhere in the title means no link
 * at all: the grammar's label admits a `[`, but the editor's parser reads `[Notes [draft](…)`
 * as the link "draft" with "[Notes " as prose, and plain lines are the honest fallback.
 */
function markdownLink(title: string, url: string): string | null {
    if (/[[\]\n]/.test(title)) return null
    const candidate = `[${title}](${url})`
    const match = WHOLE_LINK.exec(candidate)
    if (!match) return null
    const groups = linkGroups(match)
    return groups.bang === '' && groups.label === title && groups.target === url ? candidate : null
}

function present(value: string | null | undefined): string | undefined {
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? undefined : trimmed
}

/** The text is the title, or begins with it as a whole word or line: "Note" does not open "Notes from…". */
function beginsWithTitle(text: string | undefined, title: string): boolean {
    if (!text || !text.startsWith(title)) return false
    return text.length === title.length || /\s/.test(text[title.length])
}

/**
 * The first `max` characters, never ending on the high half of a surrogate pair: a cut through
 * an emoji would leave a lone surrogate that a file write turns into U+FFFD.
 */
function cutText(text: string, max: number): string {
    let end = max
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
    return text.slice(0, end)
}

/**
 * The text a share becomes, or `null` when nothing usable arrived. After trimming and dropping
 * empties:
 *
 * - text that is nothing but a web address is the url (how Chrome shares a page), whether or
 *   not the url field says the same;
 * - with a url the text does not already hold: the text (if any) above, then `[title](url)`,
 *   or the bare url without a title;
 * - otherwise: the title (if any) above the text;
 * - a title the text already begins with is not said twice;
 * - only an address the editor would open becomes a link; anything else is plain text.
 *
 * The cut applies to the `text` field before composition, so the title and link survive it.
 */
export function composeSharedNote(payload: SharedPayload): ComposedShare | null {
    const title = present(payload.title)
    let text = present(payload.text)
    let url = present(payload.url)
    if (text && isOpenableUrl(text) && (!url || url === text)) {
        url = text
        text = undefined
    }
    let truncated = false
    if (text && text.length > MAX_QUICK_NOTE_LENGTH) {
        text = `${cutText(text, MAX_QUICK_NOTE_LENGTH)}…`
        truncated = true
    }

    const heading = title && !beginsWithTitle(text, title) ? title : undefined
    const lines: string[] = []
    if (url && !text?.includes(url)) {
        // The url closes the note: as a link carrying the title when the editor would open it
        // and the syntax can hold both, and as plain lines (the title, then the address as
        // words) when not.
        if (text) lines.push(text)
        const link = heading && isOpenableUrl(url) ? markdownLink(heading, url) : null
        if (link) lines.push(link)
        else lines.push(...(heading ? [heading] : []), url)
    } else {
        // No url, or one the text already holds: the title above the text.
        if (heading) lines.push(heading)
        if (text) lines.push(text)
    }
    if (lines.length === 0) return null
    return { text: lines.join('\n'), truncated }
}

export interface ShareTargetOrder {
    /** The device-local last-opened pointer (last-graph.ts), or null. */
    lastGraphId: string | null
    isDemo: (graphId: string) => boolean
}

/**
 * The picker's order: the last-opened graph first and focused, the rest in the order given
 * (the registry's, which is the Graphs page's, so the two cannot drift), the Demo Graph last
 * whatever its place - a throwaway never sits above real work (ADR 0069), even when it was the
 * last thing opened.
 */
export function orderShareTargets(graphs: readonly GraphRecord[], order: ShareTargetOrder): GraphRecord[] {
    const ordinary = graphs.filter((g) => !order.isDemo(g.id))
    const demo = graphs.filter((g) => order.isDemo(g.id))
    const last = ordinary.find((g) => g.id === order.lastGraphId)
    return [...(last ? [last] : []), ...ordinary.filter((g) => g !== last), ...demo]
}

/** The share between the picker and the add. */
export interface PendingShare {
    /** The graph the user chose; only that graph's workspace takes it. */
    graphId: string
    /** The composed note text. */
    text: string
    /** The instant the text was shared, epoch ms - the note's `createdAt`, however long it waits. */
    createdAt: number
    /** Whether the text was cut, so the picker can say so again if it has to be shown again. */
    truncated: boolean
}

const PENDING_SHARE_KEY = 'etherpk-pending-share'

/** `sessionStorage`, or null when unavailable (SSR, a browser with storage disabled). */
function sessionStorageOrNull(): Storage | null {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage
    } catch {
        return null
    }
}

function readPendingShare(storage: Storage | null): PendingShare | null {
    try {
        const raw = storage?.getItem(PENDING_SHARE_KEY)
        if (!raw) return null
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return null
        const { graphId, text, createdAt, truncated } = parsed as Record<string, unknown>
        if (typeof graphId !== 'string' || graphId === '') return null
        if (typeof text !== 'string' || text.trim() === '') return null
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
        return { graphId, text, createdAt, truncated: truncated === true }
    } catch {
        return null
    }
}

/** Hold the share for the chosen graph's workspace. A share already waiting is replaced. */
export function stashPendingShare(share: PendingShare, storage: Storage | null = sessionStorageOrNull()): void {
    try {
        storage?.setItem(PENDING_SHARE_KEY, JSON.stringify(share))
    } catch {
        // Storage full or disabled: the workspace then finds nothing, and the picker's own
        // failure copy is what the user sees.
    }
}

/** The share waiting, whichever graph it is for, without consuming it: the picker re-showing it. */
export function peekPendingShare(storage: Storage | null = sessionStorageOrNull()): PendingShare | null {
    return readPendingShare(storage)
}

/** Consume the share waiting for `graphId`, if that is the one waiting. Another graph's stays. */
export function takePendingShare(graphId: string, storage: Storage | null = sessionStorageOrNull()): PendingShare | null {
    const share = readPendingShare(storage)
    if (!share || share.graphId !== graphId) return null
    clearPendingShare(storage)
    return share
}

export function clearPendingShare(storage: Storage | null = sessionStorageOrNull()): void {
    try {
        storage?.removeItem(PENDING_SHARE_KEY)
    } catch {
        // Nothing to do: a value that cannot be removed could not have been written either.
    }
}
