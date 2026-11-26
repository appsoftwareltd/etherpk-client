import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isInside } from './places.ts'

const RUNS = Number(process.env.DESKTOP_PROPERTY_RUNS ?? 500)
const name = fc.stringMatching(/^[A-Za-z0-9 ._-]{1,8}$/).filter((one) => one !== '.' && one !== '..')

describe('a path inside a folder', () => {
    it('property: is the folder or below it, and never a sibling that starts the same', () => {
        fc.assert(fc.property(fc.array(name, { minLength: 1, maxLength: 4 }), fc.array(name, { maxLength: 3 }), name, (root, below, extra) => {
            const folder = `/${root.join('/')}`
            expect(isInside(folder, [folder, ...below].join('/'), 'linux')).toBe(true)
            // "/notes" does not hold "/notes2".
            expect(isInside(folder, `${folder}${extra}`, 'linux')).toBe(false)
            expect(isInside(`${folder}/`, `${folder}/${extra}`, 'linux')).toBe(true)
        }), { seed: 20261126, numRuns: RUNS })
    })

    it('property: on Windows, whatever the case, and with its own separator', () => {
        fc.assert(fc.property(fc.array(name, { minLength: 1, maxLength: 4 }), fc.array(name, { maxLength: 3 }), name, (root, below, extra) => {
            const folder = `C:\\${root.join('\\')}`
            const inside = [folder, ...below].join('\\')
            expect(isInside(folder, inside.toUpperCase(), 'win32')).toBe(true)
            expect(isInside(folder.toLowerCase(), inside, 'win32')).toBe(true)
            expect(isInside(folder, `${folder}${extra}`, 'win32')).toBe(false)
            // A forward slash is not Windows' separator in a real path, so it does not join a folder to what is below it.
            expect(isInside(folder, `${folder}/${extra}`, 'win32')).toBe(false)
        }), { seed: 20261126, numRuns: RUNS })
    })

    it('on Linux, keeps case', () => {
        expect(isInside('/home/someone/Notes', '/home/someone/notes/a.md', 'linux')).toBe(false)
        expect(isInside('/home/someone/Notes', '/home/someone/Notes/a.md', 'linux')).toBe(true)
    })
})
