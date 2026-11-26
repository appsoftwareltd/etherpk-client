/**
 * What every shell's port must do, as a suite any implementation runs: the in-memory port here,
 * Electron's in apps/desktop, and as a list to port for Android's, whose tests are Kotlin.
 *
 * The suite is given its test functions, so it belongs to no runner. It reaches the port only through
 * `call` and `on`, and the disk behind it only through {@link ContractDisk}, which is another program
 * as far as the shell is concerned.
 *
 * What the interface leaves open and this settles:
 * - A path that could leave the folder is a `SecurityError`, and so is changing the chosen folder itself.
 * - An id the shell did not issue, or has forgotten, is a `NotAllowedError`.
 * - A chosen folder that is gone is a `NotFoundError` from every `fs` call, so that it is never read as a
 *   folder with nothing in it, and no call creates it again.
 * - `fs.walk` answers paths from the chosen folder, as every other call takes them.
 */
import fc from 'fast-check'

import { checkedRelativePath, isSyncServerOrigin, type FileInfo, type FolderId, type FolderInfo, NATIVE_METHODS, type NativeArgs, type NativeEvents, type NativeMethod, type NativePort, type NativeResult } from './index.ts'

/** The disk as another program sees it. Paths are from a scratch directory of the suite's own. */
export interface ContractDisk {
    /** Create or replace a file, and the directories it needs, with the name exactly as given. */
    write(path: string, text: string): Promise<void> | void
    /** A file's text, or null when it is not there. */
    read(path: string): Promise<string | null> | string | null
    makeDirectory(path: string): Promise<void> | void
    remove(path: string): Promise<void> | void
    /** The names directly inside a directory, as the disk stores them. */
    names(path: string): Promise<string[]> | string[]
    /** Make a link at `path` to `target`, both from the scratch directory. Left out where there are no links. */
    link?(path: string, target: string): Promise<void> | void
}

export interface ContractHarness {
    port: NativePort
    disk: ContractDisk
    /** The folder dialog is open and the person chooses this directory, or cancels. Called before the pick. */
    answerFolder(path: string | null): Promise<void> | void
    /** The same for the save dialog. Left out, the suite leaves out the save calls. */
    answerSave?(path: string | null): Promise<void> | void
    /** Give the app one file, as the file manager does. Left out, the suite leaves out the `files` calls. */
    openFile?(path: string): Promise<FileInfo> | FileInfo
    /** The disk meets names whatever their case. */
    ignoresCase: boolean
    /** Whether a name given to the disk decomposed stays decomposed. False on a volume that composes. Default true. */
    keepsNameForm?: boolean
    dispose(): Promise<void> | void
}

/** The test functions the suite needs, as Vitest has them. */
export interface ContractRunner {
    describe(name: string, body: () => void): void
    it(name: string, body: () => Promise<void>, timeout?: number): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatever the runner's matchers are
    expect: any
}

type Call = <M extends NativeMethod>(method: M, args: NativeArgs<M>) => Promise<NativeResult<M>>
type Suite = (runner: ContractRunner, makeHarness: () => Promise<ContractHarness> | ContractHarness) => void

/** Paths that must be refused wherever they are sent. */
export const HOSTILE_PATHS = [
    '..', '../outside.md', 'pages/../../outside.md', 'pages/..', './pages', 'pages/.', '/etc/hosts', '//server/share',
    'pages//a.md', 'pages/', 'a\\b.md', '..\\outside.md', 'C:\\outside.md', 'a\u0000.md', 'a\nb.md', 'a\u001f', '/',
]

/** A path built from parts that are each one way out, or an ordinary name. Most are refused and some are not. */
const hostilePath = fc
    .array(fc.oneof({ weight: 3, arbitrary: fc.constantFrom('..', '.', '', '\\', '..\\', '\u0000', '/', 'a\u0007b') }, { weight: 2, arbitrary: fc.constantFrom('pages', 'A.md', 'ü') }), { minLength: 1, maxLength: 6 })
    .map((parts) => parts.join('/'))
    .filter((path) => path !== '' && checkedRelativePath(path) === null)

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

interface World extends ContractHarness {
    call: Call
    folder: FolderInfo
    id: FolderId
    /** The name a call was refused with, or 'nothing' when it was answered. */
    refusal<M extends NativeMethod>(method: M, args: NativeArgs<M>): Promise<string>
    file(path: string, content: string): Promise<void>
}

/** Every `fs` call with a path in it, for `path` in `folder`. */
function callsWithPath(folder: FolderId, path: string): [NativeMethod, NativeArgs<NativeMethod>][] {
    return [
        ['fs.list', { folder, path, stamps: false }],
        ['fs.stat', { folder, path }],
        ['fs.canonicalPath', { folder, path }],
        ['fs.read', { folder, path }],
        ['fs.readMany', { folder, paths: [path] }],
        ['fs.write', { folder, path, bytes: bytes('x'), createDirectories: true }],
        ['fs.createDirectory', { folder, path }],
        ['fs.remove', { folder, path }],
        ['fs.move', { folder, from: path, to: 'there.md' }],
        ['fs.move', { folder, from: 'pages/A.md', to: path }],
        ['fs.walk', { folder, path, skip: [], limit: 10 }],
        ['folders.child', { folder, path }],
    ]
}

export const nativePortContract: Suite = (runner, makeHarness) => {
    const { describe, expect, it } = runner

    /** A world of its own for one test: a folder at `Notes`, with one page in it, beside a file the app was never given. */
    function test(name: string, body: (world: World) => Promise<void>, timeout?: number): void {
        it(name, async () => {
            const harness = await makeHarness()
            try {
                const call: Call = async (method, args) => {
                    const reply = await harness.port.call(method, args)
                    if (!reply.ok) throw Object.assign(new Error(`${method}: ${reply.message}`), { name: reply.name })
                    return reply.value as never
                }
                await harness.disk.write('outside.md', 'not the app’s')
                await harness.disk.write('Notes/pages/A.md', 'one')
                await harness.answerFolder('Notes')
                const folder = await call('folders.pick', {})
                await body({
                    ...harness,
                    call,
                    folder,
                    id: folder.id,
                    async refusal(method, args) {
                        const reply = await harness.port.call(method, args)
                        return reply.ok ? 'nothing' : reply.name
                    },
                    file: async (path, content) => { await harness.disk.write(`Notes/${path}`, content) },
                })
            } finally {
                await harness.dispose()
            }
        }, timeout)
    }

    describe('what the shell says of itself', () => {
        test('a Sync Server it hands the page is an origin the page may reach, or nothing', async ({ port }) => {
            const { syncServer } = port.info
            expect(syncServer === undefined || syncServer === null || isSyncServerOrigin(syncServer)).toBe(true)
        })
    })

    describe('folders', () => {
        test('a chosen folder has its own name and an id that says nothing about where it is', async ({ folder }) => {
            expect(folder.name).toBe('Notes')
            expect(folder.id).not.toContain('Notes')
            expect(folder.displayPath === null || folder.displayPath.includes('Notes')).toBe(true)
        })

        test('a cancelled dialog is an AbortError', async ({ answerFolder, refusal }) => {
            await answerFolder(null)
            expect(await refusal('folders.pick', {})).toBe('AbortError')
        })

        test('get answers the folder, and null once it is gone', async ({ call, disk, folder, id }) => {
            expect(await call('folders.get', { folder: id })).toEqual(folder)
            await disk.remove('Notes')
            expect(await call('folders.get', { folder: id })).toBe(null)
        })

        test('a folder that is gone is NotFoundError, never empty, and nothing makes it again', async ({ call, disk, id, refusal }) => {
            await disk.remove('Notes')
            for (const [method, args] of callsWithPath(id, 'pages')) expect([method, await refusal(method, args)]).toEqual([method, 'NotFoundError'])
            expect(await refusal('fs.list', { folder: id, path: '', stamps: true })).toBe('NotFoundError')
            expect(await refusal('fs.createDirectory', { folder: id, path: '' })).toBe('NotFoundError')
            expect(await call('folders.get', { folder: id })).toBe(null)
        })

        test('an id the shell did not issue is refused, and get answers null', async ({ call, refusal }) => {
            for (const folder of ['made-up', '', '../Notes', '/']) {
                expect(await call('folders.get', { folder })).toBe(null)
                expect(await refusal('fs.list', { folder, path: '', stamps: false })).toBe('NotAllowedError')
                expect(await refusal('fs.write', { folder, path: 'A.md', bytes: bytes('x') })).toBe('NotAllowedError')
            }
        })

        test('a forgotten folder is refused and its files are untouched', async ({ call, disk, id, refusal }) => {
            await call('folders.forget', { folder: id })
            expect(await call('folders.get', { folder: id })).toBe(null)
            expect(await refusal('fs.read', { folder: id, path: 'pages/A.md' })).toBe('NotAllowedError')
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
        })

        test('relation knows one folder chosen twice, a folder inside another, and two apart', async ({ answerFolder, call, disk, id }) => {
            const pick = async (path: string) => {
                await disk.makeDirectory(path)
                await answerFolder(path)
                return (await call('folders.pick', {})).id
            }
            const again = await pick('Notes')
            const inside = await pick('Notes/a/b')
            const beside = await pick('Notes and more')
            expect(await call('folders.relation', { a: id, b: again })).toEqual({ same: true, path: [] })
            expect(await call('folders.relation', { a: id, b: inside })).toEqual({ same: false, path: ['a', 'b'] })
            expect(await call('folders.relation', { a: inside, b: id })).toEqual({ same: false, path: null })
            expect(await call('folders.relation', { a: id, b: beside })).toEqual({ same: false, path: null })
        })

        test('child is a folder of its own, confined to itself', async ({ call, id, refusal }) => {
            const child = await call('folders.child', { folder: id, path: 'pages' })
            expect(child.name).toBe('pages')
            expect(text((await call('fs.read', { folder: child.id, path: 'A.md' })).bytes)).toBe('one')
            expect(await refusal('fs.read', { folder: child.id, path: '../pages/A.md' })).toBe('SecurityError')
            expect(await call('folders.relation', { a: id, b: child.id })).toEqual({ same: false, path: ['pages'] })
        })

        test('child refuses what is not a directory', async ({ id, refusal }) => {
            expect(await refusal('folders.child', { folder: id, path: 'pages/A.md' })).toBe('TypeMismatchError')
            expect(await refusal('folders.child', { folder: id, path: 'nowhere' })).toBe('NotFoundError')
        })
    })

    describe('reading', () => {
        test('list names files and directories, with whole-number stamps when asked', async ({ call, file, id }) => {
            await file('b.md', 'two')
            const listed = await call('fs.list', { folder: id, path: '', stamps: true })
            const entries = new Map(listed.map((entry) => [entry.name, entry]))
            expect([...entries.keys()].sort()).toEqual(['b.md', 'pages'])
            expect(entries.get('pages')?.kind).toBe('directory')
            expect(entries.get('b.md')).toMatchObject({ kind: 'file', size: 3 })
            expect(Number.isInteger(entries.get('b.md')?.lastModified)).toBe(true)
            expect((await call('fs.list', { folder: id, path: 'pages', stamps: false })).map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: 'A.md', kind: 'file' }])
        })

        test('list, stat and read agree on a file’s stamp', async ({ call, id }) => {
            const [listed] = await call('fs.list', { folder: id, path: 'pages', stamps: true })
            const stamp = { lastModified: listed.lastModified, size: listed.size }
            expect(await call('fs.stat', { folder: id, path: 'pages/A.md' })).toEqual({ kind: 'file', ...stamp })
            expect(await call('fs.read', { folder: id, path: 'pages/A.md' })).toMatchObject(stamp)
            expect((await call('fs.readMany', { folder: id, paths: ['pages/A.md'] }))[0]).toMatchObject(stamp)
        })

        test('stat answers a directory, the folder itself, and null for nothing', async ({ call, id }) => {
            expect(await call('fs.stat', { folder: id, path: 'pages' })).toEqual({ kind: 'directory' })
            expect(await call('fs.stat', { folder: id, path: '' })).toEqual({ kind: 'directory' })
            expect(await call('fs.stat', { folder: id, path: 'pages/B.md' })).toBe(null)
            expect(await call('fs.stat', { folder: id, path: 'pages/A.md/under a file' })).toBe(null)
        })

        test('what is not there is NotFoundError, and the wrong kind is TypeMismatchError', async ({ id, refusal }) => {
            expect(await refusal('fs.read', { folder: id, path: 'pages/B.md' })).toBe('NotFoundError')
            expect(await refusal('fs.list', { folder: id, path: 'nowhere', stamps: false })).toBe('NotFoundError')
            expect(await refusal('fs.read', { folder: id, path: 'pages' })).toBe('TypeMismatchError')
            expect(await refusal('fs.list', { folder: id, path: 'pages/A.md', stamps: false })).toBe('TypeMismatchError')
        })

        test('readMany answers in the order asked, with null for one that is not there', async ({ call, file, id }) => {
            await file('b.md', 'two')
            const read = await call('fs.readMany', { folder: id, paths: ['b.md', 'nowhere.md', 'pages/A.md', 'b.md'] })
            expect(read.map((one) => (one === null ? null : text(one.bytes)))).toEqual(['two', null, 'one', 'two'])
            expect(await call('fs.readMany', { folder: id, paths: [] })).toEqual([])
        })

        test('bytes survive as they are', async ({ call, id }) => {
            const every = new Uint8Array(256).map((_, index) => index)
            await call('fs.write', { folder: id, path: 'every.bin', bytes: every })
            expect([...(await call('fs.read', { folder: id, path: 'every.bin' })).bytes]).toEqual([...every])
            await call('fs.write', { folder: id, path: 'empty.bin', bytes: new Uint8Array() })
            expect((await call('fs.read', { folder: id, path: 'empty.bin' })).size).toBe(0)
        })

        test('walk answers every file from the folder, skips names at any depth and says when it stopped', async ({ call, file, id }) => {
            for (const path of ['a/b/c.md', 'a/skip/no.md', 'skip/no.md', 'd.md']) await file(path, 'x')
            const all = await call('fs.walk', { folder: id, path: '', skip: ['skip'], limit: 100 })
            expect(all.files.toSorted()).toEqual(['a/b/c.md', 'd.md', 'pages/A.md'])
            expect(all.truncated).toBe(false)
            expect(await call('fs.walk', { folder: id, path: 'a', skip: ['skip'], limit: 100 })).toEqual({ files: ['a/b/c.md'], truncated: false })
            const some = await call('fs.walk', { folder: id, path: '', skip: [], limit: 2 })
            expect(some.files).toHaveLength(2)
            expect(some.truncated).toBe(true)
            expect((await call('fs.walk', { folder: id, path: 'a', skip: ['skip'], limit: 1 })).truncated).toBe(false)
        })
    })

    describe('names', () => {
        test('walk answers each path as the disk spells it', async ({ call, file, id }) => {
            await file('Sub Folder/Mixed Case.MD', 'x')
            const { files } = await call('fs.walk', { folder: id, path: '', skip: [], limit: 10 })
            expect(files.toSorted()).toEqual(['Sub Folder/Mixed Case.MD', 'pages/A.md'])
        })

        test('canonicalPath is the disk’s own spelling', async ({ call, id, ignoresCase }) => {
            expect(await call('fs.canonicalPath', { folder: id, path: 'pages/A.md' })).toBe('pages/A.md')
            expect(await call('fs.canonicalPath', { folder: id, path: 'pages/B.md' })).toBe(null)
            expect(await call('fs.canonicalPath', { folder: id, path: '' })).toBe('')
            expect(await call('fs.canonicalPath', { folder: id, path: 'PAGES/a.MD' })).toBe(ignoresCase ? 'pages/A.md' : null)
        })

        test('a decomposed name on disk is listed composed, reached composed, and never joined by a second file', async ({ call, disk, file, id, keepsNameForm }) => {
            const [composed, decomposed] = ['Café.md', 'Café.md'.normalize('NFD')]
            await file(decomposed, 'before')
            expect((await call('fs.list', { folder: id, path: '', stamps: false })).map((entry) => entry.name).sort()).toEqual([composed, 'pages'].sort())
            expect(await call('fs.canonicalPath', { folder: id, path: composed })).toBe(composed)
            expect(text((await call('fs.read', { folder: id, path: composed })).bytes)).toBe('before')
            expect((await call('fs.readMany', { folder: id, paths: [composed] }))[0]).not.toBe(null)
            await call('fs.write', { folder: id, path: composed, bytes: bytes('after') })
            const stored = keepsNameForm === false ? composed : decomposed
            expect((await disk.names('Notes')).toSorted()).toEqual([stored, 'pages'].toSorted())
            expect((await call('fs.walk', { folder: id, path: '', skip: [], limit: 10 })).files.toSorted()).toEqual([composed, 'pages/A.md'].toSorted())
            await call('fs.remove', { folder: id, path: composed })
            expect(await disk.names('Notes')).toEqual(['pages'])
        })

        test('a decomposed directory is walked through too', async ({ call, file, id }) => {
            await file(`${'Été'.normalize('NFD')}/note.md`, 'x')
            expect(text((await call('fs.read', { folder: id, path: 'Été/note.md' })).bytes)).toBe('x')
            expect((await call('fs.list', { folder: id, path: 'Été', stamps: false })).map((entry) => entry.name)).toEqual(['note.md'])
        })
    })

    describe('writing', () => {
        test('write answers the stamp the next listing gives', async ({ call, id }) => {
            for (const content of ['a', 'a much longer note', '']) {
                const stamp = await call('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes(content) })
                const [listed] = await call('fs.list', { folder: id, path: 'pages', stamps: true })
                expect(stamp).toEqual({ lastModified: listed.lastModified, size: listed.size })
                expect(stamp.size).toBe(content.length)
            }
        })

        test('write needs the directory unless told to create it', async ({ call, disk, id, refusal }) => {
            expect(await refusal('fs.write', { folder: id, path: 'a/b/c.md', bytes: bytes('x') })).toBe('NotFoundError')
            expect(await disk.read('Notes/a/b/c.md')).toBe(null)
            await call('fs.write', { folder: id, path: 'a/b/c.md', bytes: bytes('x'), createDirectories: true })
            expect(await disk.read('Notes/a/b/c.md')).toBe('x')
        })

        test('write refuses a directory, and a directory that would have to go through a file', async ({ disk, id, refusal }) => {
            expect(await refusal('fs.write', { folder: id, path: 'pages', bytes: bytes('x') })).toBe('TypeMismatchError')
            expect(await refusal('fs.write', { folder: id, path: 'pages/A.md/c.md', bytes: bytes('x'), createDirectories: true })).toBe('TypeMismatchError')
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
        })

        test('a write whose ifStamp still holds goes through', async ({ call, disk, id }) => {
            const { lastModified, size } = await call('fs.read', { folder: id, path: 'pages/A.md' })
            await call('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes('two'), ifStamp: { lastModified, size } })
            expect(await disk.read('Notes/pages/A.md')).toBe('two')
        })

        test('a write whose ifStamp does not hold changes nothing', async ({ call, disk, file, id, refusal }) => {
            const { lastModified, size } = await call('fs.read', { folder: id, path: 'pages/A.md' })
            await file('pages/A.md', 'written elsewhere')
            expect(await refusal('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes('two'), ifStamp: { lastModified, size } })).toBe('NoModificationAllowedError')
            expect(await disk.read('Notes/pages/A.md')).toBe('written elsewhere')
            await disk.remove('Notes/pages/A.md')
            expect(await refusal('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes('two'), ifStamp: { lastModified, size } })).toBe('NoModificationAllowedError')
            expect(await disk.read('Notes/pages/A.md')).toBe(null)
        })

        test('absent writes a new file and refuses one that is there', async ({ call, disk, id, refusal }) => {
            await call('fs.write', { folder: id, path: 'pages/B.md', bytes: bytes('new'), ifStamp: 'absent' })
            expect(await refusal('fs.write', { folder: id, path: 'pages/B.md', bytes: bytes('again'), ifStamp: 'absent' })).toBe('NoModificationAllowedError')
            expect(await disk.read('Notes/pages/B.md')).toBe('new')
            await call('fs.write', { folder: id, path: 'new/deep/C.md', bytes: bytes('c'), ifStamp: 'absent', createDirectories: true })
            expect(await disk.read('Notes/new/deep/C.md')).toBe('c')
        })

        test('of many writes at once with one stamp, exactly one lands', async ({ call, disk, id, port }) => {
            const { lastModified, size } = await call('fs.read', { folder: id, path: 'pages/A.md' })
            const contents = Array.from({ length: 8 }, (_, index) => `writer ${'x'.repeat(index + 1)}`)
            const replies = await Promise.all(contents.map((content) => port.call('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes(content), ifStamp: { lastModified, size } })))
            const landed = contents.filter((_, index) => replies[index].ok)
            expect(landed).toHaveLength(1)
            expect(await disk.read('Notes/pages/A.md')).toBe(landed[0])
            for (const reply of replies) expect(reply.ok || reply.name).toBe(reply.ok ? true : 'NoModificationAllowedError')
        })

        test('a reader sees the old bytes or the new ones, and a write leaves nothing beside the file', async ({ call, disk, id }) => {
            const [short, long] = ['s', 'l'.repeat(200_000)]
            await call('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes(short) })
            const seen = new Set<string>()
            let writing = true
            const reader = (async () => {
                while (writing) {
                    const content = await disk.read('Notes/pages/A.md')
                    seen.add(content === null ? 'missing' : content === short || content === long ? 'whole' : 'partial')
                    await new Promise((resolve) => setTimeout(resolve, 0))
                }
            })()
            for (let turn = 0; turn < 10; turn++) await call('fs.write', { folder: id, path: 'pages/A.md', bytes: bytes(turn % 2 ? short : long) })
            writing = false
            await reader
            expect([...seen]).toEqual(['whole'])
            expect(await disk.names('Notes/pages')).toEqual(['A.md'])
            expect((await call('fs.list', { folder: id, path: 'pages', stamps: false })).map((entry) => entry.name)).toEqual(['A.md'])
        })

        test('createDirectory makes the ones above it, and one that is there is left alone', async ({ call, disk, id, refusal }) => {
            await call('fs.createDirectory', { folder: id, path: 'a/b/c' })
            await call('fs.createDirectory', { folder: id, path: 'a/b/c' })
            await call('fs.createDirectory', { folder: id, path: 'pages' })
            await call('fs.createDirectory', { folder: id, path: '' })
            expect(await disk.names('Notes/a/b')).toEqual(['c'])
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
            expect(await refusal('fs.createDirectory', { folder: id, path: 'pages/A.md' })).toBe('TypeMismatchError')
        })

        test('remove takes a file, or a directory with everything in it, and nothing there is not an error', async ({ call, disk, file, id }) => {
            await file('a/b/c.md', 'x')
            await call('fs.remove', { folder: id, path: 'a' })
            await call('fs.remove', { folder: id, path: 'pages/A.md' })
            await call('fs.remove', { folder: id, path: 'pages/A.md' })
            await call('fs.remove', { folder: id, path: 'nowhere/at all' })
            expect(await disk.names('Notes')).toEqual(['pages'])
            expect(await disk.names('Notes/pages')).toEqual([])
        })
    })

    describe('moving', () => {
        test('moves a file, and a directory with everything in it', async ({ call, disk, file, id }) => {
            await file('a/b/c.md', 'x')
            await call('fs.move', { folder: id, from: 'pages/A.md', to: 'a/A2.md' })
            await call('fs.move', { folder: id, from: 'a', to: 'pages/a' })
            expect(await disk.read('Notes/pages/a/A2.md')).toBe('one')
            expect(await disk.read('Notes/pages/a/b/c.md')).toBe('x')
            expect(await disk.names('Notes')).toEqual(['pages'])
        })

        test('changes only the case of a file’s name, and of a directory’s', async ({ call, disk, id }) => {
            await call('fs.move', { folder: id, from: 'pages/A.md', to: 'pages/a.md' })
            await call('fs.move', { folder: id, from: 'pages', to: 'Pages' })
            expect(await disk.names('Notes')).toEqual(['Pages'])
            expect(await disk.names('Notes/Pages')).toEqual(['a.md'])
            expect(await disk.read('Notes/Pages/a.md')).toBe('one')
        })

        test('refuses a name that is taken, by a file or by a directory, and changes nothing', async ({ disk, file, id, refusal }) => {
            await file('pages/B.md', 'two')
            await file('a/c.md', 'x')
            expect(await refusal('fs.move', { folder: id, from: 'pages/A.md', to: 'pages/B.md' })).toBe('InvalidModificationError')
            expect(await refusal('fs.move', { folder: id, from: 'pages/A.md', to: 'a' })).toBe('InvalidModificationError')
            expect(await refusal('fs.move', { folder: id, from: 'a', to: 'pages' })).toBe('InvalidModificationError')
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
            expect(await disk.read('Notes/pages/B.md')).toBe('two')
            expect(await disk.read('Notes/a/c.md')).toBe('x')
        })

        test('refuses what is not there, a place that is not there, and a directory into itself', async ({ disk, id, refusal }) => {
            expect(await refusal('fs.move', { folder: id, from: 'nowhere.md', to: 'x.md' })).toBe('NotFoundError')
            expect(await refusal('fs.move', { folder: id, from: 'pages/A.md', to: 'nowhere/A.md' })).toBe('NotFoundError')
            expect(await refusal('fs.move', { folder: id, from: 'pages', to: 'pages/inside' })).toBe('InvalidModificationError')
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
        })
    })

    describe('what a page must not reach', () => {
        test('every fs call refuses a path that leads out', async ({ disk, id, refusal }) => {
            for (const path of HOSTILE_PATHS) {
                for (const [method, args] of callsWithPath(id, path)) expect([path, method, await refusal(method, args)]).toEqual([path, method, 'SecurityError'])
            }
            expect(await disk.read('outside.md')).toBe('not the app’s')
            expect(await disk.names('Notes')).toEqual(['pages'])
        })

        test('property: no call with a hostile path is answered', async ({ disk, id, port }) => {
            await fc.assert(
                fc.asyncProperty(hostilePath, async (path) => {
                    for (const [method, args] of callsWithPath(id, path)) {
                        const reply = await port.call(method, args)
                        if (reply.ok) throw new Error(`${method} answered ${JSON.stringify(path)}`)
                    }
                }),
                { seed: 20261125, numRuns: 40 },
            )
            expect(await disk.read('outside.md')).toBe('not the app’s')
            expect(await disk.names('')).toEqual(['Notes', 'outside.md'])
        })

        test('the chosen folder itself cannot be written, moved or removed', async ({ disk, id, refusal }) => {
            expect(await refusal('fs.remove', { folder: id, path: '' })).toBe('SecurityError')
            expect(await refusal('fs.move', { folder: id, from: '', to: 'x' })).toBe('SecurityError')
            expect(await refusal('fs.move', { folder: id, from: 'pages', to: '' })).toBe('SecurityError')
            expect(await refusal('fs.write', { folder: id, path: '', bytes: bytes('x') })).toBe('SecurityError')
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
        })

        test('arguments of the wrong kind are refused', async ({ disk, id, port }) => {
            const wrong: [NativeMethod, unknown][] = [
                ['fs.read', null], ['fs.read', undefined], ['fs.read', {}], ['fs.read', { folder: id }], ['fs.read', { folder: id, path: 7 }],
                ['fs.read', { folder: id, path: ['pages', 'A.md'] }], ['fs.readMany', { folder: id, paths: 'pages/A.md' }],
                ['fs.write', { folder: id, path: 'pages/A.md' }], ['fs.write', { folder: id, path: 'pages/A.md', bytes: 'text' }],
                ['fs.list', { folder: { id }, path: '', stamps: true }], ['shell.openExternal', { url: 7 }],
            ]
            for (const [method, args] of wrong) expect([method, (await port.call(method, args)).ok]).toEqual([method, false])
            expect(await disk.read('Notes/pages/A.md')).toBe('one')
        })

        test('a method that is not in the table is refused', async ({ port }) => {
            for (const method of ['fs.exec', 'toString', '__proto__', 'constructor', '']) {
                const reply = await port.call(method as NativeMethod, {})
                expect([method, reply.ok, reply.ok ? '' : reply.name]).toEqual([method, false, 'NotSupportedError'])
            }
            expect(NATIVE_METHODS).toContain('fs.list')
        })

        test('openExternal takes web, mail and phone addresses only', async ({ refusal }) => {
            for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x', 'smb://host/share', 'etherpk:/graph', 'not an address', '']) {
                expect([url, await refusal('shell.openExternal', { url })]).toEqual([url, 'SecurityError'])
            }
        })

        test('a link inside the folder does not lead out of it', async ({ call, disk, id, refusal }) => {
            if (!disk.link) return
            await disk.makeDirectory('Elsewhere')
            await disk.write('Elsewhere/secret.md', 'secret')
            await disk.link('Notes/way out', 'Elsewhere')
            await disk.link('Notes/out.md', 'outside.md')
            for (const path of ['way out/secret.md', 'out.md']) {
                expect([path, await refusal('fs.read', { folder: id, path })]).not.toEqual([path, 'nothing'])
                expect([path, await refusal('fs.write', { folder: id, path, bytes: bytes('changed') })]).not.toEqual([path, 'nothing'])
                expect((await call('fs.readMany', { folder: id, paths: [path] }).catch(() => [null]))[0]).toBe(null)
            }
            expect(await refusal('fs.write', { folder: id, path: 'way out/new.md', bytes: bytes('x'), createDirectories: true })).not.toBe('nothing')
            expect((await call('fs.walk', { folder: id, path: '', skip: [], limit: 10 })).files).toEqual(['pages/A.md'])
            expect(await disk.read('outside.md')).toBe('not the app’s')
            expect(await disk.names('Elsewhere')).toEqual(['secret.md'])
        })
    })

    describe('watching', () => {
        function eventsOf(port: NativePort): { seen: NativeEvents['fsChanged'][]; stop: () => void } {
            const seen: NativeEvents['fsChanged'][] = []
            const stop = port.on((event, detail) => {
                if (event === 'fsChanged') seen.push(detail as NativeEvents['fsChanged'])
            })
            return { seen, stop }
        }
        const until = async (met: () => boolean, ms: number) => {
            for (const end = Date.now() + ms; !met() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20))
            return met()
        }

        test('reports what another program does, deep inside too, and stops when asked', async ({ call, disk, file, id, port, refusal }) => {
            if (!port.info.features.watch) {
                expect(await refusal('fs.watch', { folder: id })).toBe('NotSupportedError')
                return
            }
            const { seen, stop } = eventsOf(port)
            const watch = await call('fs.watch', { folder: id })
            const reports = (path: string) => seen.some((event) => event.folder === id && (event.paths === null || event.paths.some((one) => one === path || path.startsWith(`${one}/`) || one === '')))
            await file('pages/A.md', 'changed')
            expect(await until(() => reports('pages/A.md'), 10_000)).toBe(true)
            seen.length = 0
            await file('new/deep/B.md', 'x')
            expect(await until(() => reports('new/deep/B.md'), 10_000)).toBe(true)
            seen.length = 0
            await disk.remove('Notes/pages/A.md')
            expect(await until(() => reports('pages/A.md'), 10_000)).toBe(true)
            await call('fs.unwatch', { watch })
            // Let what was on its way arrive before counting.
            await new Promise((resolve) => setTimeout(resolve, 500))
            seen.length = 0
            await file('pages/C.md', 'x')
            expect(await until(() => seen.length > 0, 700)).toBe(false)
            stop()
        }, 45_000)

        test('two watches of one folder end apart', async ({ call, file, id, port }) => {
            if (!port.info.features.watch) return
            const { seen, stop } = eventsOf(port)
            const first = await call('fs.watch', { folder: id })
            const second = await call('fs.watch', { folder: id })
            await call('fs.unwatch', { watch: first })
            await file('pages/A.md', 'changed')
            expect(await until(() => seen.length > 0, 10_000)).toBe(true)
            await call('fs.unwatch', { watch: second })
            stop()
        }, 20_000)
    })

    describe('one file', () => {
        test('reads, reads a part, writes and is let go', async ({ call, disk, file, openFile, refusal }) => {
            if (!openFile) return
            await file('One.md', 'hello')
            const opened = await openFile('Notes/One.md')
            expect(opened).toMatchObject({ name: 'One.md', size: 5 })
            expect(opened.id).not.toContain('One')
            const read = await call('files.read', { file: opened.id })
            expect(text(read.bytes)).toBe('hello')
            expect(text((await call('files.readPart', { file: opened.id, offset: 1, length: 3 })).bytes)).toBe('ell')
            expect((await call('files.readPart', { file: opened.id, offset: 4, length: 100 })).bytes.length).toBe(1)
            expect((await call('files.readPart', { file: opened.id, offset: 100, length: 1 })).bytes.length).toBe(0)
            expect((await call('files.readPart', { file: opened.id, offset: 0, length: 0 })).bytes.length).toBe(0)
            // A part that is not one of the file: refused, never read from the end or before the start.
            for (const [offset, length] of [[-1, 2], [0, -1], [1.5, 2], [0, 2.5], [Number.MAX_SAFE_INTEGER + 2, 1]]) {
                expect(await refusal('files.readPart', { file: opened.id, offset, length })).toBe('OperationError')
            }
            const stamp = await call('files.write', { file: opened.id, bytes: bytes('hello again'), ifStamp: { lastModified: read.lastModified, size: read.size } })
            expect(await disk.read('Notes/One.md')).toBe('hello again')
            expect(await call('files.read', { file: opened.id })).toMatchObject(stamp)
            await disk.write('Notes/One.md', 'written elsewhere, and longer')
            expect(await refusal('files.write', { file: opened.id, bytes: bytes('x'), ifStamp: stamp })).toBe('NoModificationAllowedError')
            expect(await disk.read('Notes/One.md')).toBe('written elsewhere, and longer')
            await call('files.release', { file: opened.id })
            expect(await refusal('files.read', { file: opened.id })).toBe('NotAllowedError')
            expect(await refusal('files.read', { file: 'made-up' })).toBe('NotAllowedError')
        })

        test('a file is not a folder, and a folder is not a file', async ({ file, id, openFile, refusal }) => {
            if (!openFile) return
            await file('One.md', 'hello')
            const opened = await openFile('Notes/One.md')
            expect(await refusal('fs.list', { folder: opened.id, path: '', stamps: false })).toBe('NotAllowedError')
            expect(await refusal('files.read', { file: id })).toBe('NotAllowedError')
        })
    })

    describe('saving a copy', () => {
        test('nothing is on disk until commit, and the parts arrive in order', async ({ answerSave, call, disk, refusal }) => {
            if (!answerSave) return
            await disk.makeDirectory('Saved')
            await answerSave('Saved/copy.txt')
            const { save, name } = await call('save.open', { name: 'copy.txt', type: 'text/plain' })
            expect(name).toBe('copy.txt')
            await call('save.write', { save, bytes: bytes('one ') })
            await call('save.write', { save, bytes: bytes('two') })
            expect(await disk.read('Saved/copy.txt')).toBe(null)
            await call('save.commit', { save })
            expect(await disk.read('Saved/copy.txt')).toBe('one two')
            expect(await refusal('save.write', { save, bytes: bytes('three') })).toBe('NotFoundError')
        })

        test('abort leaves what was there, and a cancelled dialog is an AbortError', async ({ answerSave, call, disk, refusal }) => {
            if (!answerSave) return
            await disk.write('Saved/copy.txt', 'before')
            await answerSave('Saved/copy.txt')
            const { save } = await call('save.open', { name: 'copy.txt', type: 'text/plain' })
            await call('save.write', { save, bytes: bytes('after') })
            await call('save.abort', { save })
            expect(await disk.read('Saved/copy.txt')).toBe('before')
            expect(await disk.names('Saved')).toEqual(['copy.txt'])
            await answerSave(null)
            expect(await refusal('save.open', { name: 'copy.txt', type: 'text/plain' })).toBe('AbortError')
        })
    })
}
