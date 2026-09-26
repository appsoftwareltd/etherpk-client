/**
 * Reading what a [[Protected Document]] holds, for a check that must not miss anything in it.
 *
 * The asset safety checks (the [[Orphaned Asset]] scan and the in-document delete, ADR 0054)
 * decide whether bytes may be destroyed by searching document text for an asset's identity. A
 * Protected Document's text is ciphertext, so a reference inside one is invisible to that search,
 * and on its own "referenced by no document" could mean "referenced only by a protected
 * document". A check reads such a document through this reader instead: the plaintext of every
 * envelope of every cipher fence (a merge can leave several in one fence), or nothing at all.
 *
 * All or nothing, deliberately. A fence that is locked, that another member's key protects, that
 * holds no readable envelope, or an opener that pairs with no fence all mean some of the
 * document went unread, and a partial read would be believed as a whole one. An opener shown
 * inside another code block (the format's own documentation does this) is text, already in the
 * stored text the checks search, and reads as nothing more to add.
 *
 * It reads the text it is given: the caller commits pending protected edits first (the
 * projection encrypts on a debounce), or an edit still on screen is not in it.
 */
import { fencedBlocks } from '../fenced-code'
import { type CipherFence, cipherFences } from './cipher-fence'
import { containsCipherFence } from './fence-info'
import type { ProtectionService } from './protection-service'

/** The plaintext inside every cipher fence of `text`, or null when any of it cannot be read now. */
export type ProtectedTextReader = (text: string) => Promise<string | null>

/**
 * Lines that open a cipher fence but belong to none: not the start of a paired cipher fence and
 * not inside another fenced block. Paired by the same `fencedBlocks` rule `cipherFences` uses, so
 * the two cannot disagree about what is a fence.
 */
function strayOpeners(lines: readonly string[], fences: readonly CipherFence[]): number {
    const starts = new Set(fences.map((fence) => fence.start))
    const blocks = fencedBlocks(lines)
    const insideBlock = (i: number) => blocks.some((block) => i > block.start && i <= block.end)
    let stray = 0
    for (let i = 0; i < lines.length; i++) {
        if (starts.has(i) || insideBlock(i)) continue
        if (containsCipherFence(lines[i])) stray += 1
    }
    return stray
}

/**
 * How deep a fence can sit inside another's plaintext before the reader gives up (answers null).
 * Each level is a page that held a fence beside plaintext and was then protected whole.
 */
const MAX_NESTING = 8

/** A reader over the open graph's protection: it reads while unlocked, and returns null otherwise. */
export function protectedTextReader(service: Pick<ProtectionService, 'decrypt'>): ProtectedTextReader {
    const read = async (text: string, depth: number): Promise<string | null> => {
        const lines = text.split('\n')
        const fences = cipherFences(lines)
        if (strayOpeners(lines, fences) > 0) return null
        const plaintexts: string[] = []
        for (const fence of fences) {
            if (fence.envelopes.length === 0) return null
            const opened: string[] = []
            // Every envelope, not only the last write: a fence two offline rewrites merged holds
            // both until a key holder collapses it, and an image pasted only in the losing one is
            // still in the document's data.
            for (const envelope of fence.envelopes) {
                try {
                    // Throws while locked or masked, and for an envelope sealed under another
                    // member's key (it will not open).
                    opened.push(await service.decrypt({ ...fence, winner: envelope }))
                } catch {
                    return null
                }
            }
            let plaintext = opened.join('\n')
            // A page that held a fence beside plaintext and was then protected whole keeps the old
            // fence inside the new plaintext: read it too, or a reference only in there is missed.
            if (containsCipherFence(plaintext)) {
                const inner = depth < MAX_NESTING ? await read(plaintext, depth + 1) : null
                if (inner === null) return null
                plaintext = `${plaintext}\n${inner}`
            }
            plaintexts.push(plaintext)
        }
        return plaintexts.join('\n')
    }
    return (text) => read(text, 0)
}
