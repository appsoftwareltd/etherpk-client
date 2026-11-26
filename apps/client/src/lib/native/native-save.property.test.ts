/**
 * Saving into a folder a shell reaches, while another program writes it at any moment: before a save,
 * after it, and, what the browser cannot defend against, between the save's read and its own write.
 *
 * `spec/folder-save` states the rule with `Guarded` on. Fixed seed and run count, so a failure
 * reproduces. `NATIVE_FUZZ_RUNS` and `NATIVE_FUZZ_SEED` change them.
 */
import { connectNativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPlainFolderStore } from '../plain/plain-folder-store'
import { createFilesystemDocumentStore } from '../storage/fs/filesystem-store'
import { attachFolderRescan } from '../storage/fs/folder-rescan'
import { NativeFolderRef } from './folder-ref'
import { folderWatch } from './folder-watch'
import { createNativeDirectoryAdapter } from './native-directory-adapter'
import { createNativeTreeAdapter } from './native-tree-adapter'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.NATIVE_FUZZ_SEED
    return { numRuns: Number(process.env.NATIVE_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261125 : Number(seed) }
}

const PATH = 'pages/Beans.md'
const ON_DISK = `Garden/${PATH}`
const START = '- sow\n'

type Step = 'edit' | 'outside-write' | 'outside-remove' | 'outside-touch' | 'outside-in-window' | 'remove-in-window' | 'time' | 'flush' | 'focus' | 'keep-mine' | 'take-disk' | 'lose-watch'

const steps = (allowed: Step[]) => fc.array(fc.constantFrom(...allowed), { minLength: 1, maxLength: 20 })
const EVERY: Step[] = ['edit', 'edit', 'outside-write', 'outside-remove', 'outside-touch', 'outside-in-window', 'outside-in-window', 'remove-in-window', 'time', 'flush', 'focus', 'keep-mine', 'take-disk', 'lose-watch']

/** What both stores offer, as these tests drive one open file. */
interface Driven {
    text(): string
    type(text: string): void
    flush(): Promise<void>
    conflicted(): boolean
    /** The tab says the file was removed, and waits for the person. */
    waiting(): boolean
    resolve(choice: 'keep-mine' | 'take-disk'): Promise<void>
    reconcile(): Promise<void>
    dispose(): Promise<void>
}

interface Opening {
    native: ReturnType<typeof createMemoryNative>
    folder: NativeFolderRef
    bridge: ReturnType<typeof connectNativeBridge>
    /** The text was put in front of the person: in the buffer, or in a conflict. */
    shown: (text: string) => void
}

async function openGraph({ folder, bridge, shown }: Opening): Promise<Driven> {
    let conflict = false
    const store = createFilesystemDocumentStore(createNativeDirectoryAdapter(folder, () => bridge), {
        autosaveMs: 400,
        onConflict: (raised) => {
            conflict = true
            shown(raised.diskText)
        },
    })
    await store.scan()
    const doc = store.open('Beans')
    doc.subscribe(shown)
    await store.whenReady('Beans')
    return {
        text: () => doc.getText(),
        type: (text) => doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: text }),
        flush: () => store.flushDocument('Beans'),
        conflicted: () => conflict,
        waiting: () => false,
        async resolve(choice) {
            if (!conflict) return
            conflict = false
            await store.resolveConflict('Beans', choice).catch(() => {
                // Shown again, or the file has gone: still a conflict either way.
                conflict = true
            })
        },
        reconcile: () => store.reconcile(),
        dispose: () => store.dispose(),
    }
}

async function openPlain({ folder, bridge, shown }: Opening): Promise<Driven> {
    const store = createPlainFolderStore(createNativeTreeAdapter(folder, () => bridge), { autosaveMs: 400, onConflict: (raised) => shown(raised.diskText) })
    const doc = store.open(PATH)
    doc.subscribe(shown)
    await store.whenReady(PATH)
    const state = () => store.stateOf(PATH)
    return {
        text: () => doc.getText(),
        type: (text) => doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: text }),
        flush: () => store.flushDocument(PATH),
        conflicted: () => state()?.conflict != null,
        waiting: () => state()?.removedElsewhere === true,
        resolve: (choice) => store.resolveConflict(PATH, choice).catch(() => {}),
        reconcile: () => store.reconcile(),
        dispose: () => store.dispose(),
    }
}

/** Run the steps, and say what was lost and how the file and the buffer ended. */
async function play(open: (opening: Opening) => Promise<Driven>, run: Step[]) {
    let clock = 1_800_000_000_000
    const native = createMemoryNative({ now: () => (clock += 10) })
    const bridge = connectNativeBridge(native.port)
    const granted = native.grantFolder('Garden')
    native.disk.write(ON_DISK, START)
    const folder = new NativeFolderRef(granted.name, granted.id)

    const outside = new Set<string>()
    const seen = new Set<string>()
    const lost: string[] = []
    let n = 0
    const writeOutside = () => {
        const text = `- from another program ${++n}\n`
        outside.add(text)
        native.disk.write(ON_DISK, text)
    }
    /** What to do to the file once a save has read it and is about to write. */
    let inWindow: (() => void) | null = null
    native.hook({
        before: ({ method, args }) => {
            if (method !== 'fs.write') return
            inWindow?.()
            inWindow = null
            const before = native.disk.text(ON_DISK)
            const after = new TextDecoder().decode((args as { bytes: Uint8Array }).bytes)
            const replaced = before !== null && outside.has(before) && !seen.has(before) && before !== after ? before : null
            if (replaced !== null) pendingLoss = replaced
        },
        after: ({ method }, reply) => {
            if (method === 'fs.write' && reply.ok && pendingLoss !== null) lost.push(pendingLoss)
            pendingLoss = null
        },
    })
    let pendingLoss: string | null = null

    const driven = await open({ native, folder, bridge, shown: (text) => seen.add(text) })
    let focus: () => void = () => {}
    vi.stubGlobal('window', {
        addEventListener: (_: string, listener: () => void) => (focus = listener),
        removeEventListener: () => {},
    })
    const detach = attachFolderRescan(() => driven.reconcile(), { watch: folderWatch(folder, bridge) })
    const conflictsBeforeOutside: boolean[] = []

    const actions: Record<Step, () => void | Promise<void>> = {
        edit: () => driven.type(`- edit ${++n}\n`),
        'outside-write': writeOutside,
        'outside-remove': () => native.disk.remove(ON_DISK),
        'outside-touch': () => {
            const text = native.disk.text(ON_DISK)
            if (text !== null) native.disk.write(ON_DISK, text)
        },
        'outside-in-window': () => { inWindow = writeOutside },
        'remove-in-window': () => { inWindow = () => native.disk.remove(ON_DISK) },
        time: async () => void (await vi.advanceTimersByTimeAsync(700)),
        flush: () => driven.flush(),
        focus: () => focus(),
        'keep-mine': () => driven.resolve('keep-mine'),
        'take-disk': () => driven.resolve('take-disk'),
        'lose-watch': () => native.loseWatch(folder.nativeId),
    }
    for (const step of run) {
        await actions[step]()
        if (outside.size === 0) conflictsBeforeOutside.push(driven.conflicted())
    }
    inWindow = null
    // Long enough for an autosave, a watch's pass and, with the watch lost, a tick of the timer.
    await vi.advanceTimersByTimeAsync(10_000)
    await driven.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    const end = { lost, conflictsBeforeOutside, conflicted: driven.conflicted(), waiting: driven.waiting(), buffer: driven.text(), disk: native.disk.text(ON_DISK), writes: native.calls.filter((call) => call.method === 'fs.write').length }
    detach()
    await driven.dispose()
    return end
}

const kinds = [['a Folder graph', openGraph], ['a Plain Folder', openPlain]] as const

describe.each(kinds)('%s over a shell', (_, open) => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('never writes over what another program wrote unseen, whenever that was', async () => {
        await fc.assert(fc.asyncProperty(steps(EVERY), async (run) => {
            expect((await play(open, run)).lost).toEqual([])
        }), fuzz(150))
    }, 120_000)

    it('ends with the buffer and the disk the same, or with a question', async () => {
        await fc.assert(fc.asyncProperty(steps(EVERY), async (run) => {
            const end = await play(open, run)
            if (end.conflicted || end.waiting || end.disk === null) return
            expect(end.buffer).toBe(end.disk)
        }), fuzz(150))
    }, 120_000)

    it('never takes a save of its own, or a touched file, for another program’s edit', async () => {
        await fc.assert(fc.asyncProperty(steps(['edit', 'time', 'flush', 'focus', 'outside-touch', 'lose-watch']), async (run) => {
            const end = await play(open, run)
            expect(end.conflictsBeforeOutside).not.toContain(true)
            expect(end.conflicted).toBe(false)
            expect(end.disk).toBe(end.buffer)
        }), fuzz(100))
    }, 120_000)
})

describe('what is written is what is read', () => {
    const name = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 }).filter((value) => value !== '.' && value !== '..' && !/[\\/\u0000-\u001f]/.test(value)) // eslint-disable-line no-control-regex -- the characters a name must not hold

    function adapters() {
        const native = createMemoryNative()
        const bridge = connectNativeBridge(native.port)
        const granted = native.grantFolder('Garden')
        const folder = new NativeFolderRef(granted.name, granted.id)
        return { flat: createNativeDirectoryAdapter(folder, () => bridge), tree: createNativeTreeAdapter(folder, () => bridge) }
    }

    it('a file of a graph, by any name, with the stamps its listing gives', async () => {
        await fc.assert(fc.asyncProperty(name, fc.string({ unit: 'binary' }), async (file, text) => {
            const { flat } = adapters()
            // A lone surrogate is no text a file can hold, and a leading byte order mark is not part of one.
            const kept = new TextDecoder().decode(new TextEncoder().encode(text))
            const written = await flat.write('pages', file, text)
            const read = await flat.read('pages', file)
            expect(read.text).toBe(kept)
            const [listed] = await flat.list('pages')
            expect(listed).toEqual({ name: file.normalize('NFC'), lastModified: written.lastModified, size: written.size })
            expect({ lastModified: read.lastModified, size: read.size }).toEqual({ lastModified: written.lastModified, size: written.size })
            expect(await flat.exists('pages', file)).toBe(true)
            expect((await flat.readMany!('pages', [file]))[0]?.text).toBe(kept)
        }), fuzz(200))
    })

    it('a file of a Plain Folder, at any depth, byte for byte', async () => {
        await fc.assert(fc.asyncProperty(fc.array(name, { minLength: 1, maxLength: 4 }), fc.uint8Array(), async (names, content) => {
            const { tree } = adapters()
            const path = names.join('/').normalize('NFC')
            await tree.createDirectory(names.slice(0, -1).join('/'))
            const stamp = await tree.write(path, new Uint8Array(content))
            expect([...(await tree.read(path)).bytes]).toEqual([...content])
            expect(await tree.stat(path)).toEqual({ kind: 'file', ...stamp })
            expect(await tree.canonicalPath(path)).toBe(path)
        }), fuzz(200))
    })
})
