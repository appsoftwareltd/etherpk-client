import { describe, expect, it } from 'vitest'

import { type ContractHarness, nativePortContract } from './contract.ts'
import { NATIVE_METHODS } from './index.ts'
import { createMemoryNative, type MemoryNativeOptions } from './memory.ts'

function harness(options: MemoryNativeOptions): ContractHarness {
    const native = createMemoryNative(options)
    const { disk } = native
    return {
        port: native.port,
        disk: {
            write: (path, text) => { disk.write(path, text) },
            read: (path) => disk.text(path),
            makeDirectory: (path) => { disk.makeDirectory(path) },
            remove: (path) => disk.remove(path),
            names: (path) => {
                const entry = disk.at(path)
                return entry?.kind === 'directory' ? entry.entries.map((one) => one.name).sort() : []
            },
        },
        answerFolder: native.answerFolder,
        answerSave: native.answerSave,
        openFile: native.grantFile,
        ignoresCase: disk.ignoreCase,
        dispose: () => {},
    }
}

// A clock that moves on each write, since two writes can land in one millisecond.
const ticking = () => {
    let now = 1_800_000_000_000
    return () => ++now
}

describe('the in-memory port', () => {
    describe('on a disk that minds case', () => nativePortContract({ describe, expect, it }, () => harness({ now: ticking() })))
    describe('on a disk that ignores case', () => nativePortContract({ describe, expect, it }, () => harness({ now: ticking(), ignoreCase: true })))
    describe('with no watching', () => nativePortContract({ describe, expect, it }, () => harness({ now: ticking(), features: { watch: false } })))

    it('answers every method', async () => {
        const native = createMemoryNative({ features: { signIn: true } })
        for (const method of NATIVE_METHODS) {
            const reply = await native.port.call(method, {})
            // With no arguments most are refused, and none is unknown.
            if (!reply.ok) expect([method, reply.message]).not.toEqual([method, expect.stringContaining('not a method')])
        }
    })

    it('copies what crosses, so neither side can change the other’s', async () => {
        const native = createMemoryNative()
        const { id } = native.grantFolder('Notes')
        const bytes = new TextEncoder().encode('one')
        await native.port.call('fs.write', { folder: id, path: 'A.md', bytes })
        bytes[0] = 0
        expect(native.disk.text('Notes/A.md')).toBe('one')
        const reply = await native.port.call('fs.read', { folder: id, path: 'A.md' })
        if (!reply.ok) throw new Error(reply.message)
        ;(reply.value as { bytes: Uint8Array }).bytes[0] = 0
        expect(native.disk.text('Notes/A.md')).toBe('one')
    })

    it('fails what it is told to, as often as it is told to', async () => {
        const native = createMemoryNative()
        const { id } = native.grantFolder('Notes')
        native.fail('fs.write', 'InvalidStateError')
        const write = () => native.port.call('fs.write', { folder: id, path: 'A.md', bytes: new Uint8Array([1]) })
        expect(await write()).toMatchObject({ ok: false, name: 'InvalidStateError' })
        expect((await write()).ok).toBe(true)
    })

    it('refuses a folder whose permission was withdrawn', async () => {
        const native = createMemoryNative()
        const { id } = native.grantFolder('Notes')
        native.withdraw(id)
        expect(await native.port.call('folders.get', { folder: id })).toEqual({ ok: true, value: null })
        expect(await native.port.call('fs.list', { folder: id, path: '', stamps: true })).toMatchObject({ ok: false, name: 'NotAllowedError' })
    })

    it('gives each launch once, oldest first', async () => {
        const native = createMemoryNative()
        native.launch({ kind: 'link', url: 'etherpk:/graphs' })
        native.launch({ kind: 'share', title: '', text: 'hello', url: '', files: [native.shareFile('a.txt', 'a')] })
        const taken = await native.port.call('launches.take', {})
        expect(taken).toMatchObject({ ok: true, value: [{ kind: 'link' }, { kind: 'share' }] })
        expect(await native.port.call('launches.take', {})).toEqual({ ok: true, value: [] })
    })
})
