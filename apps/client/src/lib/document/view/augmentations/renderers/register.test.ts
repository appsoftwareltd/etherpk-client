import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import {
    clearRenderCaches,
    fenceRenderResults,
    fenceResultKey,
    markRenderFailed,
    renderCacheSizes,
    renderedSizes,
    renderKey,
} from '../rendered-common'
import { lookupAugmentationRenderer } from './contract'
import { clearMermaidCache, mermaidCacheSize, mermaidRenderer } from './mermaid-renderer'
import { clearAugmentationRenderCaches, registerAugmentationRenderers } from './register'

/**
 * The composition root's two calls: register the built-in renderers, and later clear every
 * render cache - on a lock and on graph close (the detach).
 */

vi.mock('mermaid', () => ({
    default: {
        initialize: vi.fn(),
        render: vi.fn(async () => ({ svg: '<svg>Salary</svg>' })),
    },
}))

type CacheHook = { sizes(): Record<string, number>; clear(): void }

function seedEveryCache(): Promise<unknown> {
    fenceRenderResults.set(fenceResultKey(1, 'mermaid', 0), {
        owner: 1,
        source: 'graph TD',
        dark: false,
        version: 1,
        node: null,
        error: null,
        pending: null,
        reqSeq: 1,
    })
    renderedSizes.set(renderKey('mermaid', 'graph TD', false), 80)
    markRenderFailed(renderKey('math', '\\frac{', false))
    return mermaidRenderer.render('graph TD\n  Salary-->Bank', { dark: false })
}

beforeEach(() => {
    vi.stubGlobal('document', {
        createElement: () => ({ className: '', innerHTML: '' }),
        getElementById: () => null,
    })
})

afterEach(() => {
    clearRenderCaches()
    clearMermaidCache()
    setActiveContributionRegistry(null)
    vi.unstubAllGlobals()
})

describe('registerAugmentationRenderers', () => {
    it('registers mermaid and math, and the detach unregisters both and clears every cache', async () => {
        const registry = createContributionRegistry()
        setActiveContributionRegistry(registry)
        const detach = registerAugmentationRenderers(registry)
        expect(lookupAugmentationRenderer('mermaid')).toBeDefined()
        expect(lookupAugmentationRenderer('math')).toBeDefined()

        await seedEveryCache()
        expect(renderCacheSizes()).toEqual({ results: 1, sizes: 1, failed: 1 })
        expect(mermaidCacheSize()).toBe(1)

        detach()

        expect(lookupAugmentationRenderer('mermaid')).toBeUndefined()
        expect(lookupAugmentationRenderer('math')).toBeUndefined()
        expect(renderCacheSizes()).toEqual({ results: 0, sizes: 0, failed: 0 })
        expect(mermaidCacheSize()).toBe(0)
    })

    it('clearAugmentationRenderCaches empties the host caches and the mermaid cache in one call', async () => {
        await seedEveryCache()
        clearAugmentationRenderCaches()
        expect(renderCacheSizes()).toEqual({ results: 0, sizes: 0, failed: 0 })
        expect(mermaidCacheSize()).toBe(0)
    })

    it('installs the dev introspection hook on the window, reporting every cache', async () => {
        vi.stubGlobal('window', {})
        registerAugmentationRenderers(createContributionRegistry())
        const hook = (window as unknown as { __etherpkRenderCaches?: CacheHook }).__etherpkRenderCaches
        expect(hook).toBeDefined()

        await seedEveryCache()
        expect(hook!.sizes()).toEqual({ results: 1, sizes: 1, failed: 1, mermaid: 1 })
        hook!.clear()
        expect(hook!.sizes()).toEqual({ results: 0, sizes: 0, failed: 0, mermaid: 0 })
    })
})
