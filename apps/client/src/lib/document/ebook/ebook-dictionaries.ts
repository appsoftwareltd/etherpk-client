/**
 * Dictionaries a person adds for looking up a word in an EBook: StarDict packs, kept on this device and read
 * here, so a word looked up goes nowhere. A pack is large and belongs to the device, so it is not synced and
 * not in an Export. foliate's `StarDict` reads the files, and a pack's definitions reach the page only as text.
 */
import { inflateSync, strFromU8, unzipSync } from 'fflate'

import { writeFileContents } from '#lib/storage/fs/file-write.js'

const ROLES = ['ifo', 'idx', 'dict', 'syn'] as const
type Role = (typeof ROLES)[number]

/** Where a device keeps its packs. Each pack is a folder of up to four files, under its id. */
export interface DictionaryShelf {
    list(): Promise<string[]>
    write(id: string, role: Role, bytes: Uint8Array): Promise<void>
    read(id: string, role: Role): Promise<Blob | null>
    remove(id: string): Promise<void>
}

export interface AddedFile {
    name: string
    bytes: Uint8Array
}

export interface HeldDictionary {
    id: string
    name: string
}

export interface Definition {
    dictionary: string
    word: string
    text: string
}

const WHAT_A_PACK_HOLDS = 'A dictionary is a StarDict pack: an .ifo, an .idx and a .dict.dz file, chosen together or in a .zip.'

function roleOf(name: string): Role | null {
    const lower = name.toLowerCase()
    if (lower.endsWith('.ifo')) return 'ifo'
    if (lower.endsWith('.idx')) return 'idx'
    if (lower.endsWith('.dict.dz')) return 'dict'
    if (lower.endsWith('.syn')) return 'syn'
    return null
}

/** The files a person chose, with any .zip opened. */
function expandZips(files: readonly AddedFile[]): AddedFile[] {
    return files.flatMap((file) => (file.name.toLowerCase().endsWith('.zip') ? Object.entries(unzipSync(file.bytes)).map(([name, bytes]) => ({ name, bytes })) : [file]))
}

/** The fields of a pack's .ifo, which is `key=value` lines. */
export function readIfo(text: string): Record<string, string> {
    return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
        const at = line.indexOf('=')
        return at < 0 ? [] : [[line.slice(0, at), line.slice(at + 1)]]
    }))
}

/** The pack's files by role, or an error a person can act on. Only a pack foliate can read gets through. */
export function packFromFiles(files: readonly AddedFile[]): Partial<Record<Role, Uint8Array>> {
    const pack: Partial<Record<Role, Uint8Array>> = {}
    for (const file of expandZips(files)) {
        const role = roleOf(file.name)
        if (role) pack[role] = file.bytes
    }
    if (!pack.ifo || !pack.idx || !pack.dict) throw new Error(WHAT_A_PACK_HOLDS)
    const { sametypesequence } = readIfo(strFromU8(pack.ifo))
    if (sametypesequence?.length !== 1) throw new Error('This pack mixes kinds of entry in one word, which EtherPK cannot read yet.')
    return pack
}

/** One chunk of a .dict.dz. A dictzip chunk ends on a flush, so it is closed with an empty final block to make it whole. */
export function inflateDictChunk(chunk: Uint8Array): Uint8Array {
    const closed = new Uint8Array(chunk.length + 5)
    closed.set(chunk)
    closed.set([1, 0, 0, 255, 255], chunk.length)
    return inflateSync(closed)
}

/** A definition in a kind of markup, as words alone. Injected, because taking markup apart needs a document. */
export type MarkupToText = (markup: string) => string

const MARKUP_KINDS = new Set(['h', 'g', 'x'])

export function entryText(kind: string, bytes: Uint8Array, markupToText: MarkupToText): string {
    const text = strFromU8(bytes)
    return MARKUP_KINDS.has(kind) ? markupToText(text) : text
}

interface OpenDictionary {
    name: string
    dict: import('foliate-js/dict.js').StarDict
}

/** The packs on this device: adding, listing, removing, and looking a word up in all of them. */
export function createEbookDictionaries(shelf: DictionaryShelf, markupToText: MarkupToText) {
    const open = new Map<string, OpenDictionary>()

    async function nameOf(id: string): Promise<string> {
        const ifo = await shelf.read(id, 'ifo')
        return ifo ? (readIfo(await ifo.text()).bookname ?? 'Dictionary') : 'Dictionary'
    }

    async function opened(id: string): Promise<OpenDictionary | null> {
        const held = open.get(id)
        if (held) return held
        const [ifo, idx, dict, syn] = await Promise.all(ROLES.map((role) => shelf.read(id, role)))
        if (!ifo || !idx || !dict) return null
        const { StarDict } = await import('foliate-js/dict.js')
        const reader = new StarDict()
        await reader.loadIfo(ifo)
        await reader.loadDict(dict, inflateDictChunk)
        await reader.loadIdx(idx)
        await reader.loadSyn(syn ?? undefined)
        const made = { name: readIfo(await ifo.text()).bookname ?? 'Dictionary', dict: reader }
        open.set(id, made)
        return made
    }

    return {
        async list(): Promise<HeldDictionary[]> {
            const ids = await shelf.list()
            return Promise.all(ids.map(async (id) => ({ id, name: await nameOf(id) })))
        },
        async add(files: readonly AddedFile[]): Promise<void> {
            const pack = packFromFiles(files)
            const id = crypto.randomUUID()
            for (const role of ROLES) {
                const bytes = pack[role]
                if (bytes) await shelf.write(id, role, bytes)
            }
        },
        async remove(id: string): Promise<void> {
            open.delete(id)
            await shelf.remove(id)
        },
        /** Every definition of a word, in every pack. A pack that cannot be read is left out. */
        async lookUp(word: string): Promise<Definition[]> {
            const query = word.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
            if (query === '') return []
            const results = await Promise.all(
                (await shelf.list()).map(async (id) => {
                    const dictionary = await opened(id).catch(() => null)
                    if (!dictionary) return []
                    const entries = await dictionary.dict.lookup(query).catch(() => [])
                    return entries.map((entry) => ({
                        dictionary: dictionary.name,
                        word: entry.word,
                        text: entry.data.map(([kind, bytes]) => entryText(kind, bytes, markupToText)).join('\n'),
                    }))
                }),
            )
            return results.flat()
        },
    }
}

export type EbookDictionaries = ReturnType<typeof createEbookDictionaries>

/** The shelf in this browser's private file system, or null where it has none. */
export function browserDictionaryShelf(): DictionaryShelf | null {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
    const root = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('ebook-dictionaries', { create: true })
    return {
        async list() {
            const ids: string[] = []
            for await (const [name] of (await root()) as unknown as AsyncIterable<[string, FileSystemHandle]>) ids.push(name)
            return ids
        },
        async write(id, role, bytes) {
            const folder = await (await root()).getDirectoryHandle(id, { create: true })
            const handle = await folder.getFileHandle(role, { create: true })
            await writeFileContents(handle, bytes as Uint8Array<ArrayBuffer>)
        },
        async read(id, role) {
            try {
                return await (await (await (await root()).getDirectoryHandle(id)).getFileHandle(role)).getFile()
            } catch {
                return null
            }
        },
        async remove(id) {
            await (await root()).removeEntry(id, { recursive: true })
        },
    }
}
