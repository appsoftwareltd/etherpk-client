import { describe, expect, it, vi } from 'vitest'

import { type AssetByteReadiness, assetUsageNeedles, planAssetDelete } from './asset-delete'
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
