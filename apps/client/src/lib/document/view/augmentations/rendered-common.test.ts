import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    clearRenderCaches,
    fenceRenderResults,
    fenceResultKey,
    hasRenderFailed,
    markRenderFailed,
    renderCacheSizes,
    renderedSizes,
    renderKey,
} from './rendered-common'

/**
 * The render caches: the harmless keys carry a hash of the source
 * rather than the source, and one call empties everything the hosts hold - the lock branch and
 * the graph-close detach both rely on it (Protected Documents: "nothing to find").
 */

afterEach(() => {
    clearRenderCaches()
    vi.useRealTimers()
})

describe('renderKey', () => {
    it('carries no source text', () => {
        const source = 'graph TD\n  Salary-->Bank'
        const key = renderKey('mermaid', source, false)
        expect(key).not.toContain('Salary')
        expect(key).not.toContain('Bank')
        expect(key).not.toContain(source)
    })

    it('is stable for the same artefact and distinct across source, theme and info', () => {
        expect(renderKey('math', 'E=mc^2', false)).toBe(renderKey('math', 'E=mc^2', false))
        expect(renderKey('math', 'E=mc^2', false)).not.toBe(renderKey('math', 'E=mc^3', false))
        expect(renderKey('math', 'E=mc^2', false)).not.toBe(renderKey('math', 'E=mc^2', true))
        expect(renderKey('math', 'E=mc^2', false)).not.toBe(renderKey('mermaid', 'E=mc^2', false))
    })
})

describe('fenceResultKey', () => {
    it('separates two owners holding the same fence on the same line', () => {
        expect(fenceResultKey(1, 'mermaid', 3)).not.toBe(fenceResultKey(2, 'mermaid', 3))
        expect(fenceResultKey(1, 'mermaid', 3)).toBe(fenceResultKey(1, 'mermaid', 3))
    })
})

describe('clearRenderCaches', () => {
    it('empties the results, the sizes and the failure set, and cancels a pending render', () => {
        vi.useFakeTimers()
        const pending = vi.fn()
        fenceRenderResults.set(fenceResultKey(1, 'mermaid', 0), {
            owner: 1,
            source: 'graph TD',
            dark: false,
            version: 1,
            node: null,
            error: null,
            // An arrow, not the mock itself: with both the DOM and the Node `setTimeout` in
            // scope, a mock argument resolves to the DOM overload (a number) while the entry is
            // typed on the Node one - the same call shape fence-render.ts uses.
            pending: setTimeout(() => pending(), 200),
            reqSeq: 1,
        })
        renderedSizes.set(renderKey('mermaid', 'graph TD', false), 120)
        markRenderFailed(renderKey('math', '\\frac{', false))
        expect(renderCacheSizes()).toEqual({ results: 1, sizes: 1, failed: 1 })

        clearRenderCaches()

        expect(renderCacheSizes()).toEqual({ results: 0, sizes: 0, failed: 0 })
        expect(hasRenderFailed(renderKey('math', '\\frac{', false))).toBe(false)
        vi.runAllTimers()
        expect(pending).not.toHaveBeenCalled()
    })
})
