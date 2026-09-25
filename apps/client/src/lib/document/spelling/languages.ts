/**
 * The dictionaries EtherPK can check against, and the [[Spelling Languages]] a graph uses on
 * this device.
 *
 * The dictionary host publishes a manifest (`manifest.json` beside the files; see Spelling
 * Dictionaries.md), and every language the Client offers is an entry in it. A graph's Spelling
 * Languages are per graph and per device: until the user edits them they follow the browser's
 * preferred languages, so nothing is stored on first open and a change to the browser's
 * languages carries through; once edited they are that graph's own on this device.
 */

export interface DictionaryEntry {
    /** The dictionary's language tag, as the host names its folder (`en-GB`, `de`, `sr-Latn`). */
    tag: string
    /** Paths of the affix and word files, relative to the manifest. */
    aff: string
    dic: string
    /** Path of the dictionary's own licence file. */
    license: string
    /** Its SPDX licence expression. */
    licence: string
    /** Size of the affix and word files together, what a download costs. */
    bytes: number
    /** Hex SHA-256 of each file, checked before a download is trusted or cached. */
    sha256: { aff: string; dic: string }
}

export interface DictionaryManifest {
    version: 1
    source: string
    dictionaries: DictionaryEntry[]
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** A path inside the dictionary host: relative, no parent steps, no scheme. */
function isHostPath(path: unknown): path is string {
    return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('..') && !path.includes(':')
}

/** Read the host's manifest, refusing anything the Client would not know how to use safely. */
export function parseManifest(json: unknown): DictionaryManifest {
    if (typeof json !== 'object' || json === null) throw new Error('The dictionary manifest is not an object.')
    const { version, source, dictionaries } = json as Partial<DictionaryManifest>
    if (version !== 1) throw new Error(`Unsupported dictionary manifest version: ${String(version)}.`)
    if (!Array.isArray(dictionaries)) throw new Error('The dictionary manifest lists no dictionaries.')
    for (const entry of dictionaries as Partial<DictionaryEntry>[]) {
        const tag = typeof entry?.tag === 'string' ? entry.tag : '(no tag)'
        const valid =
            typeof entry?.tag === 'string' &&
            isHostPath(entry.aff) &&
            isHostPath(entry.dic) &&
            isHostPath(entry.license) &&
            typeof entry.bytes === 'number' &&
            SHA256_HEX.test(entry.sha256?.aff ?? '') &&
            SHA256_HEX.test(entry.sha256?.dic ?? '')
        if (!valid) throw new Error(`The dictionary manifest entry ${tag} is incomplete or unsafe.`)
    }
    return { version: 1, source: typeof source === 'string' ? source : '', dictionaries: dictionaries as DictionaryEntry[] }
}

const primary = (tag: string) => tag.split('-')[0].toLowerCase()

/**
 * The Spelling Languages a graph starts with: the browser's preferred languages that have a
 * dictionary, one per language, in the browser's order. An exact tag wins (`en-GB`); failing
 * that, the dictionary named by the language alone (`de-DE` gives `de`). A later entry for a
 * language already chosen is dropped: Chrome reports `["en-GB", "en"]` for a British English
 * user, and the bare `en` dictionary is US English.
 */
export function browserSpellingLanguages(browserLanguages: readonly string[], available: readonly string[]): string[] {
    const byLower = new Map(available.map((tag) => [tag.toLowerCase(), tag]))
    const chosen: string[] = []
    const covered = new Set<string>()
    for (const language of browserLanguages) {
        const lang = primary(language)
        if (covered.has(lang)) continue
        const match = byLower.get(language.toLowerCase()) ?? byLower.get(lang)
        if (!match) continue
        chosen.push(match)
        covered.add(lang)
    }
    return chosen
}

/**
 * Names the runtime gets wrong for these dictionaries: the host's bare `en` and `pt` are the US
 * and Brazilian dictionaries, where `Intl.DisplayNames` says only "English" and "Portuguese".
 */
const NAME_OVERRIDES: Record<string, string> = { en: 'American English', pt: 'Brazilian Portuguese' }

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })

/** A language's name in English, as the Spelling tab lists it. The tag itself when unnamed. */
export function languageName(tag: string): string {
    if (NAME_OVERRIDES[tag]) return NAME_OVERRIDES[tag]
    try {
        return displayNames.of(tag) ?? tag
    } catch {
        return tag
    }
}

export const SPELLING_LANGUAGES_KEY_PREFIX = 'etherpk:spelling-languages:'

export interface SpellingLanguagesStore {
    /** The graph's own list on this device, or null while it follows the browser. */
    get(graphId: string): string[] | null
    set(graphId: string, tags: readonly string[]): void
    /** Back to following the browser's languages. */
    reset(graphId: string): void
    /** Called with the graph id whose list changed. Returns an unsubscribe. */
    subscribe(listener: (graphId: string) => void): () => void
}

/**
 * The per-device store of each graph's own Spelling Languages. `localStorage`, like the
 * [[Layout]]: device state, never synced. Every access tolerates a storage that throws; the
 * in-memory copy then serves the session.
 */
export function createSpellingLanguagesStore(storage: () => Storage | null): SpellingLanguagesStore {
    const memory = new Map<string, string[] | null>()
    const listeners = new Set<(graphId: string) => void>()
    const key = (graphId: string) => `${SPELLING_LANGUAGES_KEY_PREFIX}${graphId}`

    function read(graphId: string): string[] | null {
        try {
            const raw = storage()?.getItem(key(graphId))
            if (raw == null) return null
            const parsed: unknown = JSON.parse(raw)
            return Array.isArray(parsed) && parsed.every((t) => typeof t === 'string') ? parsed : null
        } catch {
            return null
        }
    }

    function write(graphId: string, tags: string[] | null): void {
        memory.set(graphId, tags)
        try {
            if (tags === null) storage()?.removeItem(key(graphId))
            else storage()?.setItem(key(graphId), JSON.stringify(tags))
        } catch {
            // Refused: the in-memory copy serves the rest of the session.
        }
        for (const listener of listeners) listener(graphId)
    }

    return {
        get(graphId) {
            if (!memory.has(graphId)) memory.set(graphId, read(graphId))
            const tags = memory.get(graphId)
            return tags ? [...tags] : null
        },
        set: (graphId, tags) => write(graphId, [...tags]),
        reset: (graphId) => write(graphId, null),
        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}
