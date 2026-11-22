import { describe, expect, it } from 'vitest'

import { headingsOf, lineOfFragment } from './outline'

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
