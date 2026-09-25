/**
 * The spell service: what the editor asks "is this word spelt right?" (ADR 0095).
 *
 * It holds the open graph's [[Spelling Languages]] on this device (its own list, or the
 * browser's languages while it has none), downloads their dictionaries through the dictionary
 * cache, loads them into the checker (the spelling worker), hands the checker the
 * [[Graph Dictionary]]'s words, and keeps a verdict per word so the editor can ask synchronously
 * while it draws. Nothing is judged until every Spelling Language is loaded: with German still
 * downloading, every German word would otherwise look misspelt.
 *
 * Any change that could change a verdict (a language added or removed, the Graph Dictionary
 * edited) clears the verdicts and tells subscribers, and the editor asks again for what it shows.
 * Work started for a graph that has since closed is dropped when it lands.
 */

import { DictionaryError, type DictionaryCache } from './dictionary-cache'
import { browserSpellingLanguages, languageName, type DictionaryEntry, type SpellingLanguagesStore } from './languages'
import type { SpellChecker } from './spelling-worker-client'

export type LanguageState = 'downloading' | 'ready' | 'offline' | 'failed'

export interface LanguageStatus {
    tag: string
    name: string
    state: LanguageState
    /** What the download costs, from the manifest. */
    bytes: number
    error?: string
}

/**
 * - `off`: no graph open.
 * - `unconfigured`: this deployment has no dictionary host.
 * - `no-languages`: none of the languages asked for has a dictionary.
 * - `loading`: a language is still downloading or loading.
 * - `ready`: every Spelling Language is loaded; verdicts flow.
 * - `error`: the manifest could not be read, or a language could not be loaded.
 */
export type SpellState = 'off' | 'unconfigured' | 'no-languages' | 'loading' | 'ready' | 'error'

export interface AvailableLanguage extends DictionaryEntry {
    name: string
}

export interface SpellServiceDeps {
    dictionaries: DictionaryCache
    /** Created on first need, so a graph that never checks never starts the worker. */
    checker: () => SpellChecker
    languagesStore: SpellingLanguagesStore
    /** `navigator.languages`, read when needed so a change to the browser's list carries through. */
    browserLanguages: () => readonly string[]
}

export interface SpellService {
    readonly state: SpellState
    /** Why the state is `error`, when it is not one language's fault. */
    readonly error: string | null
    open(graphId: string): void
    close(): void
    languages(): LanguageStatus[]
    available(): AvailableLanguage[]
    followsBrowser(): boolean
    addLanguage(tag: string): void
    removeLanguage(tag: string): void
    resetLanguages(): void
    /** Try again every language that failed, and the manifest if that failed. */
    retry(): void
    /** The Graph Dictionary's words. */
    setWords(words: Iterable<string>): void
    /** The verdict for a word, if known: true spelt right, false misspelt, undefined not asked yet. */
    verdict(word: string): boolean | undefined
    /** Ask about words; resolves once their verdicts are known (or dropped, if things moved on). */
    check(words: readonly string[]): Promise<void>
    suggest(word: string): Promise<string[]>
    /** Told about every change of state, language status or verdicts. Returns an unsubscribe. */
    subscribe(listener: () => void): () => void
}

export function createSpellService(deps: SpellServiceDeps): SpellService {
    let state: SpellState = 'off'
    let error: string | null = null
    let graphId: string | null = null
    /** Bumped by every open, close and language change; work tagged with an older one is dropped. */
    let session = 0
    let manifest: DictionaryEntry[] | null = null
    let statuses: LanguageStatus[] = []
    let checker: SpellChecker | null = null
    let loaded = new Set<string>()
    let words: string[] = []
    let verdicts = new Map<string, boolean>()
    /** Words sent to the checker and not answered yet, so several editors asking send each once. */
    let asking = new Set<string>()
    const listeners = new Set<() => void>()

    const emit = () => {
        for (const listener of listeners) listener()
    }
    /** The checker, started on first need and given the Graph Dictionary's words then. */
    function getChecker(): SpellChecker {
        if (!checker) {
            checker = deps.checker()
            if (words.length > 0) checker.setWords(words)
        }
        return checker
    }

    function wanted(): string[] {
        if (graphId === null || manifest === null) return []
        const own = deps.languagesStore.get(graphId)
        const available = manifest.map((e) => e.tag)
        if (own) return own.filter((tag) => available.includes(tag))
        return browserSpellingLanguages(deps.browserLanguages(), available)
    }

    /** The overall state from the languages' states. */
    function settle(): void {
        if (statuses.length === 0) state = 'no-languages'
        else if (statuses.every((s) => s.state === 'ready')) state = 'ready'
        else if (statuses.some((s) => s.state === 'downloading')) state = 'loading'
        else state = 'error'
    }

    function setStatus(tag: string, patch: Partial<LanguageStatus>): void {
        statuses = statuses.map((s) => (s.tag === tag ? { ...s, ...patch } : s))
        settle()
        emit()
    }

    async function loadLanguage(entry: DictionaryEntry, token: number): Promise<void> {
        try {
            const files = await deps.dictionaries.files(entry)
            if (token !== session) return
            await getChecker().load(entry.tag, files.aff, files.dic)
            if (token !== session) {
                // Removed (or the graph closed) while it loaded: the worker must not keep accepting
                // its words. Still wanted, a later load for the newer session adopts it.
                if (!wanted().includes(entry.tag) || graphId === null) checker?.unload(entry.tag)
                return
            }
            loaded.add(entry.tag)
            setStatus(entry.tag, { state: 'ready', error: undefined })
        } catch (err) {
            if (token !== session) return
            const offline = err instanceof DictionaryError && err.kind === 'offline'
            setStatus(entry.tag, { state: offline ? 'offline' : 'failed', error: (err as Error).message })
        }
    }

    /** Bring the loaded languages in line with what the graph wants. */
    function reconcile(): void {
        const token = ++session
        verdicts = new Map()
        asking = new Set()
        const tags = wanted()
        const checkerInstance = checker
        for (const tag of loaded) {
            if (!tags.includes(tag)) {
                checkerInstance?.unload(tag)
                loaded.delete(tag)
            }
        }
        const entries = tags.map((tag) => manifest!.find((e) => e.tag === tag)!)
        statuses = entries.map((e) => ({
            tag: e.tag,
            name: languageName(e.tag),
            bytes: e.bytes,
            state: loaded.has(e.tag) ? 'ready' : 'downloading',
        }))
        settle()
        emit()
        for (const entry of entries) if (!loaded.has(entry.tag)) void loadLanguage(entry, token)
    }

    async function begin(token: number): Promise<void> {
        try {
            const fetched = await deps.dictionaries.manifest()
            if (token !== session) return
            manifest = fetched.dictionaries
            error = null
            reconcile()
        } catch (err) {
            if (token !== session) return
            state = 'error'
            error = (err as Error).message
            emit()
        }
    }

    return {
        get state() {
            return state
        },
        get error() {
            return error
        },

        open(id) {
            graphId = id
            const token = ++session
            verdicts = new Map()
        asking = new Set()
            statuses = []
            error = null
            if (!deps.dictionaries.configured) {
                state = 'unconfigured'
                emit()
                return
            }
            state = 'loading'
            emit()
            if (manifest) reconcile()
            else void begin(token)
        },

        close() {
            graphId = null
            session++
            for (const tag of loaded) checker?.unload(tag)
            loaded = new Set()
            statuses = []
            verdicts = new Map()
        asking = new Set()
            state = 'off'
            emit()
        },

        languages: () => statuses.map((s) => ({ ...s })),

        available: () =>
            (manifest ?? [])
                .map((e) => ({ ...e, name: languageName(e.tag) }))
                .sort((a, b) => a.name.localeCompare(b.name, 'en')),

        followsBrowser: () => graphId === null || deps.languagesStore.get(graphId) === null,

        addLanguage(tag) {
            if (graphId === null) return
            const current = wanted()
            if (current.includes(tag)) return
            deps.languagesStore.set(graphId, [...current, tag])
            reconcile()
        },

        removeLanguage(tag) {
            if (graphId === null) return
            deps.languagesStore.set(
                graphId,
                wanted().filter((t) => t !== tag),
            )
            reconcile()
        },

        resetLanguages() {
            if (graphId === null) return
            deps.languagesStore.reset(graphId)
            reconcile()
        },

        retry() {
            if (graphId === null || !deps.dictionaries.configured) return
            if (!manifest) {
                const token = ++session
                state = 'loading'
                emit()
                void begin(token)
                return
            }
            const token = session
            for (const status of statuses) {
                if (status.state !== 'offline' && status.state !== 'failed') continue
                setStatus(status.tag, { state: 'downloading', error: undefined })
                void loadLanguage(manifest.find((e) => e.tag === status.tag)!, token)
            }
        },

        setWords(next) {
            words = [...next]
            checker?.setWords(words)
            verdicts = new Map()
        asking = new Set()
            emit()
        },

        verdict: (word) => (state === 'ready' ? verdicts.get(word) : undefined),

        async check(asked) {
            if (state !== 'ready') return
            const unknown = [...new Set(asked)].filter((w) => !verdicts.has(w) && !asking.has(w))
            if (unknown.length === 0) return
            const pending = asking
            for (const word of unknown) pending.add(word)
            const token = session
            const before = verdicts
            let results: boolean[]
            try {
                results = await getChecker().check(unknown)
            } catch {
                // A worker that failed leaves these words unjudged rather than rejecting into an
                // editor that asked with `void`: nothing is underlined that was not checked, and
                // the next redraw may ask again.
                for (const word of unknown) pending.delete(word)
                return
            }
            // Dropped if a language or the dictionary changed meanwhile: the answers are stale.
            if (token !== session || verdicts !== before) return
            unknown.forEach((word, i) => {
                verdicts.set(word, results[i])
                asking.delete(word)
            })
            emit()
        },

        async suggest(word) {
            if (state !== 'ready') return []
            try {
                return await getChecker().suggest(word, 5)
            } catch {
                return [] // the menu still offers Add to dictionary and Spelling languages
            }
        },

        subscribe(listener) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
}
