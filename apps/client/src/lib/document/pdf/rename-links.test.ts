import { describe, expect, it } from 'vitest'

import { linkRenameEdits, type LinkRename } from './rename-links'

const ID = 'a8a47f93-2d7d-42d0-a0cd-cd848756fcc6'

const rename: LinkRename = {
    names: (target) => target.includes(ID),
    newTarget: (target) => target.replace(/assets\/[^#]*/, `assets/shed-plan.${ID}.pdf`),
    oldNames: ['Garden Guide.pdf', 'garden-guide.pdf'],
    newName: 'Shed Plan.pdf',
}

function apply(text: string): string {
    return linkRenameEdits(text, rename).reduce((out, { from, to, insert }) => out.slice(0, from) + insert + out.slice(to), text)
}

const OLD = `../assets/garden-guide.${ID}.pdf`
const NEW = `../assets/shed-plan.${ID}.pdf`

describe('a rename, in the links to the PDF', () => {
    it('changes the path, and a label that was only the old name', () => {
        expect(apply(`- [Garden Guide.pdf](${OLD})`)).toBe(`- [Shed Plan.pdf](${NEW})`)
        expect(apply(`- [garden-guide](${OLD})`)).toBe(`- [Shed Plan](${NEW})`)
        expect(apply(`- [GARDEN GUIDE](${OLD})`)).toBe(`- [Shed Plan](${NEW})`)
    })

    it('keeps a label a person wrote', () => {
        expect(apply(`- see [the planting notes](${OLD})`)).toBe(`- see [the planting notes](${NEW})`)
    })

    it('keeps the bang an import wrote, and a link to a page', () => {
        expect(apply(`- ![Garden Guide.pdf](${OLD}#page=4)`)).toBe(`- ![Shed Plan.pdf](${NEW}#page=4)`)
    })

    it('changes every link on a line, and no other link', () => {
        expect(apply(`[a](${OLD}) and [b](../assets/other.pdf) and [c](${OLD})`)).toBe(`[a](${NEW}) and [b](../assets/other.pdf) and [c](${NEW})`)
    })

    it('has nothing to do in a document that does not link to it', () => {
        expect(linkRenameEdits('- plain text', rename)).toEqual([])
    })
})

describe('a rename, in the links to an EBook', () => {
    const book: LinkRename = {
        names: (target) => target.includes('garden-notes'),
        newTarget: (target) => target.replace('garden-notes', 'shed-notes'),
        oldNames: ['Garden Notes.epub'],
        newName: 'Shed Notes.epub',
    }
    const renamed = (text: string) => linkRenameEdits(text, book).reduce((out, { from, to, insert }) => out.slice(0, from) + insert + out.slice(to), text)

    it('changes a label that was only the old name, with or without its extension', () => {
        expect(renamed('[Garden Notes.epub](../assets/garden-notes.a1.epub)')).toBe('[Shed Notes.epub](../assets/shed-notes.a1.epub)')
        expect(renamed('[Garden Notes](../assets/garden-notes.a1.epub)')).toBe('[Shed Notes](../assets/shed-notes.a1.epub)')
    })

    it('keeps a place in the EBook, and a label a person wrote', () => {
        const place = '#cfi=epubcfi%28%2F6%2F4%21%29'
        expect(renamed(`[the good part](../assets/garden-notes.a1.epub${place})`)).toBe(`[the good part](../assets/shed-notes.a1.epub${place})`)
    })
})
