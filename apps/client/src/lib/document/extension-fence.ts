/**
 * [[Extension Fence]]s (ADR 0138): a fence whose info word is `<extension id>.<name>` holds an
 * extension's data, such as a drawing's elements. Every reader of a document decides from the info
 * word alone, with no extension running, so the editor, the index, Semantic Search, the publisher
 * and the Headless Client always agree: the body is never read as writing, never searched, and never
 * published as code.
 *
 * Framework-free, so the index worker, the publisher and the Headless Client read it as the editor
 * does.
 */
import { fencedBlocks, fencedBlockTree, fenceLineInfo } from './fenced-code'

/** An extension's id or a name under it: lowercase letters, digits and hyphens, from a letter. */
const NAME = '[a-z][a-z0-9-]*'
const EXTENSION_FENCE_INFO = new RegExp(`^${NAME}\\.${NAME}$`)

/** Whether an info word names an Extension Fence: an extension's id, a dot and a name. */
export function isExtensionFenceInfo(info: string): boolean {
    return EXTENSION_FENCE_INFO.test(info)
}

/** The extension an Extension Fence's info word names: the part before the dot. */
export function extensionOfFence(info: string): string {
    return info.slice(0, info.indexOf('.'))
}

/** Each complete, outermost Extension Fence in `lines`, by its opener's and closer's 0-based lines. */
export function extensionFences(lines: readonly string[]): { start: number; end: number; info: string }[] {
    const out: { start: number; end: number; info: string }[] = []
    const { sorted, parent } = fencedBlockTree(fencedBlocks(lines))
    sorted.forEach((block, i) => {
        if (parent[i] !== -1) return
        const info = fenceLineInfo(lines[block.start])?.info ?? ''
        if (isExtensionFenceInfo(info)) out.push({ start: block.start, end: block.end, info })
    })
    return out
}
