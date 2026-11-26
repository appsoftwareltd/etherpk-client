/**
 * Where on the disk a path of the page is. The page names a folder by id and gives a relative path,
 * and this is the only module that turns the two into a real path.
 *
 * The rule for links: one that leads to somewhere inside the same folder is followed, and one that
 * leads out of it (or nowhere) is refused and never listed. Removing or moving a link acts on the link.
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { isMissing, NativeFailure } from '../failure.ts'

export interface Place {
    /** The folder's own real path. */
    root: string
    /** The entry itself. A link at the end of the path is not followed. */
    path: string
    /** Whether something is there. A link counts. */
    exists: boolean
}

/** Windows compares paths without case. */
function comparable(path: string, platform: NodeJS.Platform): string {
    return platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Whether `path` is `root` or below it, as real paths of the platform. The platform is the running
 * one, and a test names another to try Windows' rules (backslashes, no case) on any computer.
 */
export function isInside(root: string, path: string, platform: NodeJS.Platform = process.platform): boolean {
    const separator = platform === process.platform ? sep : platform === 'win32' ? '\\' : '/'
    const [outer, inner] = [comparable(root, platform), comparable(path, platform)]
    return inner === outer || inner.startsWith(outer.endsWith(separator) ? outer : outer + separator)
}

/** The folder's real path, or `NotFoundError` when it is not a directory any more. */
export async function realRoot(path: string): Promise<string> {
    try {
        const root = await realpath(path)
        if ((await stat(root)).isDirectory()) return root
    } catch (error) {
        if (!isMissing(error)) throw error
    }
    throw new NativeFailure('NotFoundError', 'The folder is gone.')
}

/**
 * The name on disk that `segment` means in `dir`: itself, or the entry that is the same text in
 * another Unicode form, as macOS and some sync clients leave behind.
 */
async function nameOnDisk(dir: string, segment: string): Promise<{ name: string; exists: boolean }> {
    try {
        await lstat(join(dir, segment))
        return { name: segment, exists: true }
    } catch (error) {
        if (!isMissing(error)) throw error
    }
    // eslint-disable-next-line no-control-regex -- plain ASCII has one form only, so the folder is not read for it
    if (/^[\x00-\x7f]*$/.test(segment)) return { name: segment, exists: false }
    const names = await readdir(dir).catch((error: unknown) => {
        if (isMissing(error)) return []
        throw error
    })
    const other = names.find((name) => name.normalize('NFC') === segment)
    return other === undefined ? { name: segment, exists: false } : { name: other, exists: true }
}

/** The real path of a directory on the way, refused when a link takes it out of the folder. */
async function enter(root: string, path: string): Promise<string> {
    const real = await realpath(path)
    if (!isInside(root, real)) throw new NativeFailure('SecurityError', 'The path leads out of the folder.')
    return real
}

export async function placeOf(root: string, segments: string[]): Promise<Place> {
    let dir = root
    for (const [index, segment] of segments.entries()) {
        const { name, exists } = await nameOnDisk(dir, segment)
        const path = join(dir, name)
        if (index === segments.length - 1) return { root, path, exists }
        // Below a directory that is not there, nothing is there and no link can lead out.
        if (!exists) return { root, path: join(path, ...segments.slice(index + 1)), exists: false }
        dir = await enter(root, path)
    }
    return { root, path: root, exists: true }
}

/** The real path behind an existing entry, links followed while they stay inside the folder. */
export async function followed(place: Place): Promise<string> {
    let real: string
    try {
        real = await realpath(place.path)
    } catch (error) {
        if (isMissing(error) && (await lstat(place.path).then(() => true, () => false))) {
            throw new NativeFailure('SecurityError', 'The link leads nowhere in the folder.')
        }
        throw error
    }
    if (!isInside(place.root, real)) throw new NativeFailure('SecurityError', 'The link leads out of the folder.')
    return real
}
