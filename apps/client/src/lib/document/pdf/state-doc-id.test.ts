import { describe, expect, it } from 'vitest'

import { pdfStateDocId } from './state-doc-id'

const secret = new Uint8Array(32).fill(7)
const hash = 'a'.repeat(64)

describe('a private PDF document id', () => {
    it('is the same on every device, and a valid version 8 UUID', async () => {
        const id = await pdfStateDocId(secret, 'member-one', hash)
        expect(id).toBe(await pdfStateDocId(secret, 'member-one', hash))
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('differs by person and by PDF', async () => {
        const id = await pdfStateDocId(secret, 'member-one', hash)
        expect(await pdfStateDocId(secret, 'member-two', hash)).not.toBe(id)
        expect(await pdfStateDocId(secret, 'member-one', 'b'.repeat(64))).not.toBe(id)
    })
})
