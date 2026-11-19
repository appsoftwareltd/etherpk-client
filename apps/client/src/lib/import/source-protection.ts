/**
 * The protection record a copy of a graph carries (ADR 0093), when a synced import needs its
 * passphrase. A synced import gives every file a new reference, and the references sealed inside a
 * protected document can only be updated with the key its passphrase unwraps, so the dialogs that
 * import into a synced graph ask for it. Only an EtherPK source carries one.
 */
import { parseProtectionRecord, type ProtectionRecord } from '#lib/crypto/index.js'
import { PROTECTION_FILE } from '#lib/document/protection/protection-store.js'

import { findFile, isJunkPath, isMarkdownPath } from './source'
import type { SourceFile } from './types'

/**
 * The record, when the source has one and holds any file a protected document could embed; null
 * otherwise. A record this build cannot read gives null too: the converter reports it, and no
 * passphrase would open it.
 */
export async function protectionToUnlock(files: readonly SourceFile[]): Promise<ProtectionRecord | null> {
    const file = findFile([...files], `etherpk/${PROTECTION_FILE}`)
    const embeds = files.some((f) => !isJunkPath(f.path) && !isMarkdownPath(f.path) && !f.path.startsWith('etherpk/'))
    if (!file || !embeds) return null
    try {
        return parseProtectionRecord(await file.data.text())
    } catch {
        return null
    }
}
