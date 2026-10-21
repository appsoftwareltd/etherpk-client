/**
 * Whether EtherPK can be installed on this device as an [[Installed App]], and the one way to
 * offer the browser's own install dialog.
 *
 * Installing is the lever that earns eviction protection on a phone: Chromium grants
 * `navigator.storage.persist()` (see `storage-persistence.ts`) on engagement heuristics, and an
 * installed app is the reliable one. It also puts EtherPK on the share sheet on Android and
 * ChromeOS. So the Client offers it in several places (the account menu, the phone drawer, the
 * Command Menu, Graph Settings, and the offers in `install-offers.ts`), and they all read this
 * module.
 *
 * Chromium fires `beforeinstallprompt` once, early, whenever the install criteria are met and
 * the app is not yet installed. The event is the only handle on the browser's own install
 * dialog: it must be captured when it fires and can be used exactly once. It can fire before the
 * app has started, so an inline script in `app.html` holds it on `window` until
 * `watchAppInstall` adopts it, and the event then lives here, at module level, rather than in
 * the component that shows the button. Safari and Firefox never fire it; there the Client shows
 * the platform's own steps (`install-platform.ts`).
 *
 * Each outcome (the dialog accepted or dismissed, and the app installed by any route) is
 * reported to the Client's server as one request it answers with nothing, so the request log
 * can count installs. No identifier is sent or stored.
 */

import { ensurePersistentStorage } from './storage-persistence'

export interface AppInstallState {
    /** Running as an installed app (standalone display mode) on this device. */
    installed: boolean
    /** The browser has offered its install dialog and `promptInstall()` can show it. */
    promptAvailable: boolean
    /**
     * The app is installed on this device, though this page is a browser tab. Only Chrome and Edge
     * on a computer can tell (`getInstalledRelatedApps`), so false means "not known".
     */
    installedOnDevice: boolean
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'installed'

/** The subset of Chromium's `BeforeInstallPromptEvent` this module uses. */
export interface InstallPromptEvent extends Event {
    prompt(): Promise<unknown>
    userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

interface DisplayModeQuery {
    readonly matches: boolean
    addEventListener?(type: 'change', listener: () => void): void
    removeEventListener?(type: 'change', listener: () => void): void
}

/** What `watchAppInstall` needs from `window` and `navigator`; narrowed so the unit tier can fake it. */
export interface AppInstallHost {
    addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
    removeEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void
    matchMedia?(query: string): DisplayModeQuery
    navigator?: { standalone?: boolean }
    /** The offer the inline script in `app.html` caught before the app started, if any. */
    heldOffer?(): InstallPromptEvent | null
    /** Chromium's `navigator.getInstalledRelatedApps`, where it exists. */
    getInstalledRelatedApps?(): Promise<Array<{ platform: string }>>
    /** Send one outcome to the server. Must not throw. */
    report?(outcome: InstallOutcome): void
}

/** The `window` property the inline script in `app.html` holds an early offer on. */
export const HELD_INSTALL_OFFER = '__etherpkInstallOffer'

/** Where an outcome is counted: the Client's own server, which answers 204 and keeps nothing. */
export const INSTALL_OUTCOME_ENDPOINT = '/api/install'

const STANDALONE_QUERY = '(display-mode: standalone)'

let state: AppInstallState = { installed: false, promptAvailable: false, installedOnDevice: false }
let pending: InstallPromptEvent | null = null
let reporter: (outcome: InstallOutcome) => void = () => {}
const listeners = new Set<(state: AppInstallState) => void>()

function emit(): void {
    for (const listener of listeners) listener(state)
}

function set(next: Partial<AppInstallState>): void {
    state = { ...state, ...next }
    emit()
}

function isInstalled(host: AppInstallHost, query: DisplayModeQuery | undefined): boolean {
    return query?.matches === true || host.navigator?.standalone === true
}

/**
 * Start listening for the browser's install offer. Call once at app start. Returns a stop
 * function; the captured offer, if any, is kept so a later dialog can use it.
 */
export function watchAppInstall(host: AppInstallHost | undefined = browserHost()): () => void {
    if (!host) return () => {}
    reporter = host.report ?? (() => {})
    const displayMode = host.matchMedia?.(STANDALONE_QUERY)
    set({ installed: isInstalled(host, displayMode) })

    const held = host.heldOffer?.()
    if (held) {
        pending = held
        set({ promptAvailable: true })
    }

    const onPrompt = (event: Event) => {
        // Chromium shows its own mini-infobar unless the event is default-prevented. The
        // Client's Install entries and its offers at moments of value stand in for it, so it
        // is suppressed and a person is never offered twice at once.
        event.preventDefault()
        pending = event as InstallPromptEvent
        set({ promptAvailable: true })
    }
    const onInstalled = () => {
        pending = null
        set({ installed: true, promptAvailable: false })
        reporter('installed')
        // An installed app is what Chromium's persistence heuristic rewards; a request made
        // before the install may have been refused, so ask again now that it would be granted.
        void ensurePersistentStorage()
    }
    // The display mode changes under a running page when the browser opens it in the app's own
    // window, or the person uninstalls the app from a tab.
    const onDisplayMode = () => set({ installed: isInstalled(host, displayMode) })

    host.addEventListener('beforeinstallprompt', onPrompt)
    host.addEventListener('appinstalled', onInstalled)
    displayMode?.addEventListener?.('change', onDisplayMode)

    let stopped = false
    if (!state.installed && host.getInstalledRelatedApps) {
        host.getInstalledRelatedApps().then(
            (apps) => {
                if (!stopped && apps.some((app) => app.platform === 'webapp')) set({ installedOnDevice: true })
            },
            () => {},
        )
    }

    return () => {
        stopped = true
        host.removeEventListener('beforeinstallprompt', onPrompt)
        host.removeEventListener('appinstalled', onInstalled)
        displayMode?.removeEventListener?.('change', onDisplayMode)
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
    let outcome: 'accepted' | 'dismissed'
    try {
        await offer.prompt()
        const choice = await offer.userChoice
        outcome = choice?.outcome ?? 'dismissed'
    } catch {
        outcome = 'dismissed'
    }
    reporter(outcome)
    return outcome
}

/**
 * Count one outcome: a GET the Client's server answers with 204, so its request log holds the
 * count. No cookie and no identifier go with it, and a failure (offline) is dropped.
 */
function reportToServer(outcome: InstallOutcome): void {
    try {
        void fetch(`${INSTALL_OUTCOME_ENDPOINT}?outcome=${outcome}`, {
            credentials: 'omit',
            cache: 'no-store',
            keepalive: true,
        }).catch(() => {})
    } catch {
        // A fetch that throws synchronously (a refused URL) must not break the install flow.
    }
}

function browserHost(): AppInstallHost | undefined {
    if (typeof window === 'undefined') return undefined
    const relatedApps = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<Array<{ platform: string }>> })
        .getInstalledRelatedApps
    return {
        addEventListener: (type, listener) => window.addEventListener(type, listener),
        removeEventListener: (type, listener) => window.removeEventListener(type, listener),
        matchMedia: (query) => window.matchMedia(query),
        navigator: navigator as Navigator & { standalone?: boolean },
        heldOffer: () => {
            const holder = window as unknown as Record<string, InstallPromptEvent | null | undefined>
            const offer = holder[HELD_INSTALL_OFFER] ?? null
            holder[HELD_INSTALL_OFFER] = null
            return offer
        },
        getInstalledRelatedApps: relatedApps ? () => relatedApps.call(navigator) : undefined,
        report: reportToServer,
    }
}

/** Test seam: forget any captured offer and subscribers. */
export function resetAppInstallForTests(): void {
    state = { installed: false, promptAvailable: false, installedOnDevice: false }
    pending = null
    reporter = () => {}
    listeners.clear()
}
