import { afterEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({ installed: false }))
vi.mock('#lib/native/bridge.js', () => ({ isNativeApp: () => shell.installed }))

import { browserAsksBeforePersisting, ensurePersistentStorage, persistenceStep } from './storage-persistence'

describe('ensurePersistentStorage', () => {
    it('reports an unsupported browser without touching anything', async () => {
        expect(await ensurePersistentStorage(undefined)).toEqual({
            supported: false,
            persisted: false,
            requested: false,
        })
    })

    it('does not re-request when the origin is already persistent', async () => {
        const persist = vi.fn()
        const outcome = await ensurePersistentStorage({ persisted: async () => true, persist })

        expect(outcome).toEqual({ supported: true, persisted: true, requested: false })
        expect(persist).not.toHaveBeenCalled()
    })

    it('requests persistence and reports the grant', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => true,
        })

        expect(outcome).toEqual({ supported: true, persisted: true, requested: true })
    })

    it('reports a refused request rather than assuming it succeeded', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => false,
        })

        expect(outcome).toEqual({ supported: true, persisted: false, requested: true })
    })

    it('treats a throwing StorageManager as not persisted, never as a startup failure', async () => {
        const outcome = await ensurePersistentStorage({
            persisted: async () => false,
            persist: async () => {
                throw new DOMException('denied', 'SecurityError')
            },
        })

        expect(outcome).toEqual({ supported: true, persisted: false, requested: true })
    })
})

describe('describeDeviceStorage', () => {
    it('reports an unsupported browser as unknown on every count', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        expect(await describeDeviceStorage(undefined)).toEqual({ supported: false, persisted: null, usage: null, quota: null })
    })

    it('reads persistence and the usage estimate', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        const report = await describeDeviceStorage({
            persisted: async () => true,
            estimate: async () => ({ usage: 1234, quota: 5678 }),
        })
        expect(report).toEqual({ supported: true, persisted: true, usage: 1234, quota: 5678 })
    })

    it('tolerates a StorageManager without estimate, or one that throws', async () => {
        const { describeDeviceStorage } = await import('./storage-persistence')
        expect(await describeDeviceStorage({ persisted: async () => false })).toEqual({
            supported: true,
            persisted: false,
            usage: null,
            quota: null,
        })
        expect(
            await describeDeviceStorage({
                persisted: async () => {
                    throw new DOMException('denied', 'SecurityError')
                },
                estimate: async () => {
                    throw new DOMException('denied', 'SecurityError')
                },
            }),
        ).toEqual({ supported: true, persisted: null, usage: null, quota: null })
    })
})

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
// Firefox on iOS is WebKit underneath and answers as Safari does: no prompt.
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15'

describe('browserAsksBeforePersisting', () => {
    it('is true for Firefox, which answers persist() with a permission prompt', () => {
        expect(browserAsksBeforePersisting(FIREFOX)).toBe(true)
        expect(browserAsksBeforePersisting(FIREFOX_ANDROID)).toBe(true)
    })

    it('is false for browsers that decide on their own heuristics, without asking', () => {
        expect(browserAsksBeforePersisting(CHROME)).toBe(false)
        expect(browserAsksBeforePersisting(SAFARI)).toBe(false)
        expect(browserAsksBeforePersisting(FIREFOX_IOS)).toBe(false)
    })
})

describe('persistenceStep', () => {
    const notYet = { persisted: async () => false, persist: async () => false }
    const permission = (state: PermissionState) => ({ query: async () => ({ state }) })

    it('does nothing where the browser has no persistence API, or has already agreed', async () => {
        expect(await persistenceStep({ storage: undefined, userAgent: FIREFOX, explained: false })).toBe('none')
        expect(await persistenceStep({ storage: { persisted: async () => true, persist: async () => true }, userAgent: FIREFOX, explained: false })).toBe('none')
    })

    it('asks quietly where the browser does not prompt', async () => {
        expect(await persistenceStep({ storage: notYet, userAgent: CHROME, explained: false })).toBe('request')
        expect(await persistenceStep({ storage: notYet, userAgent: SAFARI, explained: true })).toBe('request')
    })

    it('explains first in Firefox, so its prompt does not arrive out of nowhere', async () => {
        expect(await persistenceStep({ storage: notYet, permissions: permission('prompt'), userAgent: FIREFOX, explained: false })).toBe('explain')
        // A browser whose Permissions API does not know the name still gets the explanation.
        expect(await persistenceStep({ storage: notYet, userAgent: FIREFOX, explained: false })).toBe('explain')
    })

    it('explains once: after that only the Graphs page asks again', async () => {
        expect(await persistenceStep({ storage: notYet, permissions: permission('prompt'), userAgent: FIREFOX, explained: true })).toBe('none')
    })

    it('never asks again once the person has blocked it, and asks quietly once it is allowed', async () => {
        expect(await persistenceStep({ storage: notYet, permissions: permission('denied'), userAgent: FIREFOX, explained: false })).toBe('none')
        expect(await persistenceStep({ storage: notYet, permissions: permission('granted'), userAgent: FIREFOX, explained: false })).toBe('request')
    })

    it('treats a Permissions API that throws as not knowing, not as a refusal', async () => {
        const throwing = { query: async () => { throw new TypeError('not a permission name') } }
        expect(await persistenceStep({ storage: notYet, permissions: throwing, userAgent: FIREFOX, explained: false })).toBe('explain')
    })
})

describe('persistent storage in a Native App', () => {
    afterEach(() => {
        shell.installed = false
    })

    it('is never asked for: the app keeps its own data, and a WebView refuses every time', async () => {
        shell.installed = true
        const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => false) }
        expect(await ensurePersistentStorage(storage)).toEqual({ supported: false, persisted: false, requested: false })
        expect(await persistenceStep({ storage, userAgent: 'Firefox/140', explained: false })).toBe('none')
        expect(storage.persist).not.toHaveBeenCalled()
    })
})
