import { describe, expect, it } from 'vitest'

import { pdfLinkMarkdown, placeAfterLink, quoteMarkdown } from './journal-write'

const NEEDLE = 'garden-guide.a1b2c3d4.pdf'

const LINK = '[Guide](../assets/garden-guide.a1b2c3d4.pdf)'

/** The text after the new line went in. */
function placed(text: string, near?: number): string | null {
    const placement = placeAfterLink(text, [NEEDLE], 'NEW', near)
    return placement && text.slice(0, placement.at) + placement.insert + text.slice(placement.at)
}

describe('writing a link after an existing reference', () => {
    it('makes a child of the bullet holding the reference', () => {
        expect(placed(`- plans\n  - see ${LINK}\n- after\n`)).toBe(`- plans\n  - see ${LINK}\n    - NEW\n- after\n`)
    })

    it('goes first among the bullet’s children, next to the reference', () => {
        expect(placed(`- see ${LINK}\n  - older\n- after`)).toBe(`- see ${LINK}\n  - NEW\n  - older\n- after`)
    })

    it('goes after the lines of the bullet’s own text', () => {
        expect(placed(`- see ${LINK}\n  more words\n  - older`)).toBe(`- see ${LINK}\n  more words\n  - NEW\n  - older`)
    })

    it('finds the bullet when the reference is on a line of its text', () => {
        expect(placed(`- plans\n  see ${LINK}\n  more words\n- after`)).toBe(`- plans\n  see ${LINK}\n  more words\n  - NEW\n- after`)
    })

    it('makes a plain child of a task, because a checkbox would make a new task', () => {
        expect(placed(`- [ ] read ${LINK}`)).toBe(`- [ ] read ${LINK}\n  - NEW`)
    })

    it('adds a new line after prose', () => {
        expect(placed(`see ${LINK} today\nmore words`)).toBe(`see ${LINK} today\nNEW\nmore words`)
    })

    it('stays inside a quote', () => {
        expect(placed(`> see ${LINK}\n> more words`)).toBe(`> see ${LINK}\n> NEW\n> more words`)
    })

    it('goes below a table rather than between its rows', () => {
        expect(placed(`| a | b |\n| - | - |\n| ${LINK} | c |\n| d | e |\nafter`)).toBe(`| a | b |\n| - | - |\n| ${LINK} | c |\n| d | e |\nNEW\nafter`)
    })

    it('uses the line the person clicked, when it still holds the reference', () => {
        expect(placed(`- first ${LINK}\n- second ${LINK}`, 2)).toBe(`- first ${LINK}\n- second ${LINK}\n  - NEW`)
    })

    it('falls back to the first reference when that line has moved', () => {
        expect(placed(`- other\n- first ${LINK}`, 1)).toBe(`- other\n- first ${LINK}\n  - NEW`)
    })

    it('leaves a reference in a code block alone', () => {
        expect(placed(`\`\`\`\n${LINK}\n\`\`\`\n- see ${LINK}`)).toBe(`\`\`\`\n${LINK}\n\`\`\`\n- see ${LINK}\n  - NEW`)
    })

    it('keeps clear of a code block in the bullet, with a blank or a bullet-like line in it', () => {
        expect(placed(`- see ${LINK}\n  \`\`\`\n  a\n\n  b\n  \`\`\`\n- after`)).toBe(`- see ${LINK}\n  \`\`\`\n  a\n\n  b\n  \`\`\`\n  - NEW\n- after`)
        expect(placed(`- see ${LINK}\n  \`\`\`\n  - item\n  \`\`\`\n- after`)).toBe(`- see ${LINK}\n  \`\`\`\n  - item\n  \`\`\`\n  - NEW\n- after`)
    })

    it('keeps clear of a bullet that opens a code block', () => {
        expect(placed(`- \`\`\`\n  - item\n  \`\`\`\n  see ${LINK}`)).toBe(`- \`\`\`\n  - item\n  \`\`\`\n  see ${LINK}\n  - NEW`)
    })

    it('finds the bullet past a blank line in its code block', () => {
        expect(placed(`- bullet\n  \`\`\`\n  a\n\n  b\n  \`\`\`\n  see ${LINK}\n  - child`)).toBe(`- bullet\n  \`\`\`\n  a\n\n  b\n  \`\`\`\n  see ${LINK}\n  - NEW\n  - child`)
    })

    it('takes the indent of the children already there, so none changes parent', () => {
        expect(placed(`- see ${LINK}\n    - older`)).toBe(`- see ${LINK}\n    - NEW\n    - older`)
    })

    it('treats a line under a heading or prose as prose, not as part of the bullet above', () => {
        expect(placed(`- a\n# Heading\n  see ${LINK}`)).toBe(`- a\n# Heading\n  see ${LINK}\n  NEW`)
        expect(placed(`- a\nprose\n  see ${LINK}`)).toBe(`- a\nprose\n  see ${LINK}\n  NEW`)
    })

    it('goes below a table in a quote, rather than between its rows', () => {
        expect(placed(`> | a |\n> | - |\n> | ${LINK} |\n> | d |`)).toBe(`> | a |\n> | - |\n> | ${LINK} |\n> | d |\n> NEW`)
    })

    it('reads the file name in inline code, or a link in it, as no reference', () => {
        expect(placed(`- see \`${NEEDLE}\`\n- ${LINK}`)).toBe(`- see \`${NEEDLE}\`\n- ${LINK}\n  - NEW`)
        expect(placed(`- see \`${LINK}\`\n- ${LINK}`)).toBe(`- see \`${LINK}\`\n- ${LINK}\n  - NEW`)
    })

    it('finds a reference whose label runs over a soft line break', () => {
        expect(placed('- [Garden\n  guide](../assets/garden-guide.a1b2c3d4.pdf)\n- after')).toBe('- [Garden\n  guide](../assets/garden-guide.a1b2c3d4.pdf)\n  - NEW\n- after')
    })

    it('leaves frontmatter alone', () => {
        expect(placed(`---\ncover: "${LINK}"\n---\n- see ${LINK}`)).toBe(`---\ncover: "${LINK}"\n---\n- see ${LINK}\n  - NEW`)
    })

    it('answers null when the link has gone', () => {
        expect(placed('- nothing here')).toBeNull()
    })
})

describe('markdown for a PDF', () => {
    it('links a page', () => {
        expect(pdfLinkMarkdown('Garden Guide', '../assets/g.pdf', 12)).toBe('[Garden Guide](../assets/g.pdf#page=12)')
    })

    it('keeps brackets out of a label, which would end the link', () => {
        expect(pdfLinkMarkdown('Garden [draft]', '../assets/g.pdf')).toBe('[Garden draft](../assets/g.pdf)')
    })

    it('quotes a passage with a link to its page', () => {
        expect(quoteMarkdown('water  the\nbeans', 'Guide', '../assets/g.pdf', 3)).toBe('- water the beans [Guide p.3](../assets/g.pdf#page=3)\n')
    })

    it('writes the link alone for a drawing, which has no words', () => {
        expect(quoteMarkdown('', 'Guide', '../assets/g.pdf', 3)).toBe('- [Guide p.3](../assets/g.pdf#page=3)\n')
    })
})
