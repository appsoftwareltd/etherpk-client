import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isWindowsSafeName } from '../fs/names.ts'
import { offeredName, Saves } from './saves.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-saves-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))
const bytes = (text: string) => Buffer.from(text)

describe('saving a copy', () => {
    it('leaves what was there when its window goes', async () => {
        await writeFile(join(dir, 'a.txt'), 'before')
        const saves = new Saves()
        const { save } = await saves.open(1, join(dir, 'a.txt'))
        await saves.write(1, save, bytes('after'))
        await saves.release(1)
        expect(await readdir(dir)).toEqual(['a.txt'])
        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('before')
        await expect(saves.write(1, save, bytes('x'))).rejects.toMatchObject({ failure: 'NotFoundError' })
    })
    it('is another window’s business only by its own', async () => {
        const saves = new Saves()
        const { save } = await saves.open(1, join(dir, 'a.txt'))
        await expect(saves.write(2, save, bytes('x'))).rejects.toMatchObject({ failure: 'NotFoundError' })
        await expect(saves.commit(2, save)).rejects.toMatchObject({ failure: 'NotFoundError' })
        await saves.abort(2, save)
        await saves.release(2)
        await saves.commit(1, save)
        expect(await readdir(dir)).toEqual(['a.txt'])
    })
    it('writes the parts in the order sent, and commits after them', async () => {
        const saves = new Saves()
        const { save } = await saves.open(1, join(dir, 'a.txt'))
        const parts = Array.from({ length: 50 }, (_, n) => `${n} `)
        const writing = parts.map((part) => saves.write(1, save, bytes(part)))
        await saves.commit(1, save)
        await Promise.all(writing)
        expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe(parts.join(''))
    })
    it('leaves nothing behind when the place is taken by a folder', async () => {
        await mkdir(join(dir, 'a.txt'))
        const saves = new Saves()
        const { save } = await saves.open(1, join(dir, 'a.txt'))
        await expect(saves.commit(1, save)).rejects.toThrow()
        expect(await readdir(dir)).toEqual(['a.txt'])
    })
    it('property: the name offered is one name, on any system', () => {
        fc.assert(fc.property(fc.string({ maxLength: 60 }), (text) => {
            const name = offeredName(text)
            for (const character of ['/', '\\', '\0']) expect(name).not.toContain(character)
            expect(name.length).toBeGreaterThan(0)
            if (!/^(con|prn|aux|nul|com\d|lpt\d)/i.test(name)) expect(isWindowsSafeName(name)).toBe(true)
        }), { seed: 20261125, numRuns: 1000 })
        expect(offeredName('../../.bashrc')).toBe('bashrc')
        expect(offeredName('My notes.zip')).toBe('My notes.zip')
    })
})
