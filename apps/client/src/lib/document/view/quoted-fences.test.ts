import type { PublishedFence, QuoteFenceRequest } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it, vi } from 'vitest'

import type { InteractiveFence } from './augmentations/interactive-fence-contract'
import { createQuotedFences } from './quoted-fences'

// The answers a registration's `quote` gives the reference lists (ADR 0146), checked and kept. The
// SVG cleaning needs a DOM, which this suite has none of: an SVG answer is refused here, so nothing
// passes uncleaned, and the Client's browser suite shows a cleaned one
// (tests-client/references-extension-fences.test.ts).

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function picture(overrides: Partial<Extract<PublishedFence, { kind: 'picture' }>> = {}): PublishedFence {
    return { kind: 'picture', type: 'image/png', bytes: PNG, width: 320, height: 180, alt: 'Beds in the garden', ...overrides }
}

function registration(quote?: (fence: QuoteFenceRequest) => PublishedFence | null | Promise<PublishedFence | null>): InteractiveFence {
    return {
        height: () => 48,
        mount: () => ({ update: () => {}, destroy: () => {} }),
        ...(quote ? { quote } : {}),
    }
}

const request = { info: 'garden.beds', body: ['id: north', 'bed 1'], document: 'Garden', dark: false }

describe('quoting a fence an extension draws', () => {
    it("asks the registration's quote with the fence and the theme, and gives back its picture", async () => {
        const quote = vi.fn(() => picture())
        const answer = await createQuotedFences().quote(registration(quote), request)
        expect(quote).toHaveBeenCalledWith(request)
        expect(answer).toEqual(picture())
    })

    it('answers null for a registration with no quote, and for a quote that shows nothing', async () => {
        const quoted = createQuotedFences()
        await expect(quoted.quote(registration(), request)).resolves.toBeNull()
        await expect(quoted.quote(registration(() => null), request)).resolves.toBeNull()
    })

    it('keeps an answer, so the same fence in the same theme is not asked again', async () => {
        const quote = vi.fn(() => picture())
        const fence = registration(quote)
        const quoted = createQuotedFences()
        await quoted.quote(fence, request)
        await quoted.quote(fence, { ...request, body: [...request.body] })
        expect(quote).toHaveBeenCalledTimes(1)
    })

    it('asks again for a change of text, theme or document', async () => {
        const quote = vi.fn(() => picture())
        const fence = registration(quote)
        const quoted = createQuotedFences()
        await quoted.quote(fence, request)
        await quoted.quote(fence, { ...request, body: ['id: north', 'bed 2'] })
        await quoted.quote(fence, { ...request, dark: true })
        await quoted.quote(fence, { ...request, document: 'Kitchen' })
        expect(quote).toHaveBeenCalledTimes(4)
    })

    it('asks a registration made again, as an extension started again makes, afresh', async () => {
        const first = vi.fn(() => picture())
        const second = vi.fn(() => picture({ alt: 'Beds, again' }))
        const quoted = createQuotedFences()
        await quoted.quote(registration(first), request)
        await expect(quoted.quote(registration(second), request)).resolves.toMatchObject({ alt: 'Beds, again' })
        expect(second).toHaveBeenCalledTimes(1)
    })

    it('keeps no failure: the next showing asks again', async () => {
        let fails = true
        const quote = vi.fn(() => {
            if (fails) throw new Error('not ready')
            return picture()
        })
        const fence = registration(quote)
        const quoted = createQuotedFences()
        await expect(quoted.quote(fence, request)).rejects.toThrow('not ready')
        fails = false
        await expect(quoted.quote(fence, request)).resolves.toEqual(picture())
        expect(quote).toHaveBeenCalledTimes(2)
    })

    it("asks again once the extension's settings change, as a setting for thumbnails would", async () => {
        const listeners = new Set<() => void>()
        const quote = vi.fn(() => picture())
        const fence: InteractiveFence = {
            ...registration(quote),
            quotesChanged(listener) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
        }
        const quoted = createQuotedFences()
        await quoted.quote(fence, request)
        await quoted.quote(fence, request)
        expect(quote).toHaveBeenCalledTimes(1)
        for (const listener of listeners) listener()
        await quoted.quote(fence, request)
        expect(quote).toHaveBeenCalledTimes(2)
        // Heard once for the registration, however many quotes asked.
        expect(listeners.size).toBe(1)
    })

    it('gives up on an answer that does not come in time, and keeps no such failure', async () => {
        let answers = false
        const quote = vi.fn(() => (answers ? picture() : new Promise<PublishedFence>(() => {})))
        const fence = registration(quote)
        const quoted = createQuotedFences({ answerMs: 20 })
        await expect(quoted.quote(fence, request)).rejects.toThrow('did not answer')
        answers = true
        await expect(quoted.quote(fence, request)).resolves.toEqual(picture())
    })

    it('lets the answer shown longest ago go once it holds as many as it may', async () => {
        const quote = vi.fn(() => picture())
        const fence = registration(quote)
        const quoted = createQuotedFences({ capacity: 2 })
        const body = (line: string) => ({ ...request, body: [line] })
        await quoted.quote(fence, body('bed 1'))
        await quoted.quote(fence, body('bed 2'))
        await quoted.quote(fence, body('bed 1'))
        await quoted.quote(fence, body('bed 3'))
        expect(quote).toHaveBeenCalledTimes(3)
        // `bed 2` was shown longest ago, so it went; `bed 1`, shown again, stayed.
        await quoted.quote(fence, body('bed 1'))
        expect(quote).toHaveBeenCalledTimes(3)
        await quoted.quote(fence, body('bed 2'))
        expect(quote).toHaveBeenCalledTimes(4)
    })
})

describe('what a quote may answer', () => {
    const answer = (out: unknown) => createQuotedFences().quote(registration(() => out as PublishedFence), request)

    // The checks themselves are the publisher's too (fence-answer.test.ts): here, that a quote uses them.
    it('refuses what the shared checks refuse', async () => {
        await expect(answer({ kind: 'link', href: 'javascript:alert(1)', text: 'The plot' })).rejects.toThrow('not an https address')
        await expect(answer(undefined)).rejects.toThrow('neither a picture nor a link')
    })

    it('refuses an SVG picture where there is no DOM to clean it against, so none shows uncleaned', async () => {
        const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        await expect(answer(picture({ type: 'image/svg+xml', bytes: svg }))).rejects.toThrow('could check')
    })
})
