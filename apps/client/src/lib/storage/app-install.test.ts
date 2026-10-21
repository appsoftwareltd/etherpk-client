import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    type AppInstallHost,
    type AppInstallState,
    type InstallPromptEvent,
    appInstallState,
    promptInstall,
    resetAppInstallForTests,
    subscribeAppInstall,
    watchAppInstall,
} from './app-install'

vi.mock('./storage-persistence', () => ({ ensurePersistentStorage: vi.fn(async () => ({})) }))

type Listener = (event: Event) => void

function fakeHost(opts: { standalone?: boolean } = {}) {
    const handlers = new Map<string, Set<Listener>>()
    const host: AppInstallHost = {
        addEventListener: (type, listener) => {
            handlers.set(type, (handlers.get(type) ?? new Set()).add(listener))
        },
        removeEventListener: (type, listener) => {
            handlers.get(type)?.delete(listener)
        },
        matchMedia: (query) => ({ matches: opts.standalone === true && query === '(display-mode: standalone)' }),
    }
    const fire = (type: string, event: Event) => {
        for (const listener of handlers.get(type) ?? []) listener(event)
    }
    return { host, fire, handlers }
}

function offer(outcome: 'accepted' | 'dismissed' = 'accepted'): InstallPromptEvent & { prompt: ReturnType<typeof vi.fn> } {
    const event = new Event('beforeinstallprompt') as InstallPromptEvent & { prompt: ReturnType<typeof vi.fn> }
    event.prompt = vi.fn(async () => undefined)
    event.userChoice = Promise.resolve({ outcome })
    return event
}

describe('watchAppInstall', () => {
    beforeEach(resetAppInstallForTests)
    afterEach(resetAppInstallForTests)

    it('does nothing outside a browser', () => {
        const stop = watchAppInstall(undefined)
        expect(appInstallState()).toEqual({ installed: false, promptAvailable: false, installedOnDevice: false })
        stop()
    })

    it('reports an installed app from standalone display mode', () => {
        const { host } = fakeHost({ standalone: true })
        watchAppInstall(host)
        expect(appInstallState()).toEqual({ installed: true, promptAvailable: false, installedOnDevice: false })
    })

    it('captures the browser offer and suppresses the mini-infobar', () => {
        const { host, fire } = fakeHost()
        watchAppInstall(host)
        const seen: AppInstallState[] = []
        subscribeAppInstall((s) => seen.push(s))

        const event = offer()
        const prevent = vi.spyOn(event, 'preventDefault')
        fire('beforeinstallprompt', event)

        expect(prevent).toHaveBeenCalled()
        expect(seen.at(-1)).toEqual({ installed: false, promptAvailable: true, installedOnDevice: false })
    })

    it('shows the offer once and reports the choice', async () => {
        const { host, fire } = fakeHost()
        watchAppInstall(host)
        const event = offer('accepted')
        fire('beforeinstallprompt', event)

        expect(await promptInstall()).toBe('accepted')
        expect(event.prompt).toHaveBeenCalledTimes(1)
        // Single-use: the button is gone whatever was chosen.
        expect(appInstallState().promptAvailable).toBe(false)
        expect(await promptInstall()).toBe('unavailable')
    })

    it('a dismissed offer is reported and not reusable', async () => {
        const { host, fire } = fakeHost()
        watchAppInstall(host)
        fire('beforeinstallprompt', offer('dismissed'))

        expect(await promptInstall()).toBe('dismissed')
        expect(appInstallState()).toEqual({ installed: false, promptAvailable: false, installedOnDevice: false })
    })

    it('flips to installed on appinstalled and re-requests persistent storage', async () => {
        const { ensurePersistentStorage } = await import('./storage-persistence')
        const { host, fire } = fakeHost()
        watchAppInstall(host)
        fire('beforeinstallprompt', offer())

        fire('appinstalled', new Event('appinstalled'))

        expect(appInstallState()).toEqual({ installed: true, promptAvailable: false, installedOnDevice: false })
        expect(ensurePersistentStorage).toHaveBeenCalled()
        expect(await promptInstall()).toBe('unavailable')
    })

    it('stop removes both listeners', () => {
        const { host, handlers } = fakeHost()
        const stop = watchAppInstall(host)
        stop()
        expect(handlers.get('beforeinstallprompt')?.size ?? 0).toBe(0)
        expect(handlers.get('appinstalled')?.size ?? 0).toBe(0)
    })

    it('adopts an offer the page caught before the app started', async () => {
        const { host } = fakeHost()
        const early = offer('accepted')
        watchAppInstall({ ...host, heldOffer: () => early })

        expect(appInstallState().promptAvailable).toBe(true)
        expect(await promptInstall()).toBe('accepted')
        expect(early.prompt).toHaveBeenCalledTimes(1)
    })

    it('follows the display mode as it changes, rather than reading it once', () => {
        const { host } = fakeHost()
        let matches = false
        const changeListeners: Array<() => void> = []
        watchAppInstall({
            ...host,
            matchMedia: () => ({
                get matches() {
                    return matches
                },
                addEventListener: (_type: 'change', listener: () => void) => void changeListeners.push(listener),
                removeEventListener: () => {},
            }),
        })
        expect(appInstallState().installed).toBe(false)

        matches = true
        for (const listener of changeListeners) listener()
        expect(appInstallState().installed).toBe(true)
    })

    it('learns that the app is installed on this device while running in a tab', async () => {
        const { host } = fakeHost()
        watchAppInstall({ ...host, getInstalledRelatedApps: async () => [{ platform: 'webapp' }] })
        await vi.waitFor(() => expect(appInstallState().installedOnDevice).toBe(true))
    })

    it('reports each outcome, and never throws if reporting fails', async () => {
        const reported: string[] = []
        const { host, fire } = fakeHost()
        watchAppInstall({ ...host, report: (outcome) => void reported.push(outcome) })
        fire('beforeinstallprompt', offer('dismissed'))
        await promptInstall()
        fire('appinstalled', new Event('appinstalled'))

        expect(reported).toEqual(['dismissed', 'installed'])
    })
})
