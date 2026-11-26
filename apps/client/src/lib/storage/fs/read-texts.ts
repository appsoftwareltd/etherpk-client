/**
 * Reading many of a graph's files. Where the folder is reached through an installed app's shell each
 * read is a round trip, and on a phone each is slow, so files are read many at a time. In a browser
 * they are read one by one, which holds one text at a time.
 */
import type { DirectoryAdapter, Subdir } from './directory-adapter'

const READ_AT_ONCE = 100

/** Cut `items` into the runs to read together. */
export function runsFor<T>(adapter: DirectoryAdapter, items: readonly T[]): T[][] {
    const length = adapter.readMany ? READ_AT_ONCE : 1
    const runs: T[][] = []
    for (let at = 0; at < items.length; at += length) runs.push(items.slice(at, at + length))
    return runs
}

/** The texts of these files of one directory, in order, with null for one no longer there. Any other failure is the caller's. */
export async function readTexts(adapter: DirectoryAdapter, subdir: Subdir, names: string[]): Promise<(string | null)[]> {
    if (names.length === 0) return []
    if (adapter.readMany) return (await adapter.readMany(subdir, names)).map((read) => read?.text ?? null)
    const texts: (string | null)[] = []
    for (const name of names) texts.push(await readUnlessGone(adapter, subdir, name))
    return texts
}

async function readUnlessGone(adapter: DirectoryAdapter, subdir: Subdir, name: string): Promise<string | null> {
    try {
        return (await adapter.read(subdir, name)).text
    } catch (error) {
        if ((error as DOMException | null)?.name === 'NotFoundError') return null
        throw error
    }
}

/**
 * The texts of these files wherever they are, in order, with null for one that is gone or cannot be
 * read. A file that cannot be read is logged and skipped, so one locked file does not stop an index.
 *
 * A folder that is gone is not skipped. Reading together answers null for a missing file, so a
 * `NotFoundError` from it is the folder's own, and an index built past it would hold no documents.
 */
export async function readableTexts(adapter: DirectoryAdapter, files: readonly { subdir: Subdir; fileName: string }[]): Promise<(string | null)[]> {
    const { readMany } = adapter
    const bySubdir = new Map<Subdir, string[]>()
    for (const { subdir, fileName } of files) bySubdir.set(subdir, [...(bySubdir.get(subdir) ?? []), fileName])
    const found = new Map<string, string | null>()
    if (readMany && files.length > 1) {
        for (const [subdir, names] of bySubdir) {
            const read = await readMany(subdir, names).catch((error: unknown) => {
                if ((error as DOMException | null)?.name === 'NotFoundError') throw error
                // One file made the run fail: each is read by itself below.
                return null
            })
            read?.forEach((file, index) => found.set(`${subdir}/${names[index]}`, file?.text ?? null))
        }
    }
    const texts: (string | null)[] = []
    for (const { subdir, fileName } of files) {
        const key = `${subdir}/${fileName}`
        texts.push(found.has(key) ? found.get(key)! : await readOrSkip(adapter, subdir, fileName))
    }
    return texts
}

async function readOrSkip(adapter: DirectoryAdapter, subdir: Subdir, name: string): Promise<string | null> {
    try {
        return (await adapter.read(subdir, name)).text
    } catch (error) {
        // Gone since the listing: a rename moved it, and its own signal reads it again.
        if ((error as DOMException | null)?.name === 'NotFoundError') return null
        console.warn(`[filesystem] skipped ${subdir}/${name}, which could not be read`, error)
        return null
    }
}
