/**
 * Seal the Demo Graph's protected page (ADR 0069).
 *
 * The bundle ships "Where I hide the good fertiliser" as a Protected Document, whose body is a
 * cipher fence and whose key is wrapped in `etherpk/protection.json` under the passphrase the
 * Welcome page states. To change the page: put the plaintext back in the file (frontmatter and
 * body), then from `apps/client` run
 *
 *     pnpm exec tsx --tsconfig tsconfig.json scripts/demo-graph-protect-page.mts
 *
 * which rewrites the page and the record with the app's own modules, so the formats cannot
 * drift from what the app reads. A page that is already sealed is refused rather than sealed
 * twice.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { armourProtected, createProtectionRecord, keyFingerprint, newKdfParams, sealProtected, serialiseProtectionRecord } from '$lib/crypto'
import { documentBody, documentProtection, protectDocumentText } from '$lib/document/protection/cipher-fence'

const PASSPHRASE = 'monstera'
const PAGE = 'static/demo-graph/pages/Where I hide the good fertiliser.md'
const RECORD = 'static/demo-graph/etherpk/protection.json'

async function main(): Promise<void> {
    const text = readFileSync(PAGE, 'utf8')
    if (documentProtection(text).kind !== 'none') {
        throw new Error(`${PAGE} is already sealed; put the plaintext back first`)
    }
    const { record, key } = await createProtectionRecord(PASSPHRASE, newKdfParams())
    const envelope = await sealProtected({
        key,
        fingerprint: await keyFingerprint(key),
        plaintext: documentBody(text),
        writtenAt: Date.now(),
    })
    writeFileSync(PAGE, protectDocumentText(text, armourProtected(envelope)))
    writeFileSync(RECORD, `${serialiseProtectionRecord(record)}\n`)
    console.warn(`sealed ${PAGE}; wrote ${RECORD}`)
}

await main()
