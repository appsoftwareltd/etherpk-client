/**
 * Drawings from excalidraw.com: a share link, and shapes copied there.
 *
 * A share link (`https://excalidraw.com/#json=<id>,<key>`) names a drawing excalidraw.com keeps,
 * encrypted, at `https://json.excalidraw.com/api/v2/<id>`, and carries the key that opens it after
 * the `#`, which a browser never sends to any server. Pasted into a document, the link becomes a new
 * drawing holding it, which the widget offers to import. Nothing is fetched until the person asks:
 * then the drawing is fetched, opened here with the browser's own decryption and decompression, and
 * written into the document in the link's place, so the key leaves the document and the drawing no
 * longer depends on excalidraw.com keeping it.
 *
 * Shapes copied on excalidraw.com reach the clipboard as JSON (`{"type":"excalidraw/clipboard",…}`),
 * which pasted on a line of its own becomes a new drawing of them.
 *
 * A drawing in a document holds no images, so images in either are left out, and the person is told.
 * Pure apart from `fetch`, so every rule here is tested in Node.
 */
import type { FenceEdit } from '@appsoftwareltd/etherpk-extension-api'

import { type DrawingHeader, type ElementRecord, elementLine, headerLine, newDrawingId, planWrite, readDrawing } from './format'

/** A share link: the drawing's id on excalidraw.com's server, and the key that opens it. */
export interface ShareLink {
    id: string
    key: string
    /** The link as written. */
    link: string
}

const SHARE_LINK = /^https:\/\/excalidraw\.com\/#json=([A-Za-z0-9_-]+),([A-Za-z0-9_-]+)$/
const SHARE_SERVER = 'https://json.excalidraw.com/api/v2/'
/** The most a shared drawing may be, as fetched and once opened. */
const MAX_FETCHED = 10 * 1024 * 1024
const MAX_OPENED = 50 * 1024 * 1024

/** The share link `text` is, and nothing more, or null. */
export function parseShareLink(text: string): ShareLink | null {
    const match = SHARE_LINK.exec(text)
    return match ? { id: match[1], key: match[2], link: text } : null
}

/** The share link a drawing's body holds on a line of its own, with that line's number, or null. */
export function shareLinkIn(body: readonly string[]): (ShareLink & { line: number }) | null {
    for (let line = 0; line < body.length; line++) {
        const link = parseShareLink(body[line].trim())
        if (link) return { ...link, line }
    }
    return null
}

/** Why a shared drawing could not be imported. */
export type ImportFailure = 'network' | 'gone' | 'server' | 'key' | 'format'

export class ImportError extends Error {
    constructor(
        readonly reason: ImportFailure,
        message: string,
    ) {
        super(message)
        this.name = 'ImportError'
    }
}

/** What a shared drawing holds that a drawing in a document can: its shapes and its canvas colour. */
export interface SharedDrawing {
    elements: ElementRecord[]
    /** How many images it held, which are left out. */
    skippedImages: number
    background?: string
}

/** The buffers excalidraw.com joined: a version, then each buffer after its length. */
function splitBuffers(bytes: Uint8Array): Uint8Array[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (bytes.byteLength < 8 || view.getUint32(0) > 1) throw new Error('not joined buffers')
    const out: Uint8Array[] = []
    let at = 4
    while (at < bytes.byteLength) {
        if (at + 4 > bytes.byteLength) throw new Error('a buffer with no length')
        const size = view.getUint32(at)
        at += 4
        if (at + size > bytes.byteLength) throw new Error('a buffer longer than the whole')
        out.push(bytes.subarray(at, at + size))
        at += size
    }
    return out
}

async function decrypt(key: string, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey('jwk', { alg: 'A128GCM', ext: true, k: key, key_ops: ['encrypt', 'decrypt'], kty: 'oct' }, { name: 'AES-GCM', length: 128 }, false, ['decrypt'])
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> }, cryptoKey, data as Uint8Array<ArrayBuffer>))
}

/** Inflate zlib-wrapped data (pako's `deflate`), refusing more than `MAX_OPENED` bytes. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'))
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > MAX_OPENED) throw new ImportError('format', 'This drawing is too large to import.')
        chunks.push(chunk)
    }
    const out = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.byteLength
    }
    return out
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/**
 * The scene a share link's bytes hold, in the layout excalidraw.com writes now: what the encoding is,
 * the IV and the encrypted contents, which are the contents' metadata and the scene, joined and
 * deflated. Failing that, in the layout it wrote before: the IV and the encrypted scene, or, older
 * still, the scene encrypted under an IV of zeros.
 */
async function openScene(bytes: Uint8Array, key: string): Promise<unknown> {
    try {
        const [encoding, iv, encrypted] = splitBuffers(bytes)
        const info = JSON.parse(text(encoding)) as { compression?: string }
        const opened = await decrypt(key, iv, encrypted)
        const [, scene] = splitBuffers(info.compression ? await inflate(opened) : opened)
        return JSON.parse(text(scene))
    } catch (error) {
        if (error instanceof ImportError) throw error
    }
    let opened: Uint8Array
    try {
        opened = await decrypt(key, bytes.subarray(0, 12), bytes.subarray(12))
    } catch {
        opened = await decrypt(key, new Uint8Array(12), bytes)
    }
    return JSON.parse(text(opened))
}

/** Fetch the drawing a share link names and open it. Throws an `ImportError` saying why it cannot. */
export async function fetchSharedDrawing(link: ShareLink, fetchImpl: typeof fetch = fetch): Promise<SharedDrawing> {
    let response: Response
    try {
        response = await fetchImpl(`${SHARE_SERVER}${link.id}`)
    } catch {
        throw new ImportError('network', "excalidraw.com couldn't be reached. Check your connection, then try again.")
    }
    if (response.status === 404) throw new ImportError('gone', 'excalidraw.com no longer has this drawing.')
    if (!response.ok) throw new ImportError('server', `excalidraw.com answered with an error (HTTP ${response.status}). Try again later.`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FETCHED) throw new ImportError('format', 'This drawing is too large to import.')
    let scene: unknown
    try {
        scene = await openScene(bytes, link.key)
    } catch (error) {
        if (error instanceof ImportError) throw error
        throw new ImportError('key', "The link's key doesn't open this drawing. Check that the whole link was pasted.")
    }
    const elements = (scene as { elements?: unknown } | null)?.elements
    if (!Array.isArray(elements)) throw new ImportError('format', "excalidraw.com sent something that isn't a drawing.")
    const background = (scene as { appState?: { viewBackgroundColor?: unknown } }).appState?.viewBackgroundColor
    return { ...keptShapes(elements), ...(typeof background === 'string' ? { background } : {}) }
}

/** The shapes of a scene a drawing can hold: every element not deleted, less images, counted. */
function keptShapes(elements: readonly unknown[]): { elements: ElementRecord[]; skippedImages: number } {
    const shapes = elements.filter((value): value is ElementRecord => {
        const record = value as Record<string, unknown> | null
        return !!record && typeof record.id === 'string' && typeof record.type === 'string' && typeof record.version === 'number' && record.isDeleted !== true
    })
    const kept = shapes.filter((shape) => shape.type !== 'image')
    return { elements: kept, skippedImages: shapes.length - kept.length }
}

/**
 * The edits that write an imported drawing in its link's place: the link's line goes, the shapes
 * are added after any already there, and the canvas takes the shared drawing's colour.
 */
export function planImport(body: readonly string[], shared: Pick<SharedDrawing, 'elements' | 'background'>): FenceEdit[] {
    const found = shareLinkIn(body)
    const withoutLink = found ? body.filter((_, n) => n !== found.line) : [...body]
    const read = readDrawing(withoutLink)
    const header: DrawingHeader = { ...(read.header ?? { type: 'excalidraw.drawing', version: 1, id: newDrawingId() }), ...(shared.background ? { background: shared.background } : {}) }
    const edits: FenceEdit[] = found ? [{ kind: 'remove', line: found.line, expect: body[found.line] }] : []
    return [...edits, ...planWrite(withoutLink, { header, elements: [...read.elements, ...shared.elements] })]
}

/**
 * What pasted text becomes, as the lines of a new drawing: a share link, held to import, or shapes
 * copied on excalidraw.com. Null for anything else, which the editor pastes as it would.
 */
export function pastedDrawing(pasted: string, newId: () => string = newDrawingId): { lines: string[]; skippedImages: number } | null {
    const trimmed = pasted.trim()
    const header = () => headerLine({ type: 'excalidraw.drawing', version: 1, id: newId(), background: '#ffffff' })
    const link = parseShareLink(trimmed)
    if (link) return { lines: [header(), link.link], skippedImages: 0 }
    // Cheap checks first: every paste on an empty line asks, and most are not shapes.
    if (!trimmed.startsWith('{') || !trimmed.includes('"excalidraw/clipboard"')) return null
    let copied: unknown
    try {
        copied = JSON.parse(trimmed)
    } catch {
        return null
    }
    const elements = (copied as { type?: unknown; elements?: unknown }).elements
    if ((copied as { type?: unknown }).type !== 'excalidraw/clipboard' || !Array.isArray(elements)) return null
    const shapes = keptShapes(elements)
    if (shapes.elements.length === 0) return null
    return { lines: [header(), ...shapes.elements.map(elementLine)], skippedImages: shapes.skippedImages }
}
