import { describe, expect, it, vi } from 'vitest'

import { type AssetByteReadiness, assetUsageNeedles, planAssetDelete, protectedAssetUsage } from './asset-delete'
import type { AssetUsage } from './index-db'

const doc = (concept: string, references = 1) => ({ concept, kind: 'page' as const, references })
const usage = (references: number, ...documents: ReturnType<typeof doc>[]): AssetUsage => ({
    references,
    documents,
})
const ready: AssetByteReadiness = { ready: true }

describe('planAssetDelete', () => {
    it('destroys the bytes when this is the only reference', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(1, doc('Alpha')),
            readiness: async () => ready,
        })

        expect(plan).toEqual({ deleteBytes: true, references: 1, documents: [doc('Alpha')] })
    })

    it('destroys the bytes when the index has not seen this reference yet', async () => {
        // Paste an image and trash it inside the index's debounce: nothing else holds it.
        const plan = await planAssetDelete({ usage: async () => usage(0), readiness: async () => ready })

        expect(plan.deleteBytes).toBe(true)
    })

    it('keeps the bytes and names the other documents when used elsewhere', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(3, doc('Alpha'), doc('Bravo', 2)),
            readiness: async () => ready,
        })

        expect(plan).toEqual({
            deleteBytes: false,
            blockedBy: 'used-elsewhere',
            references: 3,
            documents: [doc('Alpha'), doc('Bravo', 2)],
        })
    })

    it('does not ask the relay anything when the count already refuses', async () => {
        const readiness = vi.fn(async () => ready)

        await planAssetDelete({ usage: async () => usage(2, doc('Alpha'), doc('Bravo')), readiness })

        expect(readiness).not.toHaveBeenCalled()
    })

    it('keeps the bytes while the index is still building, rather than reading silence as absence', async () => {
        const readiness = vi.fn(async () => ready)

        const plan = await planAssetDelete({ usage: async () => null, readiness })

        expect(plan).toEqual({ deleteBytes: false, blockedBy: 'index-building', references: 0, documents: [] })
        expect(readiness).not.toHaveBeenCalled()
    })

    it('keeps the bytes when a synced graph is offline', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(1, doc('Alpha')),
            readiness: async () => ({ ready: false, reason: 'offline' }),
        })

        expect(plan.deleteBytes).toBe(false)
        expect(plan.blockedBy).toBe('offline')
        // The documents are still reported: the dialog can say what it does know.
        expect(plan.documents).toEqual([doc('Alpha')])
    })

    it('keeps the bytes when a synced graph is behind the relay', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(1),
            readiness: async () => ({ ready: false, reason: 'behind' }),
        })

        expect(plan.blockedBy).toBe('behind')
    })
})

// The [[Derived Index]] never holds a Protected Document, so a reference inside one is invisible
// to the count. Without asking the protected documents, the last visible reference would destroy
// bytes a protected page still uses (an asset reused by dedup, or a reference pasted into it).
describe('planAssetDelete with protected documents', () => {
    it('keeps the bytes when a protected document uses the asset too, and names it', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(1, doc('Alpha')),
            protectedUsage: async () => ({ readable: true, references: 1, documents: [doc('Vault')] }),
            readiness: async () => ready,
        })

        expect(plan).toEqual({ deleteBytes: false, blockedBy: 'used-elsewhere', references: 2, documents: [doc('Alpha'), doc('Vault')] })
    })

    it('keeps the bytes when a protected document cannot be read, and never asks the relay', async () => {
        const readiness = vi.fn(async () => ready)
        const plan = await planAssetDelete({
            usage: async () => usage(1, doc('Alpha')),
            protectedUsage: async () => ({ readable: false, unreadable: 2 }),
            readiness,
        })

        expect(plan).toEqual({ deleteBytes: false, blockedBy: 'protected-unread', unreadProtected: 2, references: 1, documents: [doc('Alpha')] })
        expect(readiness).not.toHaveBeenCalled()
    })

    it('destroys the bytes when every protected document was read and none uses the asset', async () => {
        const plan = await planAssetDelete({
            usage: async () => usage(1, doc('Alpha')),
            protectedUsage: async () => ({ readable: true, references: 0, documents: [] }),
            readiness: async () => ready,
        })

        expect(plan.deleteBytes).toBe(true)
    })

    it('destroys the bytes of an image trashed inside a protected document, when that is its only use', async () => {
        // The index has none (the document is protected); the document's own plaintext has one.
        const plan = await planAssetDelete({
            usage: async () => usage(0),
            protectedUsage: async () => ({ readable: true, references: 1, documents: [doc('Vault')] }),
            readiness: async () => ready,
        })

        expect(plan.deleteBytes).toBe(true)
    })
})

describe('protectedAssetUsage', () => {
    const plaintexts: Record<string, string | null> = {
        Vault: '- ![a](../assets/a.7f3a.png) and again ![a](../assets/a.7f3a.png)',
        Diary: '- nothing attached',
    }
    /** A stored protected document: its fence holds a stand-in the fake reader maps to plaintext. */
    const sealed = (concept: string) => `---\ntitle: ${concept}\n---\n\`\`\`etherpk-cipher\n${concept}\n\`\`\`\n`
    const storedOf = (texts: Record<string, string | null>) => async (concepts: readonly string[]) =>
        new Map(concepts.map((c) => [c, c in texts ? texts[c] : sealed(c)] as const))
    const readStored = storedOf({})
    const readProtected = async (text: string) => {
        const concept = /etherpk-cipher\n(.*)\n/.exec(text)?.[1] ?? ''
        return plaintexts[concept] ?? null
    }

    it('counts references in each protected document it can read', async () => {
        const found = await protectedAssetUsage(
            [{ concept: 'Vault', kind: 'page' }, { concept: 'Diary', kind: 'journal' }],
            ['7f3a'],
            { readStored, readProtected },
        )
        expect(found).toEqual({ readable: true, references: 2, documents: [{ concept: 'Vault', kind: 'page', references: 2 }] })
    })

    it('reports how many it could not read, locked or not its key', async () => {
        const found = await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }, { concept: 'Other', kind: 'page' }], ['7f3a'], { readStored, readProtected })
        expect(found).toEqual({ readable: false, unreadable: 1 })
        expect(await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], { readStored })).toEqual({ readable: false, unreadable: 1 })
    })

    // The index says protected, but what the store holds says otherwise.
    it('never reads a document that came back empty as one with no references', async () => {
        // A read that failed and left an empty buffer, or a document still syncing.
        const found = await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], { readStored: storedOf({ Vault: '' }), readProtected })
        expect(found).toEqual({ readable: false, unreadable: 1 })
        const unread = await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], { readStored: storedOf({ Vault: null }), readProtected })
        expect(unread).toEqual({ readable: false, unreadable: 1 })
    })

    it('searches a document protection was just removed from as the plaintext it now is', async () => {
        // The index still flags it; the stored text is ordinary markdown again.
        const found = await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], {
            readStored: storedOf({ Vault: '- ![a](../assets/a.7f3a.png)' }),
            readProtected,
        })
        expect(found).toEqual({ readable: true, references: 1, documents: [{ concept: 'Vault', kind: 'page', references: 1 }] })
    })

    it('settles pending protected edits before reading, so an edit still on screen counts', async () => {
        const order: string[] = []
        await protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], {
            settle: async () => {
                order.push('settle')
            },
            readStored: async (concepts) => {
                order.push(`read ${concepts.join()}`)
                return readStored(concepts)
            },
            readProtected,
        })
        expect(order).toEqual(['settle', 'read Vault'])
    })

    it('fails rather than read stored text an edit could not reach', async () => {
        // A folder graph whose autosave failed: the file does not hold the latest edit.
        const reader = vi.fn(readStored)
        await expect(
            protectedAssetUsage([{ concept: 'Vault', kind: 'page' }], ['7f3a'], {
                settle: async () => Promise.reject(new Error('Edits to Vault could not be written to the folder yet')),
                readStored: reader,
                readProtected,
            }),
        ).rejects.toThrow('could not be written')
        expect(reader).not.toHaveBeenCalled()
    })

    it('reads nothing when the graph has no protected documents', async () => {
        const reader = vi.fn(readStored)
        expect(await protectedAssetUsage([], ['7f3a'], { readStored: reader, readProtected })).toEqual({ readable: true, references: 0, documents: [] })
        expect(reader).not.toHaveBeenCalled()
    })
})

describe('assetUsageNeedles', () => {
    it('is just the identity when nothing needs encoding', () => {
        expect(assetUsageNeedles('q3-report.a1b2c3d4.pdf')).toEqual(['q3-report.a1b2c3d4.pdf'])
        expect(assetUsageNeedles('7f3a1b2c-0000-4000-8000-000000000001')).toEqual([
            '7f3a1b2c-0000-4000-8000-000000000001',
        ])
    })

    it('adds the percent-encoded form for an imported name that needs one', () => {
        expect(assetUsageNeedles('my file.a1b2c3d4.pdf')).toEqual([
            'my file.a1b2c3d4.pdf',
            'my%20file.a1b2c3d4.pdf',
        ])
    })
})
