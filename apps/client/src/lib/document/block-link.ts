/**
 * A link to one [[Block]] (a [[Block View]]'s address, ADR 0209): the [[Document URL]] of the
 * Block's document with `#block=<line>-<fingerprint>` as its fragment, as a [[Task Reference]]
 * carries `#task=`. A Block has no identity of its own (ADR 0016) and nothing is written into the
 * document, so the link names it by where it was and what it said, and is resolved back to it from
 * those.
 *
 * The line is 0-based and counted from the start of the body, below any frontmatter, as the
 * [[Derived Index]] counts lines. The fingerprint is two halves of six hex characters: the first 24
 * bits of the SHA-256 of the Block's own words, then of its parent bullet's words (empty for a
 * Block with no parent bullet). Its own words tell a Block from its neighbours, and its parent's
 * tell apart the bullets a journal repeats under many tasks ("Comments"). Two halves rather than
 * one hash of both, so a link still finds its Block after either the Block's words or its parent's
 * have been edited (see {@link findBlock}).
 *
 * Framework-free: the Client resolves a link here, and the Headless Client could with the same code.
 */
import { referencedGraphPath, type GraphAddress } from '../navigation/graph-address'
import { encodeConceptPath } from '../navigation/concept-path'
import { fencedBlocks } from './fenced-code'
import { bulletContent, isBulletLine, opaqueLineFlags, parentIndex, taskDone } from './outliner'
import { taskWords } from './task-reference'

/** The hex characters of each half of a fingerprint. */
const HALF = 6

/** A link to a Block: its document, its 0-based body line, and its fingerprint. */
export interface BlockLink {
    document: string
    line: number
    fingerprint: string
}

/**
 * The words that identify a bullet: its text after the marker, whitespace collapsed and Unicode NFC
 * applied. A [[Task]]'s are its words without its checkbox and [[Task Tag]]s, so ticking it or
 * changing its priority leaves its links working.
 */
export function blockWords(line: string): string {
    return labelWords(bulletContent(line), taskDone(line) !== undefined)
}

/** The words of a bullet's label (its text after the marker and any checkbox). */
function labelWords(label: string, task: boolean): string {
    if (task) return taskWords(label)
    return label.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The first {@link HALF} hex characters of the SHA-256 of `words`. */
async function half(words: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(words))
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, HALF)
}

/**
 * The fingerprint of the bullet on 0-based `index` of `lines` (a document's body), or null when the
 * line is not a bullet or sits inside a fenced code block.
 */
export async function blockFingerprintAt(lines: readonly string[], index: number): Promise<string | null> {
    const prints = await fingerprintsOf(lines, [index])
    return prints.get(index) ?? null
}

/** The fingerprint of a bullet line under `parent`, its parent bullet's line (null for none). */
export async function blockFingerprintOf(line: string, parent: string | null): Promise<string> {
    return (await half(blockWords(line))) + (await half(parent === null ? '' : blockWords(parent)))
}

/** Each bullet's two halves: its own words' and its parent's. */
interface Halves {
    own: string
    parent: string
}

/**
 * The halves of every bullet of `lines` outside a fenced block, or of those on `only` when given.
 * Each distinct text is hashed once.
 */
async function halvesOf(lines: readonly string[], only?: readonly number[]): Promise<Map<number, Halves>> {
    const mutable = [...lines]
    const blocks = fencedBlocks(mutable)
    const opaque = opaqueLineFlags(mutable, blocks)
    const hashes = new Map<string, Promise<string>>()
    const hash = (words: string) => {
        let pending = hashes.get(words)
        if (!pending) hashes.set(words, (pending = half(words)))
        return pending
    }
    const out = new Map<number, Halves>()
    const indices = only ?? lines.map((_line, i) => i)
    for (const i of indices) {
        if (i < 0 || i >= lines.length || opaque[i] || !isBulletLine(lines[i])) continue
        const parent = parentIndex(mutable, i, blocks)
        out.set(i, { own: await hash(blockWords(lines[i])), parent: await hash(parent === null ? '' : blockWords(lines[parent])) })
    }
    return out
}

async function fingerprintsOf(lines: readonly string[], only?: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    for (const [i, { own, parent }] of await halvesOf(lines, only)) out.set(i, own + parent)
    return out
}

/** How a Block was found: at the line its link names, or elsewhere in its document or another. */
export type BlockFoundBy = 'at_line' | 'moved' | 'other_document'

/** The line nearest `line` of `candidates`, the earlier one on a tie; null when there are none. */
function nearest(candidates: readonly number[], line: number): number | null {
    let best: number | null = null
    for (const candidate of candidates) {
        if (best === null || Math.abs(candidate - line) < Math.abs(best - line)) best = candidate
    }
    return best
}

/**
 * The Block a link names in one document's body, in this order:
 *
 * 1. The bullet with the same words and the same parent, nearest the line: where nothing changed,
 *    or lines were added above it, or the Block moved within its document.
 * 2. The bullet with the same words, nearest the line: its parent was edited, or it moved under
 *    another parent.
 * 3. The bullet on the line itself with the same parent: its own words were edited, and nothing
 *    moved it. Only on the line, since a parent's words say little about which child is meant.
 *
 * Null when none of these finds it: it was deleted, or both it and where it was have changed.
 */
export async function findBlock(lines: readonly string[], line: number, fingerprint: string): Promise<{ line: number; foundBy: 'at_line' | 'moved' } | null> {
    const own = fingerprint.slice(0, HALF)
    const parent = fingerprint.slice(HALF)
    const halves = await halvesOf(lines)
    const both: number[] = []
    const ownOnly: number[] = []
    for (const [i, found] of halves) {
        if (found.own !== own) continue
        if (found.parent === parent) both.push(i)
        else ownOnly.push(i)
    }
    const at = nearest(both, line) ?? nearest(ownOnly, line) ?? (halves.get(line)?.parent === parent ? line : null)
    return at === null ? null : { line: at, foundBy: at === line ? 'at_line' : 'moved' }
}

export interface ResolvedBlockLink {
    ok: true
    /** The document's name now. */
    document: string
    /** The Block's 0-based body line now. */
    line: number
    foundBy: BlockFoundBy
}

export type BlockLinkRefusal = { ok: false; code: 'block_not_found' } | { ok: false; code: 'block_ambiguous' }

/** What resolving needs from wherever the graph is. */
export interface BlockLinkSources {
    /** The name a document answers to now, through its aliases and whatever the case, or null. */
    resolveDocument(name: string): string | null
    /** A document's body, the text below any frontmatter, or null when it cannot be read. */
    readBody(document: string): Promise<string | null>
    /** Every bullet the index knows, by document, body line and label: where else to look. */
    allBullets(): Promise<readonly { document: string; line: number; label: string }[]>
}

/**
 * Find the Block a link names: in its own document first ({@link findBlock}), then in the one other
 * document that holds a bullet with its words, where it was cut and pasted. Several such documents
 * is `block_ambiguous`, since opening a guess would show the wrong Block.
 */
export async function resolveBlockLink(link: BlockLink, sources: BlockLinkSources): Promise<ResolvedBlockLink | BlockLinkRefusal> {
    const named = sources.resolveDocument(link.document)
    const here = named === null ? null : await inDocument(link, named, sources)
    if (here) return here
    const found = await inOtherDocuments(link, named, sources)
    // A match on both halves outranks one on the Block's words alone.
    const best = found.some((match) => match.both) ? found.filter((match) => match.both) : found
    if (best.length === 1) return { ok: true, document: best[0].document, line: best[0].line, foundBy: 'other_document' }
    return { ok: false, code: best.length > 1 ? 'block_ambiguous' : 'block_not_found' }
}

/** The Block in `document`, the one its link names, or null. */
async function inDocument(link: BlockLink, document: string, sources: BlockLinkSources): Promise<ResolvedBlockLink | null> {
    const body = await sources.readBody(document)
    const found = body === null ? null : await findBlock(body.split('\n'), link.line, link.fingerprint)
    return found ? { ok: true, document, ...found } : null
}

/**
 * Every bullet with the Block's own words in a document other than `named`, and whether its parent's
 * words match too. The index says where to look, and can be a moment behind the text, so each
 * document is read to confirm.
 */
async function inOtherDocuments(link: BlockLink, named: string | null, sources: BlockLinkSources): Promise<{ document: string; line: number; both: boolean }[]> {
    const own = link.fingerprint.slice(0, HALF)
    const parent = link.fingerprint.slice(HALF)
    const looked = new Set<string>(named === null ? [] : [named.toLowerCase()])
    const found: { document: string; line: number; both: boolean }[] = []
    for (const bullet of await sources.allBullets()) {
        if (looked.has(bullet.document.toLowerCase()) || !(await labelMatches(bullet.label, own))) continue
        looked.add(bullet.document.toLowerCase())
        const body = await sources.readBody(bullet.document)
        if (body === null) continue
        for (const [line, halves] of await halvesOf(body.split('\n'))) {
            if (halves.own === own) found.push({ document: bullet.document, line, both: halves.parent === parent })
        }
    }
    return found
}

/** Whether an index label has a Block's own words: either reading, since the index keeps no task flag. */
async function labelMatches(label: string, own: string): Promise<boolean> {
    return (await half(labelWords(label, false))) === own || (await half(labelWords(label, true))) === own
}

/** The fragment that names a Block in a Document URL, without its `#`. */
export function blockFragment(line: number, fingerprint: string): string {
    return `block=${line}-${fingerprint}`
}

/** A Block's address in the Client at `origin` (none for a path alone). */
export function blockLinkUrl(graph: GraphAddress, link: BlockLink, origin = ''): string {
    return `${origin}${referencedGraphPath(graph)}/d/${encodeConceptPath(link.document)}#${blockFragment(link.line, link.fingerprint)}`
}

const BLOCK_LINK = /\/d\/([^?#\s]+?)(?:\?[^#\s]*)?#block=(\d+)-([0-9a-f]{12})(?![0-9a-f])/

/** The link in `input`, a Block's address with any origin or none; null when it holds none. */
export function parseBlockLink(input: string): BlockLink | null {
    const match = BLOCK_LINK.exec(input)
    if (!match) return null
    const [, path, line, fingerprint] = match
    try {
        return { document: path.split('/').map(decodeURIComponent).join('/'), line: Number(line), fingerprint }
    } catch {
        // A malformed escape: no address EtherPK wrote.
        return null
    }
}
