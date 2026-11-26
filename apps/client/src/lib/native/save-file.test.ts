import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectNativeBridge, type NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'

const shell = vi.hoisted(() => ({ bridge: null as unknown }))
vi.mock('./bridge.js', () => ({ nativeBridge: () => shell.bridge as NativeBridge | null }))

import { SAVE_CHUNK_BYTES, downloadBlob, downloadName, openNativeSave, saveBlob, saveFailureReason, saveUrl } from './save-file'
import { getNotices, resetNotices } from '../activity/notices'

let native: MemoryNative
beforeEach(() => {
    native = createMemoryNative()
    shell.bridge = connectNativeBridge(native.port)
    resetNotices()
})
afterEach(() => vi.restoreAllMocks())

const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('saving a file in a Native App', () => {
    it('writes it where the person chose', async () => {
        native.answerSave('Downloads/garden.md')
        expect(await saveBlob(new Blob(['# Garden\n'], { type: 'text/markdown' }), 'garden.md')).toBe('saved')
        expect(native.disk.text('Downloads/garden.md')).toBe('# Garden\n')
        expect(native.calls[0]).toEqual({ method: 'save.open', args: { name: 'garden.md', type: 'text/markdown' } })
    })

    it('writes nothing when the person cancels, and says so to its caller alone', async () => {
        native.answerSave(null)
        expect(await saveBlob(new Blob(['x']), 'garden.md')).toBe('cancelled')
        expect(native.calls.map((call) => call.method)).toEqual(['save.open'])
        native.answerSave(null)
        downloadBlob(new Blob(['x']), 'garden.md')
        await settled()
        expect(getNotices()).toEqual([])
    })

    it('drops a file it could not finish, and rejects with what went wrong', async () => {
        native.answerSave('Downloads/garden.md')
        native.fail('save.write', 'QuotaExceededError')
        await expect(saveBlob(new Blob(['x']), 'garden.md')).rejects.toMatchObject({ name: 'QuotaExceededError' })
        expect(native.calls.map((call) => call.method)).toEqual(['save.open', 'save.write', 'save.abort'])
        expect(native.disk.at('Downloads/garden.md')).toBeNull()
    })

    it('tells the person in plain words when nothing else is waiting to', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        native.answerSave('Downloads/garden.md')
        native.fail('save.commit', 'QuotaExceededError')
        downloadBlob(new Blob(['x']), 'garden.md')
        await settled()
        expect(getNotices().map((notice) => notice.text)).toEqual(['garden.md was not saved. There is no room left on that disk. Make some room, or choose another place, and save it again.'])
    })

    it('writes the same bytes whatever the size, in parts no larger than a chunk', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 0, max: 2 * SAVE_CHUNK_BYTES + 3 }), async (size) => {
                native.calls.length = 0
                native.answerSave('Downloads/large.bin')
                const bytes = new Uint8Array(size).map((_, at) => at % 251)
                expect(await saveBlob(new Blob([bytes]), 'large.bin')).toBe('saved')
                expect(Buffer.from(native.disk.fileAt('Downloads/large.bin').bytes).equals(Buffer.from(bytes))).toBe(true)
                for (const call of native.calls) {
                    if (call.method === 'save.write') expect((call.args as { bytes: Uint8Array }).bytes.length).toBeLessThanOrEqual(SAVE_CHUNK_BYTES)
                }
            }),
            { seed: 20261125, numRuns: 25, examples: [[0], [SAVE_CHUNK_BYTES], [SAVE_CHUNK_BYTES + 1]] },
        )
    })

    it('opens a save for a caller that streams, and nothing in a browser', async () => {
        native.answerSave('Downloads/export.zip')
        const save = (await openNativeSave('export.zip', 'application/zip'))!
        await save.write(new Uint8Array([1, 2]))
        expect(native.disk.at('Downloads/export.zip')).toBeNull()
        await save.close()
        expect([...native.disk.fileAt('Downloads/export.zip').bytes]).toEqual([1, 2])
        shell.bridge = null
        expect(await openNativeSave('export.zip', 'application/zip')).toBeNull()
    })

    it('saves a data: address without fetching it, which the policy would refuse', async () => {
        const fetched = vi.spyOn(globalThis, 'fetch')
        native.answerSave('Downloads/a.txt')
        expect(await saveUrl('data:text/plain;base64,R2FyZGVu', 'a.txt')).toBe('saved')
        native.answerSave('Downloads/b.txt')
        expect(await saveUrl('data:text/plain,Kitchen%20notes', 'b.txt')).toBe('saved')
        expect(native.disk.text('Downloads/a.txt')).toBe('Garden')
        expect(native.disk.text('Downloads/b.txt')).toBe('Kitchen notes')
        expect(fetched).not.toHaveBeenCalled()
    })

    it('names a download from its address, even one that is not escaped right', () => {
        const link = (href: string, download = '') => ({ href, download }) as HTMLAnchorElement
        expect(downloadName(link('blob:x', 'garden.md'))).toBe('garden.md')
        expect(downloadName(link('https://installed.app.etherpk.com/assets/Garden%20plan.pdf'))).toBe('Garden plan.pdf')
        expect(downloadName(link('https://installed.app.etherpk.com/assets/100%.pdf'))).toBe('100%.pdf')
        expect(downloadName(link('data:text/plain,Kitchen'))).toBe('file')
    })

    it('never shows an error’s name', () => {
        for (const name of ['QuotaExceededError', 'NotAllowedError', 'OperationError']) expect(saveFailureReason(new DOMException('x', name))).not.toContain(name)
    })
})
