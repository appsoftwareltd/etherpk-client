/**
 * The hidden `.etherpk` folder of a [[Plain Folder]] (ADR 0197): where EtherPK keeps what a person
 * added about the folder's files that is not in the files themselves, such as a highlight on a PDF
 * or a bookmarked line.
 *
 * **One file for each item**, at `.etherpk/<kind>/<id>.json`. Two people who each add a bookmark
 * add two files, so their changes merge in git without a conflict, where one shared list would
 * conflict on every change.
 *
 * **Nothing is written until the person adds something.** Opening a folder, reading its items and
 * closing it create nothing. The first write creates the folder and tells the caller, so the
 * person is told once where their highlights and bookmarks are kept.
 *
 * **An item that cannot be read is kept.** A file another program wrote badly, or one from a later
 * version, is left exactly as it is and reported, never removed or rewritten.
 */
import { type FolderTreeAdapter, isNotFound } from './folder-tree-adapter'
import { joinPath } from './plain-path'

export const STATE_DIRECTORY = '.etherpk'

/** One item as it is kept: its id is its file's name. */
export interface StateItem {
    id: string
    value: unknown
}

export interface PlainStateFolder {
    /** Every readable item of a kind, in the order of their ids. A kind nothing was kept under is empty. */
    list(kind: string): Promise<StateItem[]>
    /** Keep an item, replacing the one with its id. */
    put(kind: string, id: string, value: unknown): Promise<void>
    /** Remove an item. Removing one that is not there is not an error. */
    remove(kind: string, id: string): Promise<void>
    /** The items that could not be read, by path, since this folder was opened. */
    unreadable(): readonly string[]
}

export interface PlainStateFolderOptions {
    /** Called once, before the first write that creates `.etherpk` in a folder that had none. */
    onFirstWrite?: () => void
}

/** An id is a file name: letters, digits, `-` and `_` only, so it cannot name a path. */
export function isStateId(id: string): boolean {
    return /^[A-Za-z0-9_-]{1,120}$/.test(id)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function createPlainStateFolder(tree: FolderTreeAdapter, options: PlainStateFolderOptions = {}): PlainStateFolder {
    const bad = new Set<string>()
    /** Whether `.etherpk` exists: unknown until first asked. */
    let present: boolean | undefined
    /** Writes run one after another, so two changes to one item land in the order they were made. */
    let writes: Promise<unknown> = Promise.resolve()

    const kindPath = (kind: string) => joinPath(STATE_DIRECTORY, kind)
    const itemPath = (kind: string, id: string) => joinPath(kindPath(kind), `${id}.json`)

    function checked(kind: string, id?: string): void {
        if (!isStateId(kind)) throw new Error(`"${kind}" is not a kind of item`)
        if (id !== undefined && !isStateId(id)) throw new Error(`"${id}" cannot be an item's id`)
    }

    async function ensureDirectory(kind: string): Promise<void> {
        if (present === undefined) present = (await tree.stat(STATE_DIRECTORY)) !== null
        if (!present) {
            options.onFirstWrite?.()
            await tree.createDirectory(STATE_DIRECTORY)
            present = true
        }
        if ((await tree.stat(kindPath(kind))) === null) await tree.createDirectory(kindPath(kind))
    }

    const queued = <T>(work: () => Promise<T>): Promise<T> => {
        const run = writes.then(work, work)
        writes = run.catch(() => {})
        return run
    }

    return {
        async list(kind) {
            checked(kind)
            let entries
            try {
                entries = await tree.list(kindPath(kind))
            } catch (error) {
                if (isNotFound(error)) return []
                throw error
            }
            const items: StateItem[] = []
            for (const entry of entries) {
                if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
                const id = entry.name.slice(0, -'.json'.length)
                const path = joinPath(kindPath(kind), entry.name)
                if (!isStateId(id)) continue
                try {
                    items.push({ id, value: JSON.parse(decoder.decode((await tree.read(path)).bytes)) as unknown })
                    bad.delete(path)
                } catch (error) {
                    // Removed since it was listed: gone, not unreadable.
                    if (!isNotFound(error)) bad.add(path)
                }
            }
            return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        },

        put(kind, id, value) {
            checked(kind, id)
            return queued(async () => {
                await ensureDirectory(kind)
                // Keys in a fixed order and one to a line, so a change to an item is a small diff.
                await tree.write(itemPath(kind, id), encoder.encode(`${JSON.stringify(value, null, 2)}\n`))
            })
        },

        remove(kind, id) {
            checked(kind, id)
            return queued(async () => {
                try {
                    await tree.remove(itemPath(kind, id))
                } catch (error) {
                    if (!isNotFound(error)) throw error
                }
            })
        },

        unreadable: () => [...bad].sort(),
    }
}
