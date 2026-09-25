import { describe, expect, it } from 'vitest'

import { frontmatterLineOffset, resetReveal, revealLine, subscribeReveal, takeReveal } from './reveal'

/**
 * The "open at this line" seam. The offset is the load-bearing part: the [[Derived Index]]
 * records BODY-relative lines while the editor shows the whole file, so without it every
 * [[Search]] result lands above the block it matched.
 */

describe('frontmatterLineOffset', () => {
    it('is zero when there is no frontmatter (a Server Backend document)', () => {
        expect(frontmatterLineOffset('first line\nsecond line')).toBe(0)
        expect(frontmatterLineOffset('')).toBe(0)
    })

    it('counts the fence a Filesystem Backend writes', () => {
        expect(frontmatterLineOffset('---\ntitle: Kanban\n---\nbody here')).toBe(3)
    })

    it('counts a multi-key block', () => {
        expect(frontmatterLineOffset('---\ntitle: A\naliases:\n  - B\n---\nbody')).toBe(5)
    })

    it('tolerates CRLF', () => {
        expect(frontmatterLineOffset('---\r\ntitle: A\r\n---\r\nbody')).toBe(3)
    })

    it('is zero for a fence that is not at the very start, or never closes', () => {
        // Both degrade to "no frontmatter" in parseFrontmatter, so the body is the whole
        // text and the offset must agree.
        expect(frontmatterLineOffset('intro\n---\ntitle: A\n---\nbody')).toBe(0)
        expect(frontmatterLineOffset('---\ntitle: A\nbody with no closing fence')).toBe(0)
    })

    it('is zero for a horizontal rule that only looks like a fence', () => {
        expect(frontmatterLineOffset('---\n')).toBe(0)
    })
})

describe('revealLine', () => {
    it('notifies subscribers and holds the request for a View that mounts later', () => {
        resetReveal()
        const seen: string[] = []
        const off = subscribeReveal((r) => seen.push(`${r.target}:${r.line}`))
        revealLine('Kanban', 7)

        expect(seen).toEqual(['Kanban:7'])
        expect(takeReveal('Other')).toBeNull()
        expect(takeReveal('Kanban')).toEqual({ target: 'Kanban', line: 7 })
        // Taking it clears it, so a later View does not inherit someone else's landing spot.
        expect(takeReveal('Kanban')).toBeNull()
        off()
    })

    it('does not let one failing subscriber stop the others, or the caller', () => {
        resetReveal()
        const seen: number[] = []
        const offBad = subscribeReveal(() => {
            throw new Error('this View cannot land')
        })
        const offGood = subscribeReveal((r) => seen.push(r.line))

        expect(() => revealLine('Kanban', 3)).not.toThrow()
        expect(seen).toEqual([3])
        offBad()
        offGood()
    })
})
