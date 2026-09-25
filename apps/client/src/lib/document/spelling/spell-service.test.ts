import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Hunspell, getWasmModule } from 'hunspell-wasm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { DictionaryError, type DictionaryCache, type DictionaryFiles } from './dictionary-cache'
import { SpellEngine } from './engine'
import { createSpellingLanguagesStore, type DictionaryEntry } from './languages'
import { createSpellService, type SpellServiceDeps } from './spell-service'
import { inProcessChecker } from './spelling-worker-client'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const EN: DictionaryFiles = { aff: fixture('test.aff'), dic: fixture('test.dic') }
const DE: DictionaryFiles = { aff: 'SET UTF-8\n', dic: '2\nBuch\nNotiz\n' }

function entry(tag: string): DictionaryEntry {
    return {
        tag,
        aff: `${tag}/index.aff`,
        dic: `${tag}/index.dic`,
        license: `${tag}/LICENSE`,
        licence: 'MIT',
        bytes: 1000,
        sha256: { aff: '0'.repeat(64), dic: '0'.repeat(64) },
    }
}

let module: unknown
beforeAll(async () => {
    module = await getWasmModule()
})

/** A dictionary host with en-GB and de, whose downloads the test can hold back or fail. */
function host(options: { fail?: Record<string, DictionaryError>; gate?: Promise<void> } = {}) {
    const files = vi.fn(async (e: DictionaryEntry): Promise<DictionaryFiles> => {
        await options.gate
        const failure = options.fail?.[e.tag]
        if (failure) throw failure
        return e.tag === 'de' ? DE : EN
    })
    const cache: DictionaryCache = {
        configured: true,
        manifest: async () => ({ version: 1, source: 'test', dictionaries: [entry('de'), entry('en-GB')] }),
        files,
        isCached: async () => false,
    }
    return { cache, files }
}

function service(overrides: Partial<SpellServiceDeps> = {}) {
    const engine = new SpellEngine(async (aff, dic) => new Hunspell(module, aff, dic))
    return createSpellService({
        dictionaries: host().cache,
        checker: () => inProcessChecker(engine),
        languagesStore: createSpellingLanguagesStore(() => null),
        browserLanguages: () => ['en-GB', 'en'],
        ...overrides,
    })
}

/** Resolve once the service reaches `state`. */
function until(s: ReturnType<typeof service>, state: string): Promise<void> {
    return new Promise((resolve) => {
        const off = s.subscribe(() => {
            if (s.state === state) {
                off()
                resolve()
            }
        })
        if (s.state === state) {
            off()
            resolve()
        }
    })
}

describe('spell service', () => {
    it('has nothing to say until a graph is open', () => {
        const s = service()
        expect(s.state).toBe('off')
        expect(s.verdict('wrod')).toBeUndefined()
    })

    it('opens a graph in the browser’s languages and judges words once they are loaded', async () => {
        const s = service()
        s.open('g1')
        await until(s, 'ready')
        expect(s.followsBrowser()).toBe(true)
        expect(s.languages().map((l) => [l.tag, l.state])).toEqual([['en-GB', 'ready']])
        expect(s.verdict('word')).toBeUndefined()
        await s.check(['word', 'wrod'])
        expect(s.verdict('word')).toBe(true)
        expect(s.verdict('wrod')).toBe(false)
        expect(await s.suggest('wrod')).toContain('word')
    })

    it('uses the graph’s own list once it is set, and judges nothing until every language is in', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        const store = createSpellingLanguagesStore(() => null)
        store.set('g1', ['en-GB', 'de'])
        const s = service({ dictionaries: host({ gate }).cache, languagesStore: store })
        s.open('g1')
        await until(s, 'loading')
        await s.check(['wrod'])
        expect(s.verdict('wrod')).toBeUndefined()
        release()
        await until(s, 'ready')
        await s.check(['Notiz', 'word', 'wrod'])
        expect([s.verdict('Notiz'), s.verdict('word'), s.verdict('wrod')]).toEqual([true, true, false])
    })

    it('reports a language it could not download, and recovers on retry', async () => {
        const fail: Record<string, DictionaryError> = { 'en-GB': new DictionaryError('offline', 'no network') }
        const { cache, files } = host({ fail })
        const s = service({ dictionaries: cache })
        s.open('g1')
        await until(s, 'error')
        expect(s.languages()[0]).toMatchObject({ tag: 'en-GB', state: 'offline' })
        delete fail['en-GB']
        s.retry()
        await until(s, 'ready')
        expect(files).toHaveBeenCalledTimes(2)
    })

    it('says so when the deployment has no dictionary host, or no language matches', async () => {
        const unconfigured = service({ dictionaries: { ...host().cache, configured: false } })
        unconfigured.open('g1')
        expect(unconfigured.state).toBe('unconfigured')

        const nothing = service({ browserLanguages: () => ['ja'] })
        nothing.open('g1')
        await until(nothing, 'no-languages')
    })

    it('changes languages in place: the verdicts start over', async () => {
        const s = service()
        s.open('g1')
        await until(s, 'ready')
        await s.check(['Notiz'])
        expect(s.verdict('Notiz')).toBe(false)
        s.addLanguage('de')
        expect(s.followsBrowser()).toBe(false)
        await until(s, 'ready')
        expect(s.verdict('Notiz')).toBeUndefined()
        await s.check(['Notiz'])
        expect(s.verdict('Notiz')).toBe(true)
        s.resetLanguages()
        await until(s, 'ready')
        expect(s.languages().map((l) => l.tag)).toEqual(['en-GB'])
    })

    it('accepts the Graph Dictionary’s words, and forgets old verdicts when it changes', async () => {
        const s = service()
        s.open('g1')
        await until(s, 'ready')
        await s.check(['Sidney'])
        expect(s.verdict('Sidney')).toBe(false)
        s.setWords(['sidney'])
        expect(s.verdict('Sidney')).toBeUndefined()
        await s.check(['Sidney'])
        expect(s.verdict('Sidney')).toBe(true)
    })

    it('drops the answers for a graph that was closed while they were on their way', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        const s = service({ dictionaries: host({ gate }).cache })
        s.open('g1')
        await until(s, 'loading')
        s.close()
        release()
        await new Promise((r) => setTimeout(r, 20))
        expect(s.state).toBe('off')
    })

    it('sends a word being checked once, however many editors ask for it meanwhile', async () => {
        const engine = new SpellEngine(async (aff, dic) => new Hunspell(module, aff, dic))
        const checker = inProcessChecker(engine)
        const check = vi.spyOn(checker, 'check')
        const s = service({ checker: () => checker })
        s.open('g1')
        await until(s, 'ready')
        await Promise.all([s.check(['wrod', 'word']), s.check(['wrod']), s.check(['word', 'wrod'])])
        expect(check).toHaveBeenCalledTimes(1)
        expect(s.verdict('wrod')).toBe(false)
    })

    it('unloads a language that finishes loading after it was removed', async () => {
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        const engine = new SpellEngine(async (aff, dic) => new Hunspell(module, aff, dic))
        const store = createSpellingLanguagesStore(() => null)
        store.set('g1', ['en-GB', 'de'])
        const s = service({ dictionaries: host({ gate }).cache, languagesStore: store, checker: () => inProcessChecker(engine) })
        s.open('g1')
        await until(s, 'loading')
        s.removeLanguage('de')
        release()
        await until(s, 'ready')
        await new Promise((r) => setTimeout(r, 20))
        expect(engine.loaded()).toEqual(['en-GB'])
    })

    it('lists every language the host offers, by name', async () => {
        const s = service()
        s.open('g1')
        await until(s, 'ready')
        expect(s.available().map((d) => d.name)).toEqual(['British English', 'German'])
    })
})
