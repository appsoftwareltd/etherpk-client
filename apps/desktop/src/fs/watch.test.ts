import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canWatch } from '../testing/node-port.ts'
import { FolderWatch, Gathered, LONGEST_WAIT_MS, MOST_PATHS, SETTLE_MS } from './watch.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-watch-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('changes gathered', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('are one event when they come together, and one each second when they never stop', () => {
        const told: (string[] | null)[] = []
        const gathered = new Gathered((paths) => told.push(paths))
        gathered.add('a')
        gathered.add('a')
        gathered.add('b')
        vi.advanceTimersByTime(SETTLE_MS)
        expect(told).toEqual([['a', 'b']])
        for (let at = 0; at < 3 * LONGEST_WAIT_MS; at += 50) {
            gathered.add(`c${at}`)
            vi.advanceTimersByTime(50)
        }
        expect(told.length).toBeGreaterThanOrEqual(3)
    })
    it('too many to list are everything, and so is one with no name', () => {
        const told: (string[] | null)[] = []
        const gathered = new Gathered((paths) => told.push(paths))
        for (let n = 0; n <= MOST_PATHS; n++) gathered.add(String(n))
        vi.advanceTimersByTime(SETTLE_MS)
        gathered.add('a')
        gathered.add(null)
        vi.advanceTimersByTime(SETTLE_MS)
        gathered.add('b')
        vi.advanceTimersByTime(SETTLE_MS)
        expect(told).toEqual([null, null, ['b']])
    })
    it('property: every change is told, in an event after it', () => {
        fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', null), fc.nat(1500)), { maxLength: 30 }), (changes) => {
            const told: (string[] | null)[] = []
            const gathered = new Gathered((paths) => told.push(paths))
            const owed = new Set<string | null>()
            for (const [path, wait] of changes) {
                gathered.add(path)
                owed.add(path)
                const before = told.length
                vi.advanceTimersByTime(wait)
                if (told.length === before) continue
                const events = told.slice(before)
                for (const one of owed) expect(events.some((event) => event === null || (one !== null && event.includes(one)))).toBe(true)
                owed.clear()
            }
        }), { seed: 20261125, numRuns: 200 })
    })
})

describe('a folder that cannot be watched', () => {
    const refusing = (code: string) => ({ platform: 'linux' as const, watch: () => { throw Object.assign(new Error(code), { code }) } })
    it('is said at once, and not told as lost later', async () => {
        let lost = 0
        const watch = new FolderWatch(dir, { changed: () => {}, lost: () => { lost++ } }, refusing('ENOSPC'))
        await expect(watch.start()).rejects.toMatchObject({ failure: 'NotSupportedError' })
        expect(lost).toBe(0)
    })
    it('in part, for want of watches, is not watched at all', async () => {
        await mkdir(join(dir, 'pages'))
        const closed: string[] = []
        const watch = new FolderWatch(dir, { changed: () => {}, lost: () => {} }, {
            platform: 'linux',
            watch: (path) => {
                if (path.endsWith('pages')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
                return Object.assign(new EventEmitter(), { close: () => closed.push(path) }) as unknown as FSWatcher
            },
        })
        await expect(watch.start()).rejects.toMatchObject({ failure: 'NotSupportedError' })
        expect(closed).toEqual([dir])
    })
    it('any more is told as lost, once', async () => {
        let lost = 0
        const emitter = new EventEmitter()
        const watch = new FolderWatch(dir, { changed: () => {}, lost: () => { lost++ } }, { platform: 'win32', watch: () => Object.assign(emitter, { close: () => {} }) as unknown as FSWatcher })
        await watch.start()
        emitter.emit('error', new Error('gone'))
        emitter.emit('error', new Error('gone'))
        expect(lost).toBe(1)
    })
})

describe('a link that appears in a watched folder', () => {
    it('is told of, and never watched through, wherever it leads', async () => {
        const folder = join(dir, 'Garden')
        await mkdir(join(dir, 'Private/deep'), { recursive: true })
        await mkdir(folder)
        const watched: string[] = []
        const listeners = new Map<string, (event: string, name: string | null) => void>()
        const seen: (string[] | null)[] = []
        const watch = new FolderWatch(folder, { changed: (paths) => seen.push(paths), lost: () => {} }, {
            platform: 'linux',
            watch: (path, _options, listener) => {
                watched.push(path)
                listeners.set(path, listener)
                return Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher
            },
        })
        await watch.start()
        await symlink(join(dir, 'Private'), join(folder, 'link'))
        await symlink(join(folder), join(folder, 'loop'))
        listeners.get(folder)!('rename', 'link')
        listeners.get(folder)!('rename', 'loop')
        await vi.waitFor(() => expect(seen.flat()).toEqual(expect.arrayContaining(['link', 'loop'])))
        expect(watched).toEqual([folder])
        watch.close()
    })
})

describe.runIf(process.platform === 'linux' && canWatch(tmpdir()))('a folder on this disk', () => {
    async function watched() {
        const seen = new Set<string>()
        const state = { lost: 0, events: 0 }
        const watch = new FolderWatch(dir, { changed: (paths) => { state.events++; for (const path of paths ?? ['everything']) seen.add(path) }, lost: () => { state.lost++ } })
        await watch.start()
        return { seen, state, watch, until: async (path: string) => { for (let n = 0; n < 200 && !seen.has(path); n++) await delay(20); return seen.has(path) } }
    }
    it('tells of files in directories that appear, however deep and however quickly', async () => {
        const { until, watch } = await watched()
        await mkdir(join(dir, 'a/b/c'), { recursive: true })
        await writeFile(join(dir, 'a/b/c/one.md'), 'x')
        expect(await until('a/b/c/one.md')).toBe(true)
        await writeFile(join(dir, 'a/b/two.md'), 'x')
        expect(await until('a/b/two.md')).toBe(true)
        watch.close()
    })
    it('follows a directory that moves, and one that takes its place', async () => {
        await mkdir(join(dir, 'a'))
        const { until, seen, watch } = await watched()
        await rename(join(dir, 'a'), join(dir, 'b'))
        await mkdir(join(dir, 'a'))
        await delay(300)
        seen.clear()
        await writeFile(join(dir, 'b/one.md'), 'x')
        await writeFile(join(dir, 'a/two.md'), 'x')
        expect(await until('b/one.md')).toBe(true)
        expect(await until('a/two.md')).toBe(true)
        expect(seen.has('a/one.md')).toBe(false)
        watch.close()
    })
    it('says nothing of the app’s temporary files, or of a repository’s own', async () => {
        await mkdir(join(dir, '.git'))
        const { seen, until, watch } = await watched()
        await writeFile(join(dir, '.etherpk-0.crswap'), 'x')
        await writeFile(join(dir, '.git/index'), 'x')
        await writeFile(join(dir, 'last.md'), 'x')
        expect(await until('last.md')).toBe(true)
        expect([...seen]).toEqual(['last.md'])
        watch.close()
    })
    it('that is moved away is lost', async () => {
        const { state, watch } = await watched()
        await rename(dir, `${dir}-moved`)
        for (let n = 0; n < 200 && state.lost === 0; n++) await delay(20)
        expect(state.lost).toBe(1)
        await rename(`${dir}-moved`, dir)
        watch.close()
    })
    it('tells nothing of what is behind a link out of the folder', async () => {
        await mkdir(join(`${dir}-private`, 'deep'), { recursive: true })
        const { seen, until, watch } = await watched()
        await symlink(`${dir}-private`, join(dir, 'link'))
        expect(await until('link')).toBe(true)
        await writeFile(join(`${dir}-private`, 'deep/secret.md'), 'x')
        await writeFile(join(dir, 'after.md'), 'x')
        expect(await until('after.md')).toBe(true)
        expect([...seen].filter((path) => path.startsWith('link/'))).toEqual([])
        watch.close()
        await rm(`${dir}-private`, { recursive: true, force: true })
    })
    it('tells nothing once closed', async () => {
        const { state, watch } = await watched()
        watch.close()
        await writeFile(join(dir, 'a.md'), 'x')
        await delay(300)
        expect(state).toEqual({ lost: 0, events: 0 })
    })
})
