import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isWindowsSafeName, segmentsOf, shownName } from './names.ts'

describe('names Windows does not allow', () => {
    for (const name of ['a:b', 'C:', 'note.md:stream', 'CON', 'con.txt', 'nul .txt', 'COM1', 'lpt9.md', 'COM¹.md', 'a.', 'a ', 'a?', 'a*b', 'a"b', 'a|b', '<a>', 'CONIN$']) {
        it(`refuses ${JSON.stringify(name)}`, () => {
            expect(isWindowsSafeName(name)).toBe(false)
            expect(() => segmentsOf(`pages/${name}`, 'win32')).toThrow('Windows does not allow')
            // The same names are ordinary on Linux, but for what is refused everywhere.
            expect(segmentsOf(`pages/${name}`, 'linux')).toEqual(['pages', name])
        })
    }
    for (const name of ['console.md', 'com.md', 'com10.md', 'a.b.md', '.gitignore', 'nulls', 'Réunion.md']) {
        it(`allows ${name}`, () => expect(isWindowsSafeName(name)).toBe(true))
    }
})

describe('paths', () => {
    it('are composed, so one page has one name', () => {
        expect(segmentsOf('pages/Café.md', 'linux')).toEqual(['pages', 'Café.md'])
    })
    it('property: what comes back never climbs, on either platform', () => {
        fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.constantFrom<NodeJS.Platform>('win32', 'linux'), (path, platform) => {
            let segments: string[]
            try {
                segments = segmentsOf(path, platform)
            } catch {
                return
            }
            for (const segment of segments) {
                expect(segment).not.toBe('..')
                expect(segment).not.toMatch(/[\\/]/)
                if (platform === 'win32') expect(segment).not.toContain(':')
            }
        }), { seed: 20261125, numRuns: 2000 })
    })
})

describe('names on disk as the page is told them', () => {
    it('composes', () => expect(shownName('Café.md')).toBe('Café.md'))
    it('leaves out what the page could not ask for', () => {
        for (const name of ['a\\b.md', 'a\nb', '�.md', '.etherpk-00.crswap', 'A.md.CRSWAP']) expect(shownName(name)).toBe(null)
    })
})
