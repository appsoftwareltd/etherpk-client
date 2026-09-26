import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCK_SETTINGS } from './lock-machine'
import { ProtectionService } from './protection-service'
import { inMemoryProtectionStore } from './protection-store'
import { protectedTextReader } from './protected-text-reader'

/**
 * The reader the asset safety checks see protected documents through: all of a document's
 * cipher content, or null. A null keeps an asset's bytes, so a reader that answers null for a
 * document that holds nothing unreadable blocks every delete in that graph for good.
 */

async function unlocked() {
    const service = new ProtectionService({
        store: inMemoryProtectionStore(),
        now: () => 0,
        settings: () => DEFAULT_LOCK_SETTINGS,
        commit: async () => {},
        kdfCost: { m: 8, t: 1, p: 1 },
    })
    await service.enable('correct horse battery staple')
    return service
}

describe('protectedTextReader', () => {
    it('reads a protected document while unlocked, and nothing while locked', async () => {
        const service = await unlocked()
        const text = await service.protectDocument('---\ntitle: Vault\n---\n- ![scan](../assets/scan.7f3a.png)\n')
        const read = protectedTextReader(service)
        expect(await read(text)).toContain('scan.7f3a.png')
        service.lockNow()
        expect(await read(text)).toBeNull()
    })

    it('treats a cipher fence shown inside another code block as text it has already read', async () => {
        // The format documentation does this: an example of the fence, inside a longer fence.
        const service = await unlocked()
        service.lockNow()
        const example = ['# Protected documents', '', '````markdown', '```etherpk-cipher', 'AQQAAAGYexample', '```', '````', ''].join('\n')
        expect(await protectedTextReader(service)(example)).toBe('')
    })

    it('reads a fence nested inside protected plaintext, and answers null when it cannot', async () => {
        // A page holding a fence beside plaintext, then protected whole: the old fence is now
        // inside the new one's plaintext, and a reference only inside it must still be found.
        const service = await unlocked()
        const inner = await service.protectDocument('- ![x](../assets/inner.7f3a.png)\n')
        const outer = await service.protectDocument(`${inner}\n- visible text\n`)
        const read = protectedTextReader(service)
        const plaintext = await read(outer)
        expect(plaintext).toContain('inner.7f3a.png')
        expect(plaintext).toContain('visible text')

        // The inner fence sealed under a key this device does not hold: the whole read is null.
        const other = await unlocked()
        const foreign = await other.protectDocument('- ![y](../assets/foreign.9c1d.png)\n')
        const wrapped = await service.protectDocument(`${foreign}\n- visible text\n`)
        expect(await read(wrapped)).toBeNull()
    })

    // Two offline rewrites merged leave a fence holding several envelopes until a key holder
    // collapses it. An image pasted only in the losing one is still in the document's data.
    it('reads every envelope a fence holds, and answers null when any will not open', async () => {
        const service = await unlocked()
        const winner = await service.encrypt('- ![w](../assets/one.aaaa.png)')
        const loser = await service.encrypt('- ![l](../assets/two.bbbb.png)')
        const merged = ['```etherpk-cipher', winner, loser, '```', ''].join('\n')
        const read = protectedTextReader(service)
        const plaintext = await read(merged)
        expect(plaintext).toContain('one.aaaa.png')
        expect(plaintext).toContain('two.bbbb.png')

        const other = await unlocked()
        const foreign = await other.encrypt('- ![f](../assets/three.cccc.png)')
        expect(await read(['```etherpk-cipher', winner, foreign, '```', ''].join('\n'))).toBeNull()
    })

    it('answers null for an opener that pairs with no fence, beside a readable one too', async () => {
        const service = await unlocked()
        const read = protectedTextReader(service)
        expect(await read('```etherpk-cipher\nAQQAAAGYnot-closed\n')).toBeNull()
        const text = await service.protectDocument('- body\n')
        expect(await read(`${text}\n\n\`\`\`etherpk-cipher\nAQQAAAGYstray\n`)).toBeNull()
    })
})
