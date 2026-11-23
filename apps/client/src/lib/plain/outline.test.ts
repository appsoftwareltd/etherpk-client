import { describe, expect, it } from 'vitest'

import { headingTrail, headingsOf, lineOfFragment } from './outline'

const FILE = ['---', 'title: Soil', '# not a heading', '---', '# Soil', '', 'Clay holds water.', '', '## Clay soil ##', '', '```md', '# in code', '```', '', '## Clay soil', '###### Deep'].join('\n')

describe('the headings of a file', () => {
    it('lists them in order with their level and line, leaving out code and the frontmatter', () => {
        expect(headingsOf(FILE)).toEqual([
            { level: 1, text: 'Soil', line: 4, slug: 'soil' },
            { level: 2, text: 'Clay soil', line: 8, slug: 'clay-soil' },
            { level: 2, text: 'Clay soil', line: 14, slug: 'clay-soil-1' },
            { level: 6, text: 'Deep', line: 15, slug: 'deep' },
        ])
        expect(headingsOf('no headings here\n#hashtag\n')).toEqual([])
    })

    it('finds the line a link’s fragment names, whatever its case', () => {
        expect(lineOfFragment(FILE, 'clay-soil-1')).toBe(14)
        expect(lineOfFragment(FILE, 'Clay-Soil')).toBe(8)
        expect(lineOfFragment(FILE, 'sand')).toBeNull()
    })
})

describe('the headings a line is under', () => {
    const headings = headingsOf(FILE)
    const trail = (line: number) => headingTrail(headings, line).map((heading) => heading.text)

    it('is the nearest heading at or above the line, and each one above that of a lower level', () => {
        expect(trail(6)).toEqual(['Soil'])
        expect(trail(8)).toEqual(['Soil', 'Clay soil'])
        expect(trail(11)).toEqual(['Soil', 'Clay soil'])
        expect(trail(15)).toEqual(['Soil', 'Clay soil', 'Deep'])
    })

    it('is empty above the first heading and in a file with none', () => {
        expect(trail(0)).toEqual([])
        expect(headingTrail([], 3)).toEqual([])
    })

    it('skips a heading a later one of the same or a lower level has closed', () => {
        const some = headingsOf('## Beds\n### Peas\n# Tools\n### Hoes\n')
        expect(headingTrail(some, 1).map((heading) => heading.text)).toEqual(['Beds', 'Peas'])
        expect(headingTrail(some, 3).map((heading) => heading.text)).toEqual(['Tools', 'Hoes'])
    })
})
