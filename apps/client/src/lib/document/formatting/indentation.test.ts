/**
 * Indentation off the two-space grid (ADR 0109, ADR 0067): the check flags every document the
 * import boundary's normaliser would change, and its fix is that normaliser, so a fixed page reads
 * exactly as a fresh import of the same text.
 */

import { describe, expect, it } from 'vitest'

import { checkedText } from './finding'
import { indentation } from './indentation'

const find = (text: string) => indentation.find(checkedText(text))

/** The page an import made before the Indent Unit normaliser left behind: `→` in the report is a tab. */
const LOGSEQ_TABS = [
    '- [[Garden Log]]',
    '  - Keeps a row for every job in the garden',
    '    - Find the jobs for one bed:',
    '\t\t\t- ```',
    "\t\t\t  SELECT * FROM \"jobs\" WHERE bed = 'north'",
    '\t\t\t  ```',
    '    - Count the jobs',
    '\t\t\t- ```',
    '\t\t\t  SELECT 1',
    '\t\t\t  ```',
].join('\n')

describe('indentation off the two-space grid', () => {
    it('re-grids the tab-indented Logseq page as a fresh import writes it', () => {
        expect(find(LOGSEQ_TABS)).toMatchObject({
            reason: 'tabs in indentation',
            lines: [3, 4, 5, 7, 8, 9],
            fixed: [
                '- [[Garden Log]]',
                '  - Keeps a row for every job in the garden',
                '    - Find the jobs for one bed:',
                '      - ```',
                "        SELECT * FROM \"jobs\" WHERE bed = 'north'",
                '        ```',
                '    - Count the jobs',
                '      - ```',
                '        SELECT 1',
                '        ```',
            ].join('\n'),
        })
    })

    it.each([
        ['a four-space vault page', '- a\n    - b\n        - c', '- a\n  - b\n    - c'],
        ['over-nesting', '- a\n      - b', '- a\n  - b'],
        ['a list indented as a whole', '  - a\n    - b', '- a\n  - b'],
    ])('flags %s as off the two-space grid', (_name, text, fixed) => {
        expect(find(text)).toMatchObject({ fixed, reason: 'off the two-space grid' })
    })

    it('keeps a tab inside the code, and every line ending', () => {
        expect(find('- a\r\n\t- ```\r\n\t  x\ty\r\n\t  ```\r\n')?.fixed).toBe('- a\r\n  - ```\r\n    x\ty\r\n    ```\r\n')
    })

    it('leaves frontmatter alone', () => {
        expect(find('---\nlist:\n    - x\n---\n- a\n    - b')?.fixed).toBe('---\nlist:\n    - x\n---\n- a\n  - b')
    })

    it('leaves a page already on the grid', () => {
        expect(find('- a\n  - b\n    soft line\n- c')).toBeNull()
    })
})
