/**
 * The terms Sync+ is offered on, read from the account site of a managed deployment so the Graphs
 * page can state them. This Client holds no price or trial length of its own.
 *
 * The read is server to server, to the origin the deployment configures as its account site, and
 * nothing from a visitor's request goes into it. It must never hold a page up for long or fail
 * one: the answer is kept for a few minutes, a stale one is served while a new one is fetched,
 * and a slow, failed or malformed answer reads as "not known", which the page has words for.
 */
import { buildSyncPlusOfferUrl, parseSyncPlusOfferTerms, type SyncPlusOfferTerms } from '@appsoftwareltd/etherpk-shared'

/** How long a first read may hold a page: after this the page is drawn without the terms. */
const TIMEOUT_MS = 1_500
/** How long an answer is served before it is fetched again. */
const FRESH_MS = 5 * 60_000
/** How long "not known" stands before the account site is asked again. */
const RETRY_MS = 60_000
/** An answer larger than this is not the terms. */
const MAX_BYTES = 4_096

export type SyncPlusOfferReader = (accountSiteOrigin: string) => Promise<SyncPlusOfferTerms | null>

export function createSyncPlusOfferReader(deps: {
    fetch: typeof fetch
    now?: () => number
    timeoutMs?: number
}): SyncPlusOfferReader {
    const now = deps.now ?? Date.now
    const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS
    let kept: { origin: string; terms: SyncPlusOfferTerms | null; until: number } | null = null
    let asking: Promise<SyncPlusOfferTerms | null> | null = null

    async function ask(origin: string): Promise<SyncPlusOfferTerms | null> {
        let terms: SyncPlusOfferTerms | null = null
        try {
            const response = await deps.fetch(buildSyncPlusOfferUrl(origin), {
                headers: { accept: 'application/json' },
                // A public address: no credentials go, and it is not followed anywhere else.
                credentials: 'omit',
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (response.ok) {
                const text = await response.text()
                if (text.length <= MAX_BYTES) terms = parseSyncPlusOfferTerms(JSON.parse(text))
            }
        } catch {
            // Unreachable, slow or not JSON: not known.
        }
        kept = { origin, terms, until: now() + (terms ? FRESH_MS : RETRY_MS) }
        return terms
    }

    return (origin) => {
        const held = kept?.origin === origin ? kept : null
        if (held && now() < held.until) return Promise.resolve(held.terms)
        // Requests that arrive while the account site answers share the one call.
        asking ??= ask(origin).finally(() => {
            asking = null
        })
        // A stale answer is served at once while the new one is fetched behind it.
        return held ? Promise.resolve(held.terms) : asking
    }
}

/** The process's one reader, so every request shares what the account site last said. */
export const readSyncPlusOffer = createSyncPlusOfferReader({ fetch: (...args) => fetch(...args) })
