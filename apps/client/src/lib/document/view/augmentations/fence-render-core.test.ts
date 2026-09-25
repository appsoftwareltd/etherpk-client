import { describe, expect, it } from 'vitest'

import { renderableFences } from './fence-render-core'

describe('renderableFences', () => {
    it('extracts a prose math fence with its source', () => {
        const lines = ['```math', 'E=mc^2', '\\frac{a}{b}', '```']
        expect(renderableFences(lines)).toEqual([
            { start: 0, end: 3, fenceColumn: 0, info: 'math', bulletOpener: false, source: 'E=mc^2\n\\frac{a}{b}' },
        ])
    })

    it('extracts a form-1 bullet mermaid fence and de-indents the source', () => {
        const lines = ['- ```mermaid', '  graph TD', '    A-->B', '  ```']
        expect(renderableFences(lines)).toEqual([
            { start: 0, end: 3, fenceColumn: 2, info: 'mermaid', bulletOpener: true, source: 'graph TD\n  A-->B' },
        ])
    })

    it('extracts a form-2 fence (continuation under a bullet)', () => {
        const lines = ['- diagram:', '  ```mermaid', '  graph TD', '  ```', '- next']
        const [f] = renderableFences(lines)
        expect(f).toMatchObject({ start: 1, end: 3, fenceColumn: 2, info: 'mermaid', bulletOpener: false })
        expect(renderableFences(lines)).toHaveLength(1)
    })

    it('treats a whitespace-only interior line shorter than the fence column as empty', () => {
        const lines = ['- ```math', '  a', '', '  b', '  ```']
        expect(renderableFences(lines)[0].source).toBe('a\n\nb')
    })

    it('excludes bare fences and unterminated info fences', () => {
        expect(renderableFences(['```', 'code', '```'])).toEqual([])
        expect(renderableFences(['```mermaid', 'graph TD'])).toEqual([])
    })
})
