import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearMermaidCache, mermaidCacheSize, mermaidRenderer } from './mermaid-renderer'

/**
 * The mermaid SVG cache is content-keyed (a collision would show the wrong diagram), so it holds
 * diagram labels in the clear: a lock empties it. The generation guard is what makes the
 * clear complete - a render that was already in flight when the cache was cleared must not put
 * its SVG back afterwards.
 */

const render = vi.fn<(id: string, source: string) => Promise<{ svg: string }>>()

vi.mock('mermaid', () => ({
    default: {
        initialize: vi.fn(),
        render: (id: string, source: string) => render(id, source),
    },
}))

/** Enough of a DOM for `container()`: the Node tier has no document. */
const fakeDocument = {
    createElement: () => ({ className: '', innerHTML: '' }),
    getElementById: () => null,
}

beforeEach(() => {
    vi.stubGlobal('document', fakeDocument)
    render.mockReset()
    clearMermaidCache()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('mermaid renderer cache', () => {
    it('caches a completed render and serves the next call for the same source from memory', async () => {
        render.mockResolvedValue({ svg: '<svg>Salary</svg>' })
        await mermaidRenderer.render('graph TD\n  Salary-->Bank', { dark: false })
        expect(mermaidCacheSize()).toBe(1)

        await mermaidRenderer.render('graph TD\n  Salary-->Bank', { dark: false })
        expect(render).toHaveBeenCalledTimes(1)
    })

    it('clear() empties the cache, and the next render goes back to mermaid', async () => {
        render.mockResolvedValue({ svg: '<svg/>' })
        await mermaidRenderer.render('graph TD', { dark: false })
        expect(mermaidCacheSize()).toBe(1)

        clearMermaidCache()

        expect(mermaidCacheSize()).toBe(0)
        await mermaidRenderer.render('graph TD', { dark: false })
        expect(render).toHaveBeenCalledTimes(2)
    })

    it('a render resolving after clear() does not repopulate the cache', async () => {
        let finish: (value: { svg: string }) => void = () => {}
        render.mockReturnValue(new Promise((resolve) => (finish = resolve)))
        const inFlight = mermaidRenderer.render('graph TD', { dark: false })
        // Let the renderer reach mermaid.render before the clear, so the render is genuinely in flight.
        await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))

        clearMermaidCache()
        finish({ svg: '<svg/>' })
        const node = await inFlight

        // The caller still gets its diagram - only the cache is refused.
        expect(node.innerHTML).toBe('<svg/>')
        expect(mermaidCacheSize()).toBe(0)
    })
})
