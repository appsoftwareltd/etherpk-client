import { describe, expect, it } from 'vitest'

import { createProtectionRecord, newKdfParams } from '#lib/crypto/index.js'

import { protectionToUnlock } from './source-protection'
import type { SourceFile } from './types'

function file(path: string, text: string): SourceFile {
    return { path, data: new Blob([text]) }
}

async function recordJson(): Promise<string> {
    const { record } = await createProtectionRecord('a garden passphrase', { ...newKdfParams(), m: 8 * 1024, t: 1, p: 1 })
    return JSON.stringify(record)
}

describe('protectionToUnlock', () => {
    it('is the record when protected documents could embed one of the graph’s files', async () => {
        const files = [file('etherpk/protection.json', await recordJson()), file('assets/seed.png', 'png'), file('pages/Beans.md', '-')]
        expect(await protectionToUnlock(files)).toMatchObject({ v: expect.any(Number) })
    })

    it('is null with no record, with nothing to embed, or with a record this build cannot read', async () => {
        const record = file('etherpk/protection.json', await recordJson())
        expect(await protectionToUnlock([file('assets/seed.png', 'png')])).toBeNull()
        expect(await protectionToUnlock([record, file('pages/Beans.md', '-'), file('etherpk/settings.json', '{}')])).toBeNull()
        expect(await protectionToUnlock([file('etherpk/protection.json', 'not a record'), file('assets/seed.png', 'png')])).toBeNull()
        // A junk file embeds nothing.
        expect(await protectionToUnlock([record, file('.trash/old.png', 'png')])).toBeNull()
    })
})
