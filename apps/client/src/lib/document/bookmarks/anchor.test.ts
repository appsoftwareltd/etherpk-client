import { describe, expect, it } from 'vitest'

import { captureAnchor, normaliseLine, resolveAnchor, similarity } from './anchor'

const lines = (text: string) => text.split('\n')

describe('normaliseLine', () => {
    it('drops indentation, a bullet marker and a task checkbox', () => {
        expect(normaliseLine('    - [ ] water the beans')).toBe('water the beans')
        expect(normaliseLine('- [x] water the beans')).toBe('water the beans')
        expect(normaliseLine('12. water the beans')).toBe('water the beans')
    })

    it('drops a heading marker so a change of level keeps the line', () => {
        expect(normaliseLine('## Garden')).toBe('Garden')
        expect(normaliseLine('### Garden')).toBe('Garden')
    })

    it('collapses runs of spaces and trims the end', () => {
        expect(normaliseLine('water   the beans  ')).toBe('water the beans')
    })

    it('is empty for a blank line', () => {
        expect(normaliseLine('   ')).toBe('')
    })
})

describe('captureAnchor', () => {
    it('records the line, its text and its nearest non-blank neighbours', () => {
        const doc = lines('# Garden\n\n- water the beans\n- dig the bed\n\n- feed the hens')
        expect(captureAnchor(doc, 3)).toEqual({
            line: 3,
            text: 'dig the bed',
            before: 'water the beans',
            after: 'feed the hens',
        })
    })

    it('leaves out a neighbour that does not exist', () => {
        const doc = lines('- water the beans\n- dig the bed')
        expect(captureAnchor(doc, 0)).toEqual({ line: 0, text: 'water the beans', after: 'dig the bed' })
    })

    it('refuses a blank line and a line outside the document', () => {
        const doc = lines('- water the beans\n\n- dig the bed')
        expect(captureAnchor(doc, 1)).toBeNull()
        expect(captureAnchor(doc, 7)).toBeNull()
    })
})

describe('resolveAnchor', () => {
    const anchorIn = (text: string, line: number) => captureAnchor(lines(text), line)!

    it('finds the line where it was', () => {
        const doc = '- water the beans\n- dig the bed'
        expect(resolveAnchor(lines(doc), anchorIn(doc, 1))).toBe(1)
    })

    it('finds the line after lines were added above it', () => {
        const anchor = anchorIn('- water the beans\n- dig the bed', 1)
        expect(resolveAnchor(lines('# Kitchen\n- wash the pans\n\n- water the beans\n- dig the bed'), anchor)).toBe(4)
    })

    it('finds the line after it was indented and its task ticked', () => {
        const anchor = anchorIn('- water the beans\n- [ ] dig the bed', 1)
        expect(resolveAnchor(lines('- water the beans\n  - [x] dig the bed'), anchor)).toBe(1)
    })

    it('tells duplicate lines apart by their neighbours', () => {
        const doc = '# Garden\n- check\n# Kitchen\n- check'
        const anchor = anchorIn(doc, 3)
        // A line added at the top moves both copies; the Kitchen one is still chosen.
        expect(resolveAnchor(lines(`- note\n${doc}`), anchor)).toBe(4)
    })

    it('takes the duplicate nearest the hint when the neighbours do not decide', () => {
        const doc = '- other\n- check\n- other\n- check\n- other\n- check\n- other'
        const anchor = anchorIn(doc, 5)
        // Every copy has the same neighbours; two lines added above leave copies at 3, 5 and 7.
        expect(resolveAnchor(lines(`- note\n- note\n${doc}`), anchor)).toBe(5)
    })

    it('finds a rewritten line that still sits between its neighbours', () => {
        const anchor = anchorIn('- water the beans\n- dig the bed\n- feed the hens', 1)
        expect(resolveAnchor(lines('- water the beans\n- rake the path\n- feed the hens'), anchor)).toBe(1)
    })

    it('finds a lightly edited line that has moved away from its neighbours', () => {
        const anchor = anchorIn('- water the beans\n- dig the bed by the shed\n- feed the hens', 1)
        const moved = '- feed the hens\n- sweep the yard\n- dig the big bed by the shed\n- water the beans'
        expect(resolveAnchor(lines(moved), anchor)).toBe(2)
    })

    it('returns null when nothing is close enough', () => {
        const anchor = anchorIn('- water the beans\n- dig the bed\n- feed the hens', 1)
        expect(resolveAnchor(lines('- paint the fence\n- mend the gate'), anchor)).toBeNull()
    })

    it('never resolves to a blank line', () => {
        const anchor = { line: 1, text: 'gone', before: 'water the beans', after: 'feed the hens' }
        expect(resolveAnchor(lines('- water the beans\n\n- feed the hens'), anchor)).toBeNull()
    })
})

describe('similarity', () => {
    it('is 1 for equal text and 0 for text with nothing in common', () => {
        expect(similarity('dig the bed', 'dig the bed')).toBe(1)
        expect(similarity('abc', 'xyz')).toBe(0)
    })

    it('ranks a light edit above an unrelated line', () => {
        expect(similarity('dig the bed', 'dig the big bed')).toBeGreaterThan(similarity('dig the bed', 'feed the hens'))
    })
})
