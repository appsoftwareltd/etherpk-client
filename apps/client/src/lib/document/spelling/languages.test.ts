import { describe, expect, it, vi } from 'vitest'

import {
    browserSpellingLanguages,
    createSpellingLanguagesStore,
    languageName,
    parseManifest,
    SPELLING_LANGUAGES_KEY_PREFIX,
} from './languages'

const AVAILABLE = ['de', 'de-AT', 'en', 'en-GB', 'es', 'fr', 'pt', 'pt-PT']

describe('browserSpellingLanguages', () => {
    it('takes an exact match first, in the browser’s order', () => {
        expect(browserSpellingLanguages(['en-GB', 'de-AT'], AVAILABLE)).toEqual(['en-GB', 'de-AT'])
    })

    it('falls back to the dictionary named by the language alone', () => {
        expect(browserSpellingLanguages(['de-DE', 'fr-CA', 'pt-BR'], AVAILABLE)).toEqual(['de', 'fr', 'pt'])
    })

    it('keeps one dictionary per language: the first the browser names', () => {
        // Chrome reports ["en-GB", "en"] for a British English user; plain "en" is US English.
        expect(browserSpellingLanguages(['en-GB', 'en', 'en-US'], AVAILABLE)).toEqual(['en-GB'])
    })

    it('matches case-insensitively and drops languages with no dictionary', () => {
        expect(browserSpellingLanguages(['EN-gb', 'ja', 'zz-ZZ'], AVAILABLE)).toEqual(['en-GB'])
    })

    it('offers nothing when no browser language has a dictionary', () => {
        expect(browserSpellingLanguages(['ja-JP'], AVAILABLE)).toEqual([])
    })
})

describe('parseManifest', () => {
    const entry = {
        tag: 'en-GB',
        aff: 'en-GB/index.aff',
        dic: 'en-GB/index.dic',
        license: 'en-GB/LICENSE',
        licence: '(MIT AND BSD)',
        bytes: 555192,
        sha256: { aff: 'a'.repeat(64), dic: 'b'.repeat(64) },
    }

    it('reads a version 1 manifest', () => {
        const manifest = parseManifest({ version: 1, source: 'https://example.com', dictionaries: [entry] })
        expect(manifest.dictionaries.map((d) => d.tag)).toEqual(['en-GB'])
    })

    it('refuses another version, and entries missing their files or hashes', () => {
        expect(() => parseManifest({ version: 2, source: '', dictionaries: [] })).toThrow(/version/)
        expect(() => parseManifest({ version: 1, source: '', dictionaries: [{ ...entry, dic: undefined }] })).toThrow(
            /en-GB/,
        )
        expect(() =>
            parseManifest({ version: 1, source: '', dictionaries: [{ ...entry, sha256: { aff: 'x' } }] }),
        ).toThrow(/en-GB/)
        expect(() => parseManifest('not json')).toThrow()
    })

    it('refuses a path that climbs out of the dictionary host', () => {
        expect(() =>
            parseManifest({ version: 1, source: '', dictionaries: [{ ...entry, dic: '../secrets/index.dic' }] }),
        ).toThrow(/en-GB/)
    })
})

describe('languageName', () => {
    it('names a language and its region in English', () => {
        expect(languageName('en-GB')).toBe('British English')
        expect(languageName('de')).toBe('German')
    })

    it('falls back to the tag itself when the runtime cannot name it', () => {
        expect(languageName('xx-Nope-1')).toBe('xx-Nope-1')
    })
})

/** A `Storage` stand-in: the suite runs in Node. */
function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
        get length() {
            return map.size
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, v),
    }
}

describe('Spelling Languages store', () => {
    it('has no list of its own for a graph until one is set: the graph follows the browser', () => {
        const store = createSpellingLanguagesStore(() => memoryStorage())
        expect(store.get('g1')).toBeNull()
    })

    it('keeps a list per graph, on this device', () => {
        const storage = memoryStorage()
        const store = createSpellingLanguagesStore(() => storage)
        store.set('g1', ['en-GB', 'de'])
        expect(store.get('g1')).toEqual(['en-GB', 'de'])
        expect(store.get('g2')).toBeNull()
        expect(storage.getItem(`${SPELLING_LANGUAGES_KEY_PREFIX}g1`)).toBe('["en-GB","de"]')
        // Another store over the same storage, as after a reload.
        expect(createSpellingLanguagesStore(() => storage).get('g1')).toEqual(['en-GB', 'de'])
    })

    it('goes back to following the browser on reset, and tells subscribers about each change', () => {
        const store = createSpellingLanguagesStore(() => memoryStorage())
        const listener = vi.fn()
        store.subscribe(listener)
        store.set('g1', ['fr'])
        expect(listener).toHaveBeenLastCalledWith('g1')
        store.reset('g1')
        expect(store.get('g1')).toBeNull()
        expect(listener).toHaveBeenCalledTimes(2)
    })

    it('treats an unreadable record as no list, and survives a storage that refuses', () => {
        const storage = memoryStorage()
        storage.setItem(`${SPELLING_LANGUAGES_KEY_PREFIX}g1`, '{broken')
        expect(createSpellingLanguagesStore(() => storage).get('g1')).toBeNull()

        const refusing = createSpellingLanguagesStore(() => {
            throw new Error('SecurityError')
        })
        refusing.set('g1', ['de'])
        expect(refusing.get('g1')).toEqual(['de'])
    })
})
