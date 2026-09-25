/**
 * Whether EtherPK can be installed on this device, and the one way to offer it.
 *
 * Installing is the lever that actually earns eviction protection on a phone: Chromium grants
 * `navigator.storage.persist()` (see `storage-persistence.ts`) on engagement heuristics, and an
 * installed app is the reliable one. So the Graph Settings dialog carries an *Install* section,
 * and this module is what it reads.
 *
 * Chromium fires `beforeinstallprompt` once, early, whenever the install criteria are met and
 * the app is not yet installed. The event is the only handle on the browser's own install
 * dialog: it must be captured when it fires (which is before any dialog is open) and can be
 * used exactly once. That is why capture happens at app start and the event lives here, at
 * module level, rather than in the dialog that shows the button. Safari and Firefox never fire
 * it; there the section can only point at the browser's menu.
 */

import { ensurePersistentStorage } from './storage-persistence'

export interface AppInstallState {
    /** Running as an installed app (standalone display mode) on this device. */
    installed: boolean
    /** The browser has offered its install dialog and `promptInstall()` can show it. */
    promptAvailable: boolean
}

/** The subset of Chromium's `BeforeInstallPromptEvent` this module uses. */
export interface InstallPromptEvent extends Event {
    prompt(): Promise<unknown>
    userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** What `watchAppInstall` needs from `window` and `navigator`; narrowed so the unit tier can fake it. */
export interface AppInstallHost {
    addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
    removeEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
    matchMedia?(query: string): { matches: boolean }
    navigator?: { standalone?: boolean }
}

let state: AppInstallState = { installed: false, promptAvailable: false }
let pending: InstallPromptEvent | null = null
const listeners = new Set<(state: AppInstallState) => void>()

function emit(): void {
    for (const listener of listeners) listener(state)
}

function set(next: Partial<AppInstallState>): void {
    state = { ...state, ...next }
    emit()
}

function isInstalled(host: AppInstallHost): boolean {
    return host.matchMedia?.('(display-mode: standalone)').matches === true || host.navigator?.standalone === true
}

/**
 * Start listening for the browser's install offer. Call once at app start. Returns a stop
 * function; the captured offer, if any, is kept so a later dialog can use it.
 */
export function watchAppInstall(host: AppInstallHost | undefined = browserHost()): () => void {
    if (!host) return () => {}
    set({ installed: isInstalled(host) })
    const onPrompt = (event: Event) => {
        // Chromium shows its own mini-infobar unless the event is default-prevented; the
        // Settings section is where the offer belongs, so the infobar is suppressed.
        event.preventDefault()
        pending = event as InstallPromptEvent
        set({ promptAvailable: true })
    }
    const onInstalled = () => {
        pending = null
        set({ installed: true, promptAvailable: false })
        // An installed app is what Chromium's persistence heuristic rewards; a request made
        // before the install may have been refused, so ask again now that it would be granted.
        void ensurePersistentStorage()
    }
    host.addEventListener('beforeinstallprompt', onPrompt)
    host.addEventListener('appinstalled', onInstalled)
    return () => {
        host.removeEventListener('beforeinstallprompt', onPrompt)
        host.removeEventListener('appinstalled', onInstalled)
    }
}

/** Subscribe; fires at once with the current state. Returns an unsubscribe. */
export function subscribeAppInstall(listener: (state: AppInstallState) => void): () => void {
    listeners.add(listener)
    listener(state)
    return () => {
        listeners.delete(listener)
    }
}

export function appInstallState(): AppInstallState {
    return state
}

/**
 * Show the browser's install dialog. The captured offer is single-use: whatever the person
 * chooses, the browser will not offer again until the next load, so the button goes away
 * either way and `installed` follows the `appinstalled` event rather than the choice.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const offer = pending
    if (!offer) return 'unavailable'
    pending = null
    set({ promptAvailable: false })
    try {
        await offer.prompt()
        const choice = await offer.userChoice
        return choice?.outcome ?? 'dismissed'
    } catch {
        return 'dismissed'
    }
}

function browserHost(): AppInstallHost | undefined {
    if (typeof window === 'undefined') return undefined
    return {
        addEventListener: (type, listener) => window.addEventListener(type, listener),
        removeEventListener: (type, listener) => window.removeEventListener(type, listener),
        matchMedia: (query) => window.matchMedia(query),
        navigator: navigator as Navigator & { standalone?: boolean },
    }
}

/** Test seam: forget any captured offer and subscribers. */
export function resetAppInstallForTests(): void {
    state = { installed: false, promptAvailable: false }
    pending = null
    listeners.clear()
}
