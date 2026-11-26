import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FolderFiles } from './folder-files.ts'

let scratch: string
let folder: string
const files = new FolderFiles()
const bytes = (text: string) => new TextEncoder().encode(text)
const text = (read: { bytes: Uint8Array }) => new TextDecoder().decode(read.bytes)
async function put(path: string, content: string) {
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), content)
}

beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'etherpk-files-'))
    folder = join(scratch, 'Notes')
    await mkdir(folder)
})
afterEach(() => rm(scratch, { recursive: true, force: true }))

describe.skipIf(process.platform === 'win32')('links', () => {
    it('inside the folder are followed, and writing through one keeps it', async () => {
        await put('pages/A.md', 'one')
        await symlink('pages/A.md', join(folder, 'L.md'))
        await symlink('pages', join(folder, 'also'))
        expect(await files.list(folder, '', false)).toEqual(expect.arrayContaining([{ name: 'L.md', kind: 'file' }, { name: 'also', kind: 'directory' }]))
        await files.write(folder, 'L.md', bytes('two'), {})
        expect(await readFile(join(folder, 'pages/A.md'), 'utf8')).toBe('two')
        expect((await readdir(folder, { withFileTypes: true })).find((entry) => entry.name === 'L.md')?.isSymbolicLink()).toBe(true)
        expect(text(await files.read(folder, 'also/A.md'))).toBe('two')
    })
    it('that lead out, or nowhere, are not listed and not opened', async () => {
        await writeFile(join(scratch, 'secret.md'), 'secret')
        await symlink('../secret.md', join(folder, 'out.md'))
        await symlink('nowhere.md', join(folder, 'dangling.md'))
        expect(await files.list(folder, '', true)).toEqual([])
        for (const path of ['out.md', 'dangling.md']) {
            await expect(files.read(folder, path)).rejects.toMatchObject({ failure: 'SecurityError' })
            await expect(files.write(folder, path, bytes('x'), {})).rejects.toMatchObject({ failure: 'SecurityError' })
            await expect(files.stat(folder, path)).rejects.toMatchObject({ failure: 'SecurityError' })
        }
        expect(await files.readMany(folder, ['out.md', 'dangling.md'])).toEqual([null, null])
        expect(await readFile(join(scratch, 'secret.md'), 'utf8')).toBe('secret')
    })
    it('are what remove and move act on, never what they lead to', async () => {
        await writeFile(join(scratch, 'secret.md'), 'secret')
        await mkdir(join(scratch, 'Elsewhere'))
        await writeFile(join(scratch, 'Elsewhere/kept.md'), 'kept')
        await symlink('../secret.md', join(folder, 'out.md'))
        await symlink('../Elsewhere', join(folder, 'dir'))
        await files.move(folder, 'out.md', 'moved.md')
        await files.remove(folder, 'moved.md')
        await files.remove(folder, 'dir')
        expect(await readdir(folder)).toEqual([])
        expect(await readFile(join(scratch, 'secret.md'), 'utf8')).toBe('secret')
        expect(await readdir(join(scratch, 'Elsewhere'))).toEqual(['kept.md'])
    })
    it('back up do not make a walk go round', async () => {
        await put('pages/A.md', 'one')
        await symlink('..', join(folder, 'pages/up'))
        expect(await files.walk(folder, '', [], 100)).toEqual({ files: ['pages/A.md'], truncated: false })
    })
    it('property: no path through any link reaches a file outside', async () => {
        await writeFile(join(scratch, 'secret.md'), 'secret')
        await put('a/b/in.md', 'in')
        for (const [at, target] of [['a/up', '../..'], ['a/b/root', '/'], ['out', '..'], ['a/loop', '.'], ['a/abs', scratch], ['self', 'self']]) await symlink(target, join(folder, at))
        const part = fc.constantFrom('a', 'b', 'up', 'root', 'out', 'loop', 'abs', 'self', 'Notes', 'secret.md', 'in.md', 'new.md', scratch.slice(1))
        await fc.assert(fc.asyncProperty(fc.array(part, { minLength: 1, maxLength: 6 }), async (parts) => {
            const path = parts.join('/')
            const read = await files.read(folder, path).then(text, () => null)
            expect(read).not.toBe('secret')
            await files.write(folder, path, bytes('written'), { createDirectories: true }).catch(() => {})
            await files.remove(folder, path).catch(() => {})
            expect((await readdir(scratch)).sort()).toEqual(['Notes', 'secret.md'])
            expect(await readFile(join(scratch, 'secret.md'), 'utf8')).toBe('secret')
        }), { seed: 20261125, numRuns: 300 })
    })
})

describe('what is not a document', () => {
    it.skipIf(process.platform !== 'linux')('a named pipe is not listed, and reading it does not wait', async () => {
        execFileSync('mkfifo', [join(folder, 'pipe')])
        expect(await files.list(folder, '', true)).toEqual([])
        await expect(files.read(folder, 'pipe')).rejects.toMatchObject({ failure: 'NotReadableError' })
    })
    it('a temporary file of the app is passed over, and cleared when it is old', async () => {
        await put('.etherpk-aa.crswap', 'half')
        await put('.etherpk-bb.crswap', 'half')
        await put('pages.md.crswap', 'of the browser, which clears its own')
        await utimes(join(folder, '.etherpk-aa.crswap'), 1, 1)
        await utimes(join(folder, 'pages.md.crswap'), 1, 1)
        expect(await files.list(folder, '', true)).toEqual([])
        expect((await readdir(folder)).sort()).toEqual(['.etherpk-bb.crswap', 'pages.md.crswap'])
    })
})

describe('moving', () => {
    it('changes only the case of a name', async () => {
        await put('garden.md', 'one')
        await files.move(folder, 'garden.md', 'Garden.md')
        expect(await readdir(folder)).toEqual(['Garden.md'])
    })
    it.skipIf(process.platform !== 'linux')('does not take two hard links that differ in case for one file', async () => {
        await put('garden.md', 'one')
        await link(join(folder, 'garden.md'), join(folder, 'Garden.md'))
        await expect(files.move(folder, 'garden.md', 'Garden.md')).rejects.toMatchObject({ failure: 'InvalidModificationError' })
        expect((await readdir(folder)).sort()).toEqual(['Garden.md', 'garden.md'])
    })
    it('never replaces, however many moves race for one name', async () => {
        for (const name of ['a', 'b', 'c', 'd']) await put(`${name}.md`, name)
        const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((name) => files.move(folder, `${name}.md`, 'to.md')))
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(await readdir(folder)).toHaveLength(4)
    })
})

describe('two writers at once', () => {
    it('only one write made on the same stamp is taken', async () => {
        await put('A.md', 'start')
        const { lastModified, size } = await files.read(folder, 'A.md')
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => files.write(folder, 'A.md', bytes(`writer ${n}, longer`), { ifStamp: { lastModified, size } })))
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected').every((result) => (result as PromiseRejectedResult).reason.failure === 'NoModificationAllowedError')).toBe(true)
    })
    it('only one of those who found it absent creates it', async () => {
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => files.write(folder, 'new/A.md', bytes(String(n)), { ifStamp: 'absent', createDirectories: true })))
        const won = results.findIndex((result) => result.status === 'fulfilled')
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(text(await files.read(folder, 'new/A.md'))).toBe(String(won))
    })
    it('a reader never sees a mixture', async () => {
        const [a, b] = ['a'.repeat(300_000), 'b'.repeat(200_000)]
        await put('A.md', a)
        let writing = true
        const writer = (async () => {
            for (let n = 0; n < 40; n++) await files.write(folder, 'A.md', bytes(n % 2 ? a : b), {})
            writing = false
        })()
        while (writing) {
            const read = await files.read(folder, 'A.md')
            expect([a, b]).toContain(text(read))
            expect(read.size).toBe(read.bytes.length)
        }
        await writer
    })
    it('a stamp from a write is the stamp in the next listing', async () => {
        const stamp = await files.write(folder, 'A.md', bytes('one'), {})
        expect(await files.list(folder, '', true)).toEqual([{ name: 'A.md', kind: 'file', ...stamp }])
        expect(Number.isInteger(stamp.lastModified)).toBe(true)
        await utimes(join(folder, 'A.md'), 1789733878.454, 1789733878.454)
        const [listed] = await files.list(folder, '', true)
        expect(await files.stat(folder, 'A.md')).toMatchObject({ lastModified: listed.lastModified })
    })
})

describe('a folder that goes', () => {
    it('is NotFoundError and is never made again', async () => {
        await put('A.md', 'one')
        await rename(folder, `${folder} moved`)
        // Each call starts only when it is awaited: started together, one that refuses before the loop
        // reaches it is an unhandled rejection, which fails the run on a slower machine.
        const calls = [
            () => files.list(folder, '', false),
            () => files.read(folder, 'A.md'),
            () => files.write(folder, 'A.md', bytes('x'), { createDirectories: true }),
            () => files.createDirectory(folder, 'pages'),
            () => files.remove(folder, 'A.md'),
        ]
        for (const call of calls) {
            await expect(call()).rejects.toMatchObject({ failure: 'NotFoundError' })
        }
        expect(await readdir(scratch)).toEqual(['Notes moved'])
    })
})

it('a file in a path of directories is a mismatch when one would be made there', async () => {
    await put('A.md', 'one')
    await expect(files.write(folder, 'A.md/B.md', bytes('x'), { createDirectories: true })).rejects.toMatchObject({ failure: 'TypeMismatchError' })
    await expect(files.createDirectory(folder, 'A.md/pages')).rejects.toMatchObject({ failure: 'TypeMismatchError' })
    await expect(files.read(folder, 'A.md/B.md')).rejects.toMatchObject({ code: 'ENOENT' }).catch(async () => {
        // ENOTDIR on a computer that says so. Both are NotFoundError to the page.
        await expect(files.read(folder, 'A.md/B.md')).rejects.toMatchObject({ code: 'ENOTDIR' })
    })
})
