import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { browserAsksBeforePersisting, persistenceStep } from './storage-persistence'

/** A fixed seed keeps CI deterministic; `PERSIST_FUZZ_SEED` and `PERSIST_FUZZ_RUNS` hunt for more. */
function params(runs = 1000) {
    const seed = process.env.PERSIST_FUZZ_SEED
    return { numRuns: Number(process.env.PERSIST_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

const AGENTS = [
    'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
]

/** Every state a browser can be in: the API or not, persisted, a permission answer or none, a throw anywhere. */
const environment = fc.record({
    // Mostly real browsers, with arbitrary strings now and then for whatever else claims to be one.
    userAgent: fc.oneof({ arbitrary: fc.constantFrom(...AGENTS), weight: 4 }, { arbitrary: fc.string(), weight: 1 }),
    explained: fc.boolean(),
    storage: fc.option(
        fc.record({ persisted: fc.constantFrom<boolean | 'throws'>(true, false, 'throws') }),
        { nil: undefined },
    ),
    permission: fc.option(fc.constantFrom<PermissionState | 'throws'>('granted', 'denied', 'prompt', 'throws'), { nil: undefined }),
})

describe('persistenceStep, over every browser state', () => {
    it('explains only in Firefox, only once, and never after the person said no or already agreed', async () => {
        await fc.assert(
            fc.asyncProperty(environment, async (env) => {
                let persistCalls = 0
                const storage = env.storage && {
                    persisted: async () => {
                        if (env.storage!.persisted === 'throws') throw new Error('refused')
                        return env.storage!.persisted as boolean
                    },
                    persist: async () => {
                        persistCalls += 1
                        return true
                    },
                }
                const permissions = env.permission && {
                    query: async () => {
                        if (env.permission === 'throws') throw new TypeError('unknown name')
                        return { state: env.permission as PermissionState }
                    },
                }
                const step = await persistenceStep({ storage, permissions, userAgent: env.userAgent, explained: env.explained })

                // Deciding never asks the browser for anything: only the dialog's button or the caller does.
                expect(persistCalls).toBe(0)
                if (step === 'explain') {
                    expect(browserAsksBeforePersisting(env.userAgent)).toBe(true)
                    expect(env.explained).toBe(false)
                    expect(env.permission === 'denied' || env.permission === 'granted').toBe(false)
                }
                // Nothing to do where there is no API, or the browser has agreed or will not say.
                if (!env.storage || env.storage.persisted !== false) expect(step).toBe('none')
                // A person who blocked it in Firefox is never asked again, by EtherPK or by Firefox.
                if (env.permission === 'denied' && browserAsksBeforePersisting(env.userAgent)) expect(step).toBe('none')
                // A browser that decides on its own is asked quietly whenever it has not agreed.
                if (env.storage?.persisted === false && !browserAsksBeforePersisting(env.userAgent)) expect(step).toBe('request')
            }),
            params(),
        )
    })
})
