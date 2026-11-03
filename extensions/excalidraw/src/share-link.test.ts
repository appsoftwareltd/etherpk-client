import { deflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { type ElementRecord, elementLine, headerLine, readDrawing } from './format'
import { fetchSharedDrawing, ImportError, parseShareLink, pastedDrawing, planImport, shareLinkIn } from './share-link'

// A scene encoded as excalidraw.com encodes one when it makes a share link, so the reader is checked
// against that layout: the buffers joined with their lengths, the contents deflated, then encrypted
// with AES-GCM under the key the link carries. Every name and shape here is invented.

const ID = 'AbC123_-xyz'
const LINK = `https://excalidraw.com/#json=${ID},${'k'.repeat(22)}`

const shape = (id: string, extra: Record<string, unknown> = {}): ElementRecord => ({ id, type: 'rectangle', version: 3, versionNonce: 7, index: `a${id}`, x: 0, y: 0, width: 40, height: 20, ...extra })

/** Buffers joined as excalidraw.com joins them: a version, then each buffer after its length. */
function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(4 + buffers.reduce((sum, buffer) => sum + 4 + buffer.byteLength, 0))
    const view = new DataView(out.buffer)
    view.setUint32(0, 1)
    let at = 4
    for (const buffer of buffers) {
        view.setUint32(at, buffer.byteLength)
        out.set(buffer, at + 4)
        at += 4 + buffer.byteLength
    }
    return out
}

async function newKey(): Promise<{ key: CryptoKey; k: string }> {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt'])
    const jwk = await crypto.subtle.exportKey('jwk', key)
    return { key, k: jwk.k! }
}

const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

/** A scene as excalidraw.com stores it now (version 2: deflated, then encrypted). */
async function encodeScene(scene: unknown, key: CryptoKey): Promise<Uint8Array> {
    const contents = concatBuffers(utf8(null), utf8(scene))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, deflateSync(contents)))
    return concatBuffers(utf8({ version: 2, compression: 'pako@1', encryption: 'AES-GCM' }), iv, encrypted)
}

/** A scene as excalidraw.com stored one before that: the IV, then the encrypted JSON. */
async function encodeLegacyScene(scene: unknown, key: CryptoKey): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(scene)))
    const out = new Uint8Array(12 + encrypted.byteLength)
    out.set(iv)
    out.set(encrypted, 12)
    return out
}

function serving(bytes: Uint8Array | null, status = 200): { fetch: typeof fetch; asked: string[] } {
    const asked: string[] = []
    const fake = (async (input: RequestInfo | URL) => {
        asked.push(String(input))
        if (!bytes) return new Response('missing', { status })
        return new Response(bytes as Uint8Array<ArrayBuffer>, { status })
    }) as typeof fetch
    return { fetch: fake, asked }
}

describe('an excalidraw.com share link', () => {
    it('is read from the address excalidraw.com gives, and nothing else', () => {
        expect(parseShareLink(LINK)).toEqual({ id: ID, key: 'k'.repeat(22), link: LINK })
        for (const text of [`${LINK} and more`, 'https://excalidraw.com/#room=abc,def', 'https://example.com/#json=a,b', `http://excalidraw.com/#json=${ID},key`]) {
            expect(parseShareLink(text), text).toBeNull()
        }
    })

    it('is found on a line of its own in a drawing', () => {
        const body = [headerLine({ type: 'excalidraw.drawing', version: 1, id: 'k3j9x2q8ab' }), `  ${LINK}  `]
        expect(shareLinkIn(body)).toMatchObject({ id: ID, line: 1 })
        expect(shareLinkIn([body[0]])).toBeNull()
    })

    it('opens to the drawing it holds, without its images, fetched from json.excalidraw.com only', async () => {
        const { key, k } = await newKey()
        const scene = { type: 'excalidraw', elements: [shape('1'), shape('2', { isDeleted: true }), shape('3', { type: 'image', fileId: 'f1' })], appState: { viewBackgroundColor: '#fdf6e3' } }
        const server = serving(await encodeScene(scene, key))
        const shared = await fetchSharedDrawing({ id: ID, key: k, link: LINK }, server.fetch)
        expect(server.asked).toEqual([`https://json.excalidraw.com/api/v2/${ID}`])
        expect(shared.elements.map((element) => element.id)).toEqual(['1'])
        expect(shared.skippedImages).toBe(1)
        expect(shared.background).toBe('#fdf6e3')
    })

    it('opens a drawing shared in the older layout', async () => {
        const { key, k } = await newKey()
        const server = serving(await encodeLegacyScene({ elements: [shape('1')] }, key))
        expect((await fetchSharedDrawing({ id: ID, key: k, link: LINK }, server.fetch)).elements.map((element) => element.id)).toEqual(['1'])
    })

    it('says why when it cannot be opened', async () => {
        const { key } = await newKey()
        const { k: otherKey } = await newKey()
        const bytes = await encodeScene({ elements: [shape('1')] }, key)
        await expect(fetchSharedDrawing({ id: ID, key: otherKey, link: LINK }, serving(bytes).fetch)).rejects.toMatchObject({ reason: 'key' })
        await expect(fetchSharedDrawing({ id: ID, key: otherKey, link: LINK }, serving(null, 404).fetch)).rejects.toMatchObject({ reason: 'gone' })
        await expect(fetchSharedDrawing({ id: ID, key: otherKey, link: LINK }, serving(null, 503).fetch)).rejects.toMatchObject({ reason: 'server' })
        const offline = (async () => {
            throw new TypeError('Failed to fetch')
        }) as typeof fetch
        await expect(fetchSharedDrawing({ id: ID, key: otherKey, link: LINK }, offline)).rejects.toBeInstanceOf(ImportError)
        await expect(fetchSharedDrawing({ id: ID, key: otherKey, link: LINK }, offline)).rejects.toMatchObject({ reason: 'network' })
    })

    it('is replaced by the drawing it held, which joins any shapes already there', () => {
        const header = headerLine({ type: 'excalidraw.drawing', version: 1, id: 'k3j9x2q8ab', background: '#ffffff' })
        const body = [header, LINK, elementLine(shape('0'))]
        const edits = planImport(body, { elements: [shape('1'), shape('2')], background: '#fdf6e3' })
        const after = [...body]
        for (const edit of edits) {
            if (edit.kind === 'insert') after.splice(edit.line, 0, edit.text)
            else {
                expect(after[edit.line]).toBe(edit.expect)
                if (edit.kind === 'replace') after[edit.line] = edit.text
                else after.splice(edit.line, 1)
            }
        }
        expect(after).not.toContain(LINK)
        const drawing = readDrawing(after)
        expect(drawing.header?.background).toBe('#fdf6e3')
        expect(drawing.elements.map((element) => element.id)).toEqual(['0', '1', '2'])
    })
})

describe('pasting into a document', () => {
    const newId = () => 'k3j9x2q8ab'

    it('makes a share link a new drawing holding the link, to import', () => {
        expect(pastedDrawing(`  ${LINK}\n`, newId)).toEqual({ lines: [headerLine({ type: 'excalidraw.drawing', version: 1, id: 'k3j9x2q8ab', background: '#ffffff' }), LINK], skippedImages: 0 })
    })

    it('makes shapes copied on excalidraw.com a new drawing, one line each, without images', () => {
        const copied = { type: 'excalidraw/clipboard', elements: [shape('1'), shape('2', { type: 'image', fileId: 'f1' }), shape('3', { isDeleted: true })], files: {} }
        const expected = { lines: [headerLine({ type: 'excalidraw.drawing', version: 1, id: 'k3j9x2q8ab', background: '#ffffff' }), elementLine(shape('1'))], skippedImages: 1 }
        expect(pastedDrawing(JSON.stringify(copied), newId)).toEqual(expected)
        expect(pastedDrawing(JSON.stringify(copied, null, 2), newId)).toEqual(expected)
    })

    it('leaves anything else to the editor', () => {
        for (const text of ['https://excalidraw.com/', '{"type":"excalidraw/clipboard","elements":[]}', '{"type":"excalidraw/clipboard"', '{"type":"garden","note":"excalidraw/clipboard","elements":[{}]}', 'Garden beds']) {
            expect(pastedDrawing(text, newId), text).toBeNull()
        }
    })
})
