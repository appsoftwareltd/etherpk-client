/**
 * The [[Block View]] (ADR 0209) as the workspace knows it: the View kind, how its target names a
 * Block, where its Block was last seen, and how a Block View is opened.
 *
 * A View is keyed by its target for its life (the dockview panel, the saved Layout, Back and
 * Forward), so the target is the block link (`block-link.ts`) the View was opened with and never changes. The
 * Block's words and place do change, so the View notes where the Block is now ({@link noteBlockSeen})
 * and that is what the address bar shows and what a reload resolves, falling back to the target.
 * The note is kept on the device, as the Layout is.
 */
import { getActiveLayoutController, type ViewRef } from '#lib/layout/index.js'

import { frontmatterSpan } from '#lib/storage/fs/frontmatter-span.js'
import { currentWorkspaceServices } from '#lib/workspace/workspace-services.js'

import { type GraphAddress } from '../navigation/graph-address'
import { type BlockLink, blockFingerprintAt, blockLinkUrl, parseBlockLink } from './block-link'
import { openConceptAtLine, openViewInPaneOf } from './open-concept'

/** The View kind of a Block View. */
export const BLOCK_VIEW_KIND = 'block'

/** What a Block View's tab title opens with, ahead of the Block's words. */
export const BLOCK_VIEW_TITLE_PREFIX = 'Block: '

/** A Block View's target: the link it was opened with, as `[document, line, fingerprint]`. */
export function blockViewTarget(link: BlockLink): string {
    return JSON.stringify([link.document, link.line, link.fingerprint])
}

/** The link a Block View's target names, or null for a target that names none. */
export function parseBlockViewTarget(target: string): BlockLink | null {
    try {
        const value: unknown = JSON.parse(target)
        if (!Array.isArray(value) || value.length !== 3) return null
        const [document, line, fingerprint] = value as unknown[]
        if (typeof document !== 'string' || document === '' || !Number.isInteger(line) || (line as number) < 0) return null
        if (typeof fingerprint !== 'string' || !/^[0-9a-f]{12}$/.test(fingerprint)) return null
        return { document, line: line as number, fingerprint }
    } catch {
        return null
    }
}

/** Where a Block View last saw its Block, and the title it gave its tab. */
export interface BlockSeen extends BlockLink {
    title: string
}

/** The part of `Storage` the note uses. */
export type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>

const SEEN_KEY = 'etherpk:block-views'
/** Most Block Views remembered; the least recently seen go first. */
const SEEN_LIMIT = 200

type SeenEntries = Record<string, BlockSeen & { at: number }>

function defaultStorage(): SeenStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
        return null
    }
}

function readSeen(storage: SeenStorage | null): SeenEntries {
    try {
        const raw = storage?.getItem(SEEN_KEY)
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SeenEntries) : {}
    } catch {
        // Unreadable or not allowed: nothing remembered, and the target is used as it is.
        return {}
    }
}

/** Where the Block View with `target` last saw its Block, or null when it has noted nothing. */
export function blockSeen(target: string, storage: SeenStorage | null = defaultStorage()): BlockSeen | null {
    const entry = readSeen(storage)[target]
    if (!entry || typeof entry.document !== 'string' || !Number.isInteger(entry.line) || typeof entry.fingerprint !== 'string') return null
    return { document: entry.document, line: entry.line, fingerprint: entry.fingerprint, title: typeof entry.title === 'string' ? entry.title : '' }
}

/** Note where the Block View with `target` sees its Block now. */
export function noteBlockSeen(target: string, seen: BlockSeen, storage: SeenStorage | null = defaultStorage(), now = Date.now()): void {
    const entries = readSeen(storage)
    entries[target] = { ...seen, at: now }
    const kept = Object.entries(entries)
        .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, SEEN_LIMIT)
    try {
        storage?.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(kept)))
    } catch {
        // Storage full or not allowed: the address and a reload fall back to the target.
    }
}

/** The link a Block View's address names now: where it last saw its Block, or its target. */
export function currentBlockLink(target: string): BlockLink | null {
    const seen = blockSeen(target)
    if (seen) return { document: seen.document, line: seen.line, fingerprint: seen.fingerprint }
    return parseBlockViewTarget(target)
}

/** The address of a Block View in `graph`, or null for a target that names no Block. */
export function blockViewUrl(graph: GraphAddress, view: ViewRef): string | null {
    const link = currentBlockLink(view.target)
    return link ? blockLinkUrl(graph, link) : null
}

/** What an open Block View answers for its tab's menu, its printing and those opening a Block. */
export interface LiveBlockView {
    /** Where its Block is now, or null while it has none. */
    where(): { document: string; line: number } | null
    /** Its Block and everything nested under it, and the words its title shows, or null while it has none. */
    printable(): { document: string; title: string; markdown: string } | null
    /** Open the find box over its Block. */
    find(): void
}

/** The document a Block View shows: where it last saw its Block, or its target's. Null for any other View. */
export function blockViewDocument(view: ViewRef): string | null {
    if (view.kind !== BLOCK_VIEW_KIND) return null
    return blockSeen(view.target)?.document ?? parseBlockViewTarget(view.target)?.document ?? null
}

/** The Block View an address names, its document by the name `canonical` gives it; null for an address with no Block. */
export function blockViewAt(address: string, canonical: (name: string) => string): ViewRef | null {
    const link = parseBlockLink(address)
    return link ? { kind: BLOCK_VIEW_KIND, target: blockViewTarget({ ...link, document: canonical(link.document) }) } : null
}

/** The open Block Views, by target. */
const live = new Map<string, LiveBlockView>()

/** Make an open Block View known to openers, its tab's menu and printing. Returns how to stop. */
export function registerLiveBlockView(target: string, handle: LiveBlockView): () => void {
    live.set(target, handle)
    return () => {
        if (live.get(target) === handle) live.delete(target)
    }
}

/** The open Block View with `target`, if one is open. */
export function liveBlockView(target: string): LiveBlockView | undefined {
    return live.get(target)
}

/**
 * The link to the bullet on 0-based `bodyLine` of a document whose body is `body`, or null when that
 * line is not a bullet.
 */
export async function blockLinkAt(document: string, body: readonly string[], bodyLine: number): Promise<BlockLink | null> {
    const fingerprint = await blockFingerprintAt(body, bodyLine)
    return fingerprint === null ? null : { document, line: bodyLine, fingerprint }
}

/**
 * Open the Block a link names in a Block View, in the Pane holding `sourcePanelId`. A Block View
 * already showing that Block is brought forward instead: the one whose Block is on the link's line
 * of the same document now, or the one opened with this very link.
 */
export function openBlockView(link: BlockLink, sourcePanelId?: string): boolean {
    const key = link.document.toLowerCase()
    for (const [target, handle] of live) {
        const now = handle.where()
        if (now && now.document.toLowerCase() === key && now.line === link.line) {
            try {
                getActiveLayoutController().openView({ kind: BLOCK_VIEW_KIND, target })
                return true
            } catch {
                return false
            }
        }
    }
    return openViewInPaneOf({ kind: BLOCK_VIEW_KIND, target: blockViewTarget(link) }, sourcePanelId)
}

/**
 * Open the bullet on 0-based body line `bodyLine` of `document` in a Block View, in the Pane holding
 * `sourcePanelId`: the [[Task Editor]]'s **Open in tab** shows its task this way. A line that is not
 * a bullet, or a document that cannot be read, opens the document at the line instead.
 */
export async function openBlockAtLine(document: string, bodyLine: number, sourcePanelId?: string): Promise<void> {
    const store = currentWorkspaceServices()?.store
    let link: BlockLink | null = null
    try {
        await store?.whenReady?.(document)
        const text = store?.open(document).getText() ?? ''
        const span = frontmatterSpan(text)
        link = await blockLinkAt(document, (span ? text.slice(span.end) : text).split('\n'), bodyLine)
    } catch (error) {
        console.warn('[block-view] could not read', document, error)
    }
    if (link) openBlockView(link, sourcePanelId)
    else openConceptAtLine(document, bodyLine, sourcePanelId)
}
