/**
 * The spell service as the browser runs it (ADR 0095): dictionaries from the deployment's
 * dictionary host kept in Cache Storage, Hunspell in the spelling worker, [[Spelling Languages]]
 * in `localStorage`, the browser's languages from `navigator.languages`.
 *
 * The host is `PUBLIC_DICTIONARY_URL`. Unset, it is EtherPK's own host
 * (`https://dictionaries.etherpk.com/v1`), in a self-hosted deployment too; in development it is
 * the Client's own origin, where `dev-dictionaries-plugin.ts` serves the locally built set. Set
 * to an empty string, the deployment has no dictionaries and spell checking says so.
 */

import { env } from '$env/dynamic/public'
import { dev } from '$app/environment'

import { createDictionaryCache } from './dictionary-cache'
import { createSpellingLanguagesStore } from './languages'
import { createSpellService, type SpellService } from './spell-service'
import { workerChecker } from './spelling-worker-client'

export const DEFAULT_DICTIONARY_URL = 'https://dictionaries.etherpk.com/v1'
const DEV_DICTIONARY_URL = '/dev-dictionaries/v1'

/** The dictionary host for this deployment; empty when it has none. */
export function dictionaryBaseUrl(configured: string | undefined = env.PUBLIC_DICTIONARY_URL, isDev = dev): string {
    if (configured !== undefined) return configured.trim()
    return isDev ? DEV_DICTIONARY_URL : DEFAULT_DICTIONARY_URL
}

/** Where downloaded dictionaries are kept. The version is in the URLs, so one cache serves all. */
const CACHE_NAME = 'etherpk-dictionaries'

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createBrowserSpellService(): SpellService {
    return createSpellService({
        dictionaries: createDictionaryCache({
            baseUrl: dictionaryBaseUrl(),
            fetch: (input, init) => fetch(input, init),
            cache: async () => (typeof caches === 'undefined' ? null : caches.open(CACHE_NAME)),
            sha256: sha256Hex,
        }),
        checker: workerChecker,
        languagesStore: createSpellingLanguagesStore(() => (typeof localStorage === 'undefined' ? null : localStorage)),
        browserLanguages: () => (navigator.languages?.length ? navigator.languages : [navigator.language]),
    })
}

let browserService: SpellService | null = null

/** The one spell service of this tab: it outlives a graph switch, so the worker and cache do too. */
export function getBrowserSpellService(): SpellService {
    return (browserService ??= createBrowserSpellService())
}
