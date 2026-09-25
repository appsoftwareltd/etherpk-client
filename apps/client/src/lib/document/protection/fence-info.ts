/**
 * The one name for the protected fence, and the one way to recognise one in raw text.
 *
 * Deliberately dependency-free. The [[Derived Index]] worker must be able to ask "is this a
 * protected fence?" without pulling in the crypto stack (Argon2id, the envelope, the key record),
 * and the answer must be the same string the editor and the storage layer use — a second regex
 * somewhere else is how a guard silently stops guarding.
 */

/** The info-string that marks a fence as protected content. */
export const CIPHER_FENCE_INFO = 'etherpk-cipher'

/**
 * Whether any line of `text` opens a cipher fence. Multiline and deliberately generous: an index
 * unit that contains a cipher fence *anywhere* is excluded whole, rather than the index trying to
 * reason about where the fence starts and stops.
 */
export function containsCipherFence(text: string): boolean {
    return CIPHER_FENCE_OPENER.test(text)
}

// Tolerates a leading bullet marker (`- ```etherpk-cipher`), matching fenceLineInfo's own rule,
// and anything after the info-string, so a fence written by a newer client still counts.
const CIPHER_FENCE_OPENER = new RegExp(`^\\s*(?:-\\s)?\`{3,}\\s*${CIPHER_FENCE_INFO}\\b`, 'mu')
