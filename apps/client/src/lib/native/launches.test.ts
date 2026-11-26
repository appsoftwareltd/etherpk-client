import 'fake-indexeddb/auto'
import { connectNativeBridge, type Launch, type NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'
import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_QUICK_NOTE_LENGTH } from '#lib/document/quick-notes.js'
import { MAX_SHARED_FILES } from '#lib/share/share-limits.js'
import { readSharedFiles } from '#lib/share/shared-files.js'

import { READ_PART_BYTES, carryOut, linkAddress, listenForLaunches, receiveShare, type LaunchHandlers } from './launches'

let native: MemoryNative
let bridge: NativeBridge
let did: string[]
let handlers: LaunchHandlers

beforeEach(() => {
    native = createMemoryNative()
    bridge = connectNativeBridge(native.port)
    did = []
    handlers = {
        goto: async (address) => void did.push(`goto ${address}`),
        openFile: async (file) => void did.push(`file ${file.name}`),
        openFolder: async (folder) => void did.push(`folder ${folder.name}`),
        say: (message) => void did.push(`say ${message}`),
    }
})

const share = (over: Partial<Extract<Launch, { kind: 'share' }>> = {}): Extract<Launch, { kind: 'share' }> => ({ kind: 'share', title: '', text: '', url: '', files: [], ...over })
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('an etherpk: link', () => {
    it.each([
        ['etherpk:/graph/sync/abc/d/Garden', '/graph/sync/abc/d/Garden'],
        ['etherpk:/graph/folder/Notes/d/Garden#task=3-0123456789ab', '/graph/folder/Notes/d/Garden#task=3-0123456789ab'],
        ['etherpk://graph/sync/abc/d/Garden', '/graph/sync/abc/d/Garden'],
        ['etherpk:///graph/sync/abc', '/graph/sync/abc'],
        ['ETHERPK:graph/browser/abc', '/graph/browser/abc'],
        ['etherpk:/folder/Recipes/f/soup.md', '/folder/Recipes/f/soup.md'],
        ['  etherpk:/graph/sync/abc\n', '/graph/sync/abc'],
    ])('%s opens %s', (link, address) => expect(linkAddress(link)).toBe(address))

    it.each([
        'etherpk:', 'etherpk:/', 'etherpk:/graphs', 'etherpk:/share?text=x', 'etherpk:/open-file', 'etherpk:/auth/login', 'etherpk:/demo',
        'etherpk:/extension-sign-in?code=x', 'etherpk:/graph', 'etherpk:////example.com/graph/sync/abc', 'etherpk:/graph/sync/../../auth/login',
        'etherpk:\\\\example.com/graph/sync/a', 'https://example.com/graph/sync/abc', 'javascript:alert(1)', 'notetherpk:/graph/sync/abc',
    ])('%s opens nothing', (link) => expect(linkAddress(link)).toBeNull())

    it('never leads anywhere but a page of notes of this app', () => {
        fc.assert(
            fc.property(fc.oneof(fc.string(), fc.string().map((text) => `etherpk:${text}`), fc.webPath().map((path) => `etherpk:/graph/sync${path}`), fc.webUrl().map((url) => `etherpk:${url}`)), (link) => {
                const address = linkAddress(link)
                if (address === null) return
                const url = new URL(address, 'https://installed.app.etherpk.com')
                expect(url.origin).toBe('https://installed.app.etherpk.com')
                expect(url.pathname).toMatch(/^\/(?:graph\/(?:folder|sync|browser)|g|folder)\//)
            }),
            { seed: 20261125, numRuns: 1000 },
        )
    })
})

describe('a share', () => {
    it('keeps its files on the device and goes to the page that shows them', async () => {
        const address = await receiveShare(share({ title: 'Soup', text: 'leeks', files: [native.shareFile('soup.png', 'picture', 'image/png'), native.shareFile('soup.md', '# Soup')] }), bridge)
        const query = new URL(address, 'https://x.invalid').searchParams
        expect(query.get('title')).toBe('Soup')
        expect(query.get('text')).toBe('leeks')
        expect(query.has('leftOut')).toBe(false)
        const files = await readSharedFiles(query.get('files')!)
        expect(files.map((file) => [file.name, file.type])).toEqual([['soup.png', 'image/png'], ['soup.md', '']])
        expect(await files[1].text()).toBe('# Soup')
    })

    it('of words alone keeps nothing', async () => {
        expect(await receiveShare(share({ url: 'https://example.com/soup' }), bridge)).toBe('/share?url=https%3A%2F%2Fexample.com%2Fsoup')
        expect(native.calls).toEqual([])
    })

    it('reads a large file in parts, and the file is the same', async () => {
        const bytes = new Uint8Array(READ_PART_BYTES * 2 + 7).map((_, at) => at % 253)
        const address = await receiveShare(share({ files: [native.shareFile('large.bin', bytes)] }), bridge)
        const [file] = await readSharedFiles(new URL(address, 'https://x.invalid').searchParams.get('files')!)
        expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
        const parts = native.calls.filter((call) => call.method === 'files.readPart').map((call) => (call.args as { length: number }).length)
        expect(parts).toEqual([READ_PART_BYTES, READ_PART_BYTES, 7])
    })

    it('leaves out the files past the limit without reading them, and counts them', async () => {
        const files = Array.from({ length: MAX_SHARED_FILES + 2 }, (_, at) => native.shareFile(`${at}.txt`, 'x'))
        const address = await receiveShare(share({ files }), bridge)
        expect(new URL(address, 'https://x.invalid').searchParams.get('leftOut')).toBe('2')
        expect(native.calls.filter((call) => call.method === 'files.readPart')).toHaveLength(MAX_SHARED_FILES)
        expect(native.calls.filter((call) => call.method === 'files.release')).toHaveLength(MAX_SHARED_FILES + 2)
    })

    it('still arrives when its files cannot be read, and the page says so', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        native.fail('files.readPart', 'NotReadableError')
        expect(await receiveShare(share({ text: 'leeks', files: [native.shareFile('a.txt', 'x')] }), bridge)).toBe('/share?text=leeks&files=dropped')
        vi.restoreAllMocks()
    })

    it('is refused rather than kept short when a file ends early', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const file = native.shareFile('a.txt', 'abc')
        expect(await receiveShare(share({ files: [{ ...file, size: 10 }] }), bridge)).toBe('/share?files=dropped')
        vi.restoreAllMocks()
    })

    it('carries no more of its words than the page can use', async () => {
        const address = await receiveShare(share({ text: 'x'.repeat(1_000_000) }), bridge)
        expect(address.length).toBeLessThan(MAX_QUICK_NOTE_LENGTH * 3)
        expect(address.length).toBeGreaterThan(MAX_QUICK_NOTE_LENGTH)
    })
})

describe('launches', () => {
    it('are carried out by kind', async () => {
        native.disk.write('Notes/soup.md', new Uint8Array([1]))
        await carryOut({ kind: 'link', url: 'etherpk:/graph/sync/abc' }, bridge, handlers)
        await carryOut(share({ text: 'leeks' }), bridge, handlers)
        await carryOut({ kind: 'file', file: native.grantFile('Notes/soup.md') }, bridge, handlers)
        await carryOut({ kind: 'folder', folder: native.grantFolder('Notes') }, bridge, handlers)
        expect(did).toEqual(['goto /graph/sync/abc', 'goto /share?text=leeks', 'file soup.md', 'folder Notes'])
    })

    it('waiting at the start are carried out first, and say whether the app went anywhere', async () => {
        native.launch({ kind: 'link', url: 'etherpk:/graph/sync/abc' })
        const { first, stop } = listenForLaunches(bridge, handlers)
        expect(await first).toBe(true)
        expect(did).toEqual(['goto /graph/sync/abc'])
        stop()
        expect(await listenForLaunches(bridge, handlers).first).toBe(false)
    })

    it('that lead nowhere say so, and do not count as going somewhere', async () => {
        native.launch({ kind: 'link', url: 'etherpk:/auth/login' })
        expect(await listenForLaunches(bridge, handlers).first).toBe(false)
        expect(did).toHaveLength(1)
        expect(did[0]).toMatch(/^say That link/)
    })

    it('handed over later are carried out then, in order, and once each', async () => {
        const { first } = listenForLaunches(bridge, handlers)
        await first
        for (const name of ['a', 'b', 'c']) native.launch({ kind: 'link', url: `etherpk:/graph/sync/${name}` })
        await settled()
        expect(did).toEqual(['goto /graph/sync/a', 'goto /graph/sync/b', 'goto /graph/sync/c'])
    })

    it('after one that fails are still carried out, and the person is told in plain words', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        handlers.openFolder = () => Promise.reject(new DOMException('x', 'NotAllowedError'))
        native.launch({ kind: 'folder', folder: native.grantFolder('Notes') })
        native.launch({ kind: 'link', url: 'etherpk:/graph/sync/abc' })
        expect(await listenForLaunches(bridge, handlers).first).toBe(true)
        expect(did).toEqual(['say That folder could not be opened. Use Open folder on the Graphs page.', 'goto /graph/sync/abc'])
        vi.restoreAllMocks()
    })
})
