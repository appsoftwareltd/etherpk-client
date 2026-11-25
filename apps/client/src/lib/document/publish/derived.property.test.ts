import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { type LlmsSection, llmsTxt } from './derived'

/**
 * `llms.txt` is read by programs that take each `- [title](url)` line as one page of the site. So
 * whatever a page's title and excerpt hold, every entry is one line, its link reads back as the
 * title and address it was given, and no entry is lost or written twice.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.DOCUMENT_FUZZ_SEED
    return { numRuns: Number(process.env.DOCUMENT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261125 : Number(seed) }
}

/** Words as a title or an excerpt can hold them: brackets, backslashes, markdown marks and line breaks. */
const words = fc.stringMatching(/^[a-z [\]()\\#*:\t\r\n\u2028-]{0,30}$/)

const sections: fc.Arbitrary<LlmsSection[]> = fc
    .array(fc.record({ title: words, entries: fc.array(fc.record({ title: words, description: words }), { maxLength: 4 }) }), { maxLength: 4 })
    // Addresses are the publisher's slugs: unique across the site, and plain.
    .map((list) => {
        let n = 0
        return list.map((section) => ({ title: section.title, entries: section.entries.map((entry) => ({ ...entry, url: `page-${n++}.html` })) }))
    })

/** The link at the start of an entry line, read as a markdown reader would: `\[`, `\]` and `\\` are literals. */
function readEntry(line: string): { title: string; url: string } | null {
    const match = /^- \[((?:\\.|[^\\\]])*)\]\(([^)\s]+)\)(?:: .*)?$/.exec(line)
    return match ? { title: match[1].replace(/\\(.)/g, '$1'), url: match[2] } : null
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

describe('llmsTxt (properties)', () => {
    it('writes each page once, on one line, with a link that reads back', () => {
        fc.assert(
            fc.property(sections, (given) => {
                const text = llmsTxt('https://garden.example.com', 'Garden Notes', given)
                const lines = text.split('\n')
                expect(text.endsWith('\n')).toBe(true)
                // Nothing but the line feed breaks a line, so a reader that splits on any of them agrees.
                expect(text).not.toMatch(/[\r\u2028\u2029]/)

                const entries = lines.filter((line) => line.startsWith('- ')).map(readEntry)
                const expected = given.flatMap((section) => section.entries).map((entry) => ({ title: oneLine(entry.title), url: `https://garden.example.com/${entry.url}` }))
                expect(entries).toEqual(expected)

                // A heading for each section that holds a page, and for no other.
                const headings = lines.filter((line) => line.startsWith('## ')).length
                expect(headings).toBe(given.filter((section) => section.entries.length > 0).length)
            }),
            fuzz(300),
        )
    })
})
