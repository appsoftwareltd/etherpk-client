/**
 * The `etherpk-cipher` fence as it appears in document *text* — finding one, reading what it holds
 * without the key, and producing the edits that write one.
 *
 * Nothing here decrypts. Every function is pure string and byte work over document lines, so the
 * editor, the storage layer, the index guard and the import converter can all ask the same
 * questions of the same source without holding a Protection Key between them.
 *
 * Fence pairing is delegated to {@link fencedBlocks} — the column-scoped rules every other fence
 * in the app already obeys (ADR 0018, ADR 0020). A cipher fence is not a second notion of "in a
 * block": an unterminated one is invisible here exactly as it is everywhere else.
 */
import {
    protectedEnvelopeFingerprint,
    protectedEnvelopeWrittenAt,
    resolveLastWriteWins,
    unarmourProtected,
} from '$lib/crypto'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { fenceLineInfo, fencedBlocks } from '../fenced-code'
import { CIPHER_FENCE_INFO } from './fence-info'

export { CIPHER_FENCE_INFO }

const DEFAULT_TICKS = '```'

export interface CipherFence {
    /** 0-based line index of the opening fence. */
    start: number
    /** 0-based line index of the closing fence. */
    end: number
    /**
     * Character offset of the opening fence's first character, and just past the closing fence's
     * last. Carried here so the editor's read-only guard, the widget placement and the service's
     * classification all measure the same way - two offset computations over one fence is how a
     * guard silently starts guarding the wrong range.
     */
    from: number
    to: number
    /** The column the fence and its body are clamped to. */
    fenceColumn: number
    /** Every envelope the body holds — more than one after two offline rewrites merged. */
    envelopes: Uint8Array[]
    /** The last-write-wins survivor, or null when the body holds nothing readable. */
    winner: Uint8Array | null
    /** The winner's Protection Key fingerprint — whose key this needs. */
    fingerprint: Uint8Array | null
    /** The winner's write timestamp. */
    writtenAt: number | null
    /**
     * The body holds losing envelopes that a key holder should collapse away. ADR 0028 discards
     * them; ADR 0059 records that under projected editing the loser can be your own work.
     */
    needsCollapse: boolean
}

/** Every complete cipher fence in `lines`, in document order. */
export function cipherFences(lines: readonly string[]): CipherFence[] {
    const out: CipherFence[] = []
    // Offset of each line's first character, so a line index becomes a character offset.
    const lineStarts: number[] = [0]
    for (let i = 0; i < lines.length; i++) lineStarts.push(lineStarts[i] + lines[i].length + 1)

    for (const block of fencedBlocks(lines)) {
        const opener = fenceLineInfo(lines[block.start])
        if (!opener || opener.info !== CIPHER_FENCE_INFO) continue
        const body = lines
            .slice(block.start + 1, block.end)
            .map((line) => (line.length >= block.fenceColumn ? line.slice(block.fenceColumn) : line.trimStart()))
            .join('\n')
        const envelopes = unarmourProtected(body)
        const winner = resolveLastWriteWins(envelopes)
        out.push({
            start: block.start,
            end: block.end,
            from: lineStarts[block.start],
            // The closer's last character, NOT the newline after it — so an insertion on the line
            // below the fence is outside the range and stays editable.
            to: lineStarts[block.end] + lines[block.end].length,
            fenceColumn: block.fenceColumn,
            envelopes,
            winner,
            fingerprint: winner ? protectedEnvelopeFingerprint(winner) : null,
            writtenAt: winner ? protectedEnvelopeWrittenAt(winner) : null,
            needsCollapse: envelopes.length > 1,
        })
    }
    return out
}

export type DocumentProtectionKind =
    /**
     * Not a Protected Document. Includes a document with a cipher fence somewhere in it that is
     * not the whole body: protection is whole-document only (ADR 0060), so such a fence is
     * ordinary markdown — a code block that happens to hold base64 — and means nothing here.
     */
    | 'none'
    /** The whole body is one cipher fence — a [[Protected Document]]. */
    | 'document'

export interface DocumentProtection {
    kind: DocumentProtectionKind
    fences: CipherFence[]
    /** The distinct Protection Key fingerprints the document's fences need. */
    fingerprints: Uint8Array[]
}

/**
 * Classify a document's text: a Protected Document, or not. Only a fence that is the entire body
 * below any Frontmatter counts (ADR 0060); `fences` still lists every fence found, because the
 * service's per-fence classification and the index's exclusion both want them.
 */
export function documentProtection(text: string): DocumentProtection {
    // Measured from the WHOLE document, not from below the Frontmatter. `cipherFences` and
    // `protectedRanges` both use whole-document line indices, and a second index base here would
    // silently mis-locate every fence in a document that has Frontmatter.
    const lines = text.split('\n')
    const fences = cipherFences(lines)
    if (fences.length === 0) return { kind: 'none', fences, fingerprints: [] }

    const fingerprints: Uint8Array[] = []
    const seen = new Set<string>()
    for (const f of fences) {
        if (!f.fingerprint) continue
        const key = String(f.fingerprint)
        if (seen.has(key)) continue
        seen.add(key)
        fingerprints.push(f.fingerprint)
    }

    // Document-protected means the fence IS the body: one fence, opening on the first non-blank
    // line below any Frontmatter and closing on the last. Anything else is not protection.
    const only = fences.length === 1 ? fences[0] : null
    const bodyStart = bodyStartLine(text)
    const first = firstNonBlank(lines, bodyStart)
    const last = lastNonBlank(lines)
    const wholeBody = only !== null && only.start === first && only.end === last
    return { kind: wholeBody ? 'document' : 'none', fences, fingerprints }
}

/** The first line index below any Frontmatter — where a document's body begins. */
function bodyStartLine(text: string): number {
    return frontmatterSpan(text)?.lines ?? 0
}

function firstNonBlank(lines: readonly string[], from: number): number {
    for (let i = from; i < lines.length; i++) if (lines[i].trim() !== '') return i
    return -1
}

function lastNonBlank(lines: readonly string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') return i
    return -1
}

/**
 * A document's body — everything below any Frontmatter. Protection replaces exactly this, leaving
 * the Frontmatter in the clear so the concept name stays visible and wikilink-resolvable.
 */
export function documentBody(text: string): string {
    return bodyLines(text).lines.join('\n')
}

/** A document split into its frontmatter prefix (kept verbatim) and its body lines. */
function bodyLines(text: string): { prefix: string; lines: string[] } {
    const span = frontmatterSpan(text)
    if (!span) return { prefix: '', lines: text.split('\n') }
    return { prefix: text.slice(0, span.end), lines: text.slice(span.end).split('\n') }
}

/**
 * Turn a document into a [[Protected Document]]: the body becomes one fence holding `armoured`,
 * and any Frontmatter is kept in the clear above it so the concept name stays visible and
 * wikilink-resolvable (ADR 0057 / DESIGN.md).
 */
export function protectDocumentText(text: string, armoured: string): string {
    const { prefix } = bodyLines(text)
    return prefix + fenceLines(armoured, '', DEFAULT_TICKS).join('\n')
}

/** The three lines of a fence: opener, one armoured body line, closer. */
function fenceLines(armoured: string, indent: string, ticks: string): string[] {
    return [`${indent}${ticks}${CIPHER_FENCE_INFO}`, `${indent}${armoured}`, `${indent}${ticks}`]
}

/**
 * The Frontmatter a document carries, verbatim, closing delimiter and newline included — the part
 * of a [[Protected Document]] that stays in the clear. `''` when there is none.
 */
export function frontmatterPrefix(text: string): string {
    return bodyLines(text).prefix
}

/** Restore a [[Protected Document]]'s plaintext body, keeping its Frontmatter. */
export function unprotectDocumentText(text: string, plaintext: string): string {
    return bodyLines(text).prefix + plaintext
}

export interface LineEdit {
    /** First line index replaced, inclusive. */
    fromLine: number
    /** Last line index replaced, inclusive. */
    toLine: number
    /** The replacement text — one delete plus one insert, which is what ADR 0028 requires. */
    text: string
}

/**
 * Replace a fence's **body** with one armoured envelope, leaving the opener and closer untouched.
 * This is the write that ADR 0028 demands be a single delete plus a single insert: character-level
 * CRDT edits inside ciphertext would let a stray character make the envelope undecryptable.
 */
export function replaceCipherFenceBody(fence: CipherFence, armoured: string): LineEdit {
    const pad = ' '.repeat(fence.fenceColumn)
    return { fromLine: fence.start + 1, toLine: fence.end - 1, text: pad + armoured }
}


