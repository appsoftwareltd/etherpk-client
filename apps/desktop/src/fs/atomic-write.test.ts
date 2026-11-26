import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moveToNewName, RENAME_WAITS_MS, renameWithPatience, replaceFile, type RenameStep } from './atomic-write.ts'
import { stampOf } from './stamp.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-write-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

const bytes = (text: string) => Buffer.from(text)
const failing = (codes: (string | null)[], platform: NodeJS.Platform) => {
    const waited: number[] = []
    let calls = 0
    const step: RenameStep = {
        platform,
        wait: async (ms) => { waited.push(ms) },
        rename: async () => {
            const code = codes[Math.min(calls++, codes.length - 1)]
            if (code) throw Object.assign(new Error(code), { code })
        },
    }
    return { step, waited, calls: () => calls }
}

describe('a move to a new name', () => {
    it('refuses a name another program has just taken, and leaves both files as they were', async () => {
        await writeFile(join(dir, 'beans.md'), 'mine')
        await writeFile(join(dir, 'peas.md'), 'theirs')
        await expect(moveToNewName(join(dir, 'beans.md'), join(dir, 'peas.md'))).rejects.toMatchObject({ failure: 'InvalidModificationError' })
        expect([await readFile(join(dir, 'beans.md'), 'utf8'), await readFile(join(dir, 'peas.md'), 'utf8')]).toEqual(['mine', 'theirs'])
    })
    it('leaves one name only', async () => {
        await writeFile(join(dir, 'beans.md'), 'mine')
        expect(await moveToNewName(join(dir, 'beans.md'), join(dir, 'peas.md'))).toBe(true)
        expect(await readdir(dir)).toEqual(['peas.md'])
    })
})

describe('a whole file replaced', () => {
    it('answers the stamp of the bytes it wrote', async () => {
        const stamp = await replaceFile(join(dir, 'beans.md'), bytes('water them'))
        expect(stamp).toEqual(stampOf(await stat(join(dir, 'beans.md'), { bigint: true })))
        expect(stamp.size).toBe(10)
    })
})

describe('a rename another program gets in the way of', () => {
    it('waits on Windows until the file is let go', async () => {
        const { step, waited, calls } = failing(['EPERM', 'EBUSY', 'EACCES', null], 'win32')
        await renameWithPatience('a', 'b', step)
        expect(calls()).toBe(4)
        expect(waited).toEqual(RENAME_WAITS_MS.slice(0, 3))
    })
    it('gives up after two seconds with a failure worth trying again', async () => {
        const { step, waited } = failing(['EBUSY'], 'win32')
        await expect(renameWithPatience('a', 'b', step)).rejects.toMatchObject({ failure: 'InvalidStateError' })
        expect(waited.reduce((sum, ms) => sum + ms)).toBe(2000)
    })
    it('does not wait for another failure, or on Linux', async () => {
        for (const [code, platform] of [['ENOSPC', 'win32'], ['EPERM', 'linux']] as const) {
            const { step, calls } = failing([code], platform)
            await expect(renameWithPatience('a', 'b', step)).rejects.toMatchObject({ code })
            expect(calls()).toBe(1)
        }
    })
})

describe('replacing a file', () => {
    it('leaves nothing else behind', async () => {
        await replaceFile(join(dir, 'A.md'), bytes('one'))
        await replaceFile(join(dir, 'A.md'), bytes('two'))
        expect(await readdir(dir)).toEqual(['A.md'])
        expect(await readFile(join(dir, 'A.md'), 'utf8')).toBe('two')
    })
    it('leaves the old file and no other when it is stopped before the rename', async () => {
        await writeFile(join(dir, 'A.md'), 'one')
        await expect(replaceFile(join(dir, 'A.md'), bytes('two'), { beforePlacing: async () => { throw new Error('stop') } })).rejects.toThrow('stop')
        expect(await readdir(dir)).toEqual(['A.md'])
        expect(await readFile(join(dir, 'A.md'), 'utf8')).toBe('one')
    })
    it('writes a temporary name every scan of the Client passes over', async () => {
        let names: string[] = []
        await replaceFile(join(dir, 'A.md'), bytes('x'), { beforePlacing: async () => { names = await readdir(dir) } })
        expect(names).toHaveLength(1)
        expect(names[0]).toMatch(/\.crswap$/)
    })
    it('does not take the place of a file made in the meantime', async () => {
        const path = join(dir, 'A.md')
        await expect(replaceFile(path, bytes('mine'), { onlyNew: true, beforePlacing: () => writeFile(path, 'theirs') })).rejects.toMatchObject({ failure: 'NoModificationAllowedError' })
        expect(await readFile(path, 'utf8')).toBe('theirs')
        expect(await readdir(dir)).toEqual(['A.md'])
    })
    it('refuses a folder', async () => {
        await mkdir(join(dir, 'A.md'))
        await expect(replaceFile(join(dir, 'A.md'), bytes('x'))).rejects.toMatchObject({ failure: 'TypeMismatchError' })
    })
    if (process.platform !== 'win32') {
        it('keeps the permissions, and refuses a read-only file', async () => {
            const path = join(dir, 'A.md')
            await writeFile(path, 'one')
            await chmod(path, 0o600)
            await replaceFile(path, bytes('two'))
            expect((await stat(path)).mode & 0o777).toBe(0o600)
            await chmod(path, 0o400)
            if (process.getuid?.() === 0) return
            await expect(replaceFile(path, bytes('three'))).rejects.toMatchObject({ code: 'EACCES' })
            expect(await readFile(path, 'utf8')).toBe('two')
        })
        it('is what a reader of a link sees too', async () => {
            await writeFile(join(dir, 'A.md'), 'one')
            await symlink('A.md', join(dir, 'L.md'))
            await replaceFile(join(dir, 'A.md'), bytes('two'))
            expect(await readFile(join(dir, 'L.md'), 'utf8')).toBe('two')
        })
    }
})
