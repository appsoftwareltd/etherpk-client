/**
 * Repoint the asset references sealed inside a document's protected content.
 *
 * A synced import gives every asset a new reference, because the server Asset store mints its own,
 * and rewrites the documents to match by text replacement. That replacement cannot reach inside an
 * `etherpk-cipher` fence. With the Protection Key the fence was sealed under, the fence is opened,
 * its plaintext is rewritten the same way, and the result is sealed again. A fence under another
 * member's key is left exactly as it was and counted, so the Import Report can name the document.
 *
 * The key is the one the import wizard unwrapped from the passphrase the person typed. It lives
 * only as long as the import, outside the graph's protection session, and is never stored.
 */
import { armourProtected, keyFingerprint, openProtected, sealProtected, toBase64Url } from '$lib/crypto'
import { cipherFences, replaceCipherFenceBody } from '$lib/document/protection/cipher-fence'

/** A Protection Key in hand, with the fingerprint every fence sealed under it carries. */
export interface HeldProtectionKey {
    key: Uint8Array
    fingerprint: Uint8Array
}

export async function holdProtectionKey(key: Uint8Array): Promise<HeldProtectionKey> {
    return { key, fingerprint: await keyFingerprint(key) }
}

export interface RepointedText {
    text: string
    /** Fences sealed under another key, left as they were: the files they embed keep their old references. */
    sealedUnderOtherKeys: number
}

/**
 * `text` with `repoint` applied inside every fence `held` opens. A fence with nothing to repoint
 * keeps its envelope byte for byte, and so does one whose envelope will not open under the right
 * key: that content was damaged before the import, and rewriting it would not bring it back.
 */
export async function repointSealedReferences(
    text: string,
    repoint: (plaintext: string) => string,
    held: HeldProtectionKey,
    now: number,
): Promise<RepointedText> {
    const lines = text.split('\n')
    const fences = cipherFences(lines)
    const ours = toBase64Url(held.fingerprint)
    let next = lines
    let sealedUnderOtherKeys = 0
    // Back to front, so an earlier fence's line indices stay valid while a later one changes length.
    for (const fence of [...fences].reverse()) {
        if (!fence.winner || !fence.fingerprint) continue
        if (toBase64Url(fence.fingerprint) !== ours) {
            sealedUnderOtherKeys += 1
            continue
        }
        let plaintext: string
        try {
            plaintext = (await openProtected({ key: held.key, envelope: fence.winner })).plaintext
        } catch {
            continue
        }
        const repointed = repoint(plaintext)
        if (repointed === plaintext) continue
        const envelope = await sealProtected({ key: held.key, fingerprint: held.fingerprint, plaintext: repointed, writtenAt: now })
        const edit = replaceCipherFenceBody(fence, armourProtected(envelope))
        next = [...next.slice(0, edit.fromLine), edit.text, ...next.slice(edit.toLine + 1)]
    }
    return { text: next.join('\n'), sealedUnderOtherKeys }
}
