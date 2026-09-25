import { describe, expect, it, vi } from 'vitest'

import { type AssetByteReadinessDeps, serverAssetByteReadiness } from './asset-byte-readiness'

function deps(overrides: Partial<AssetByteReadinessDeps> & { docs?: string[]; behind?: string[] } = {}) {
    const docs = overrides.docs ?? ['doc-1', 'doc-2']
    return {
        isConnected: () => true,
        registry: () => ({ forEach: (visit: (e: unknown, id: string) => void) => docs.forEach((d) => visit({}, d)) }),
        docsNeedingCatchup: vi.fn(async () => overrides.behind ?? []),
        ...overrides,
    }
}

describe('serverAssetByteReadiness', () => {
    it('is ready when connected and every document is at the relay head', async () => {
        expect(await serverAssetByteReadiness(deps())).toEqual({ ready: true })
    })

    it('refuses while offline, without asking the relay anything', async () => {
        const d = deps({ isConnected: () => false })

        expect(await serverAssetByteReadiness(d)).toEqual({ ready: false, reason: 'offline' })
        expect(d.docsNeedingCatchup).not.toHaveBeenCalled()
    })

    it('refuses when any single document is behind', async () => {
        expect(await serverAssetByteReadiness(deps({ behind: ['doc-2'] }))).toEqual({
            ready: false,
            reason: 'behind',
        })
    })

    it('asks about every document in the registry, not just materialised ones', async () => {
        const d = deps({ docs: ['a', 'b', 'c'] })

        await serverAssetByteReadiness(d)

        expect(d.docsNeedingCatchup).toHaveBeenCalledWith(['a', 'b', 'c'])
    })

    it('is ready for an empty graph', async () => {
        expect(await serverAssetByteReadiness(deps({ docs: [] }))).toEqual({ ready: true })
    })
})
