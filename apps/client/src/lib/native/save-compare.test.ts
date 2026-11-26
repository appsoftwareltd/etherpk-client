/**
 * A save over a shell that can refuse to write over a file that has moved: another program's write
 * that lands between a save's read and its write is never replaced (`spec/folder-save`).
 */
import { connectNativeBridge, type NativeMethod } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'
import { describe, expect, it } from 'vitest'

import { createPlainFolderStore, type PlainConflict } from '../plain/plain-folder-store'
import { createFilesystemDocumentStore, type DocumentConflict } from '../storage/fs/filesystem-store'
import { NativeFolderRef } from './folder-ref'
import { createNativeDirectoryAdapter } from './native-directory-adapter'
import { createNativeTreeAdapter } from './native-tree-adapter'

const PAGE = 'Garden/pages/Beans.md'
const START = '---\ntitle: Beans\n---\n- sow\n'

function world() {
    let now = 1_800_000_000_000
    const native = createMemoryNative({ now: () => (now += 1000) })
    const bridge = connectNativeBridge(native.port)
    const { id, name } = native.grantFolder('Garden')
    native.disk.write(PAGE, START)
    return { native, bridge: () => bridge, folder: new NativeFolderRef(name, id) }
}

/** Run `act` once, after the next call of `method` has been answered. */
function after(native: MemoryNative, method: NativeMethod, act: () => void): void {
    const stop = native.hook({
        after: (call) => {
            if (call.method !== method) return
            stop()
            act()
        },
    })
}

describe('a Folder graph’s save over a shell', () => {
    async function open() {
        const { native, bridge, folder } = world()
        const conflicts: DocumentConflict[] = []
        const errors: unknown[] = []
        const store = createFilesystemDocumentStore(createNativeDirectoryAdapter(folder, bridge), {
            autosaveMs: 60_000,
            onConflict: (conflict) => conflicts.push(conflict),
            onSaveError: (_, error) => errors.push(error),
        })
        await store.reconcile()
        const doc = store.open('Beans')
        await store.whenReady('Beans')
        const type = (text: string) => doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: text })
        return { native, store, conflicts, errors, type, doc }
    }

    it('stops at a write that lands between its read and its own', async () => {
        const { native, store, conflicts, errors, type } = await open()
        type('- water\n')
        after(native, 'fs.read', () => native.disk.write(PAGE, `${START}- from elsewhere\n`))
        await store.flushDocument('Beans')
        expect(native.disk.text(PAGE)).toBe(`${START}- from elsewhere\n`)
        expect(conflicts).toHaveLength(1)
        expect(errors).toEqual([])
    })

    it('goes ahead when only the file’s time moved', async () => {
        const { native, store, conflicts, errors, type } = await open()
        type('- water\n')
        after(native, 'fs.read', () => native.disk.write(PAGE, START))
        await store.flushDocument('Beans')
        expect(native.disk.text(PAGE)).toBe(`${START}- water\n`)
        expect(conflicts).toEqual([])
        expect(errors).toEqual([])
    })

    it('does not replace a file made where one had been removed', async () => {
        const { native, store, conflicts, type } = await open()
        type('- water\n')
        native.disk.remove(PAGE)
        after(native, 'fs.stat', () => native.disk.write(PAGE, 'a new file of that name\n'))
        await store.flushDocument('Beans')
        expect(native.disk.text(PAGE)).toBe('a new file of that name\n')
        expect(conflicts).toHaveLength(1)
    })

    it('brings back a file that stays removed', async () => {
        const { native, store, type } = await open()
        type('- water\n')
        native.disk.remove(PAGE)
        await store.flushDocument('Beans')
        expect(native.disk.text(PAGE)).toBe(`${START}- water\n`)
    })

    it('keeping mine asks again when the file moves as it is written', async () => {
        const { native, store, conflicts, type } = await open()
        type('- water\n')
        native.disk.write(PAGE, 'one change\n')
        await store.flushDocument('Beans')
        expect(conflicts).toHaveLength(1)
        after(native, 'fs.read', () => native.disk.write(PAGE, 'another change\n'))
        await expect(store.resolveConflict('Beans', 'keep-mine')).rejects.toThrow(/again/)
        expect(native.disk.text(PAGE)).toBe('another change\n')
        expect(conflicts.at(-1)?.diskText).toBe('another change\n')
        await store.resolveConflict('Beans', 'keep-mine')
        expect(native.disk.text(PAGE)).toBe(`${START}- water\n`)
    })

    it('says so when the file is locked and has not moved, and tries no more', async () => {
        const { native, store, errors, type } = await open()
        type('- water\n')
        native.fail('fs.write', 'NoModificationAllowedError', { times: 5 })
        await store.flushDocument('Beans')
        expect((errors[0] as Error).name).toBe('NoModificationAllowedError')
        expect(native.calls.filter((call) => call.method === 'fs.write')).toHaveLength(1)
    })

    it('tries a busy file once more', async () => {
        const { native, store, errors, type } = await open()
        type('- water\n')
        native.fail('fs.write', 'InvalidStateError')
        await store.flushDocument('Beans')
        expect(errors).toEqual([])
        expect(native.disk.text(PAGE)).toBe(`${START}- water\n`)
    })

    it('a fix to a closed document leaves one that moved as it was written', async () => {
        const { native, bridge, folder } = world()
        const store = createFilesystemDocumentStore(createNativeDirectoryAdapter(folder, bridge))
        await store.reconcile()
        after(native, 'fs.read', () => native.disk.write(PAGE, 'written elsewhere\n'))
        expect(await store.spliceIfUnchanged('Beans', START, [{ from: 0, to: 0, insert: 'x' }])).toBe('changed')
        expect(native.disk.text(PAGE)).toBe('written elsewhere\n')
    })
})

describe('a Plain Folder’s save over a shell', () => {
    const path = 'pages/Beans.md'
    async function open() {
        const { native, bridge, folder } = world()
        const conflicts: PlainConflict[] = []
        const errors: unknown[] = []
        const store = createPlainFolderStore(createNativeTreeAdapter(folder, bridge), {
            autosaveMs: 60_000,
            onConflict: (conflict) => conflicts.push(conflict),
            onSaveError: (_, error) => errors.push(error),
        })
        const doc = store.open(path)
        await store.whenReady(path)
        doc.applyChange({ from: doc.getText().length, to: doc.getText().length, insert: '- water\n' })
        return { native, store, conflicts, errors }
    }

    it('stops at a write that lands between its read and its own', async () => {
        const { native, store, conflicts, errors } = await open()
        after(native, 'fs.read', () => native.disk.write(PAGE, 'written elsewhere\n'))
        await store.flushDocument(path)
        expect(native.disk.text(PAGE)).toBe('written elsewhere\n')
        expect(conflicts).toHaveLength(1)
        expect(errors).toEqual([])
    })

    it('never brings back a file removed as it saves', async () => {
        const { native, store, errors } = await open()
        after(native, 'fs.read', () => native.disk.remove(PAGE))
        await store.flushDocument(path)
        expect(native.disk.text(PAGE)).toBe(null)
        expect(store.stateOf(path)?.removedElsewhere).toBe(true)
        expect(errors).toEqual([])
    })

    it('restore does not replace a file made meanwhile', async () => {
        const { native, store, conflicts } = await open()
        native.disk.remove(PAGE)
        await store.flushDocument(path)
        after(native, 'fs.stat', () => native.disk.write(PAGE, 'written elsewhere\n'))
        await store.restore(path)
        expect(native.disk.text(PAGE)).toBe('written elsewhere\n')
        expect(conflicts).toHaveLength(1)
    })

    it('keeping mine asks again when the file moves as it is written', async () => {
        const { native, store, conflicts } = await open()
        native.disk.write(PAGE, 'one change\n')
        await store.flushDocument(path)
        after(native, 'fs.read', () => native.disk.write(PAGE, 'another change\n'))
        await expect(store.resolveConflict(path, 'keep-mine')).rejects.toThrow(/again/)
        expect(native.disk.text(PAGE)).toBe('another change\n')
        expect(conflicts.at(-1)?.diskText).toBe('another change\n')
    })
})
