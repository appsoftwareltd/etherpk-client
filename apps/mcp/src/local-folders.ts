/**
 * Where the tools may write on this machine. A tool argument is chosen by the agent, and the agent
 * can be steered by what it reads in the notes, so a folder it names is only ever a place under
 * the graph's downloads directory (ADR 0086 keeps even that choice from `publish`). A name that
 * resolves outside it, directly or through a symbolic link, is refused.
 */

import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** A folder the agent named that is not under the base; the tools report it as `invalid_argument`. */
export class FolderRefused extends Error {}

/** Whether `child` is `parent` or a path beneath it; both already resolved. */
export function within(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** The nearest part of `path` that exists on disk: the path itself, or its closest existing parent. */
async function existingPart(path: string): Promise<string> {
    let at = path
    for (;;) {
        try {
            await lstat(at)
            return at
        } catch {
            const up = dirname(at)
            if (up === at) return at
            at = up
        }
    }
}

/**
 * The folder the agent asked for under `base`, or `fallback` (a path relative to `base`) when it
 * named none. A relative name is taken relative to `base`; an absolute one must already be under
 * it. Checked twice: as written, and after resolving every symbolic link in the part that exists.
 */
export async function folderUnder(base: string, requested: string | undefined, fallback: string): Promise<string> {
    const root = resolve(base)
    const wanted = requested?.trim() ? requested.trim() : fallback
    const target = resolve(root, wanted)
    if (!within(root, target)) throw new FolderRefused(`"${wanted}" is outside ${root}. Name a folder under it, or leave it out for the default.`)
    await mkdir(root, { recursive: true })
    const realRoot = await realpath(root)
    const realExisting = await realpath(await existingPart(target))
    if (!within(realRoot, realExisting)) throw new FolderRefused(`"${wanted}" leads outside ${root} through a symbolic link.`)
    return target
}

/**
 * Whether a preview page may load `url`: its own files and inline data, nothing else. A theme's
 * script runs when the preview is photographed, and a theme can come from a collaborator or a URL,
 * so the page is kept off the network and away from the rest of the disk.
 */
export function previewRequestAllowed(url: string, folder: string): boolean {
    if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return true
    const own = pathToFileURL(folder.endsWith(sep) ? folder : folder + sep).href
    return url.startsWith(own)
}
