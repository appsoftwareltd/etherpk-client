/**
 * An EBook's state on a [[Filesystem Backend]]: `etherpk/ebook-<hash>.json` beside `bookmarks.json`, the
 * same file a [[Local Mirror]] and an [[Export]] carry for a synced graph. One browser owns the folder,
 * so there is no concurrent peer and the whole file is written each time.
 *
 * The [[Reading Place]] stays out of the file and on the device, because a write per reading session
 * would dirty a folder tracked in git (ADR 0176). A file that is there but cannot be read is never
 * written over: every write is then refused with the reason.
 */
import type { DirectoryAdapter } from '#lib/storage/fs/directory-adapter.js'

import type { EbookDeviceMemory } from './ebook-device-memory'
import { emptyEbookState, sanitizeEbookState, type EbookHighlight, type EbookPlace, type EbookState, type EbookStateHost, type EbookStateStore } from './ebook-state'

/** The state file of an EBook, under `etherpk/`. */
export const ebookStateFileName = (hash: string): string => `ebook-${hash}.json`

/** A name {@link ebookStateFileName} wrote: its hash, or `null`. */
export function ebookHashFromStateFile(name: string): string | null {
    return /^ebook-([0-9a-f]{64})\.json$/.exec(name)?.[1] ?? null
}

/** The file's text: pretty-printed and newline-terminated, the mirror's shape too. */
export function ebookStateFileText(state: Pick<EbookState, 'highlights'>): string {
    return `${JSON.stringify({ version: 1, highlights: state.highlights }, null, 2)}\n`
}

/** Merge imported state into what a file holds, by id: importing the same export twice adds nothing. */
export function mergeEbookState(held: EbookState, incoming: EbookState): EbookState {
    const heldIds = new Set(held.highlights.map((highlight) => highlight.id))
    return { ...held, highlights: [...held.highlights, ...incoming.highlights.filter((highlight) => !heldIds.has(highlight.id))] }
}

/** Each imported EBook's state, merged by id into a folder graph's files. */
export async function importEbookStateFiles(adapter: DirectoryAdapter, states: readonly { hash: string; state: EbookState }[] = []): Promise<void> {
    for (const { hash, state } of states) {
        const name = ebookStateFileName(hash)
        const held = (await adapter.exists('etherpk', name)) ? sanitizeEbookState(JSON.parse((await adapter.read('etherpk', name)).text)) : emptyEbookState()
        await adapter.write('etherpk', name, ebookStateFileText(mergeEbookState(held, state)))
    }
}

const WRITE_DELAY_MS = 300

export interface FileEbookStateDeps {
    adapter: DirectoryAdapter
    memory: EbookDeviceMemory
    graphId: string
}

async function readFile(adapter: DirectoryAdapter, name: string): Promise<{ state: EbookState; refused: string | null }> {
    try {
        if (!(await adapter.exists('etherpk', name))) return { state: emptyEbookState(), refused: null }
        const parsed: unknown = JSON.parse((await adapter.read('etherpk', name)).text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an EBook state file')
        return { state: sanitizeEbookState(parsed), refused: null }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return { state: emptyEbookState(), refused: `etherpk/${name} could not be read (${reason}), so changes to this EBook are not being saved. Fix or remove the file.` }
    }
}

async function openFileState(deps: FileEbookStateDeps, hash: string): Promise<EbookStateStore> {
    const { adapter, memory, graphId } = deps
    const name = ebookStateFileName(hash)
    const read = await readFile(adapter, name)
    let state = read.state
    let refused = read.refused
    const remembered = memory.ebook(graphId, hash).place
    if (remembered) state = { ...state, place: remembered }

    const listeners = new Set<() => void>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let dirty = false
    let writes: Promise<unknown> = Promise.resolve()
    const changed = () => {
        for (const listener of listeners) listener()
    }

    function write(): Promise<unknown> {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (!dirty || refused) return writes
        dirty = false
        const text = ebookStateFileText(state)
        // Writes run one at a time, so an older one can never land after a newer one.
        writes = writes.then(async () => {
            try {
                await adapter.write('etherpk', name, text)
            } catch (error) {
                refused = `Changes to this EBook could not be saved to etherpk/${name} (${error instanceof Error ? error.message : String(error)}).`
                changed()
            }
        })
        return writes
    }

    function schedule(highlights: EbookHighlight[]): void {
        state = { ...state, highlights }
        changed()
        if (refused) return
        dirty = true
        if (timer === undefined) timer = setTimeout(() => void write(), WRITE_DELAY_MS)
    }

    return {
        state: () => state,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        putHighlight: (highlight) => schedule([...state.highlights.filter((held) => held.id !== highlight.id), highlight]),
        removeHighlight: (id) => schedule(state.highlights.filter((held) => held.id !== id)),
        setPlace(place: EbookPlace) {
            state = { ...state, place }
            memory.updateEbook(graphId, hash, { place })
        },
        problem: () => refused,
        async flush() {
            await write()
        },
        async close() {
            await write()
            listeners.clear()
        },
    }
}

export function createFileEbookStateHost(deps: FileEbookStateDeps): EbookStateHost {
    return {
        open: (hash) => openFileState(deps, hash),
        async forget(hash) {
            const name = ebookStateFileName(hash)
            if (await deps.adapter.exists('etherpk', name)) await deps.adapter.remove('etherpk', name)
            deps.memory.forgetEbook(deps.graphId, hash)
        },
    }
}
