/**
 * Rotating a stored picture by quarter turns (ADR 0027, amended 2026-11-27).
 *
 * An [[Asset]]'s bytes never change: every device keeps its own copy and trusts it, a folder graph
 * names a file by the hash of its bytes, and a synced graph checks each file against the hash it was
 * stored with. So a rotation saves the turned picture as a new Asset, and moves every reference to
 * the old one that EtherPK can read onto the new one, in every document, since a person who turns a
 * picture wants it turned wherever it shows. The old Asset is left as it was, so an Undo moves the
 * references back. A [[Protected Document]] is not read here, as a rename does not read one (ADR
 * 0066), so it keeps showing the old picture, which still loads.
 *
 * Plain TypeScript over injected parts, so the sequence tests without a graph. The pixels are turned
 * by `view/image-rotate-canvas.ts` in a browser.
 */

import { linkRenameEdits, type LinkEdit } from './pdf/rename-links'

/** A stored picture a canvas can turn without losing anything but compression: PNG, JPEG or WebP. */
const ROTATABLE = /^\.\.\/assets\/[^?#]+\.(?:png|jpe?g|webp)(?:[?#].*)?$/i

/** Whether the reference is a stored picture that can be rotated. A GIF would lose its frames and an SVG become pixels. */
export function canRotateImageRef(ref: string): boolean {
    return ROTATABLE.test(ref.trim())
}

/** The quarter turns after one more turn clockwise: back to none after four. */
export function nextQuarterTurns(turns: number): number {
    return (turns + 1) % 4
}

const EXTENSION_OF_TYPE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** The rotated picture's file name: the same name, with the extension of the format it was saved in. */
export function rotatedFileName(name: string, type: string): string {
    const extension = EXTENSION_OF_TYPE[type] ?? 'png'
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    return `${stem}.${extension}`
}

/** A link's `#page=` and the like, which follows the link to its new target. */
const fragmentOf = (target: string) => (target.includes('#') ? target.slice(target.indexOf('#')) : '')

/**
 * The edits to `text` that point every reference to the Asset `fromId` at `toRef`, last first. The
 * words of each link and a picture's size hint stay as written.
 */
export function moveReferenceEdits(text: string, identify: (ref: string) => string | null, fromId: string, toRef: string): LinkEdit[] {
    return linkRenameEdits(text, {
        names: (target) => identify(target) === fromId,
        newTarget: (target) => `${toRef}${fragmentOf(target)}`,
        oldNames: [],
        newName: '',
    })
}

export interface RotationDeps {
    /** The Asset a reference names, or null for one that is none. */
    identify(ref: string): string | null
    readBytes(ref: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string; type: string } | null>
    /** Turn the picture `turns` quarter turns clockwise, in the format given or the nearest this browser writes. */
    rotate(bytes: Uint8Array<ArrayBuffer>, type: string, turns: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }>
    save(file: { name: string; bytes: Uint8Array<ArrayBuffer>; type: string }): Promise<{ ref: string }>
    /** The documents the index has holding a reference to the Asset, or null while it is building. */
    documentsUsing(assetId: string): Promise<readonly string[] | null>
    /** Apply the edits `edits` works out from a document's text, to that document. */
    rewrite(concept: string, edits: (text: string) => LinkEdit[]): Promise<void>
}

export interface RotationRequest {
    ref: string
    turns: number
    /** The document it was rotated in, which holds a reference whether or not the index has caught up. */
    concept: string
}

export interface Rotation {
    fromRef: string
    fromId: string
    toRef: string
    toId: string
    /** The documents whose references moved, the one it was rotated in first. */
    documents: string[]
}

/** Save the picture turned, and move the references to it. Null for a whole number of turns. */
export async function rotateAsset(deps: RotationDeps, request: RotationRequest): Promise<Rotation | null> {
    const turns = ((request.turns % 4) + 4) % 4
    if (turns === 0) return null
    const fromId = deps.identify(request.ref)
    if (fromId === null) throw new Error('This picture is not stored in the graph, so it cannot be rotated.')
    // Asked first, so a graph still being read saves nothing it could not then point to.
    const using = await deps.documentsUsing(fromId)
    if (using === null) throw new Error('This graph is still being read. Try again in a moment.')
    const source = await deps.readBytes(request.ref)
    if (source === null) throw new Error('The picture could not be read, so it was not rotated.')
    const rotated = await deps.rotate(source.bytes, source.type, turns)
    const saved = await deps.save({ name: rotatedFileName(source.name, rotated.type), bytes: rotated.bytes, type: rotated.type })
    const toId = deps.identify(saved.ref)
    if (toId === null) throw new Error('The rotated picture was saved under a name EtherPK cannot read.')
    const documents = [request.concept, ...using.filter((concept) => concept !== request.concept)]
    for (const concept of documents) await deps.rewrite(concept, (text) => moveReferenceEdits(text, deps.identify, fromId, saved.ref))
    return { fromRef: request.ref, fromId, toRef: saved.ref, toId, documents }
}

/** Move the references a rotation moved back to the old picture, which the rotation never changed. */
export async function undoRotation(deps: Pick<RotationDeps, 'identify' | 'rewrite'>, rotation: Rotation): Promise<void> {
    for (const concept of rotation.documents) {
        await deps.rewrite(concept, (text) => moveReferenceEdits(text, deps.identify, rotation.toId, rotation.fromRef))
    }
}
