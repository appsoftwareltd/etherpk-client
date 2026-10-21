/**
 * When the Client offers to install itself as an [[Installed App]], beyond the permanent Install
 * entries (the account menu, the phone drawer, the Command Menu and Graph Settings).
 *
 * An offer appears at a moment when installing helps with what the person is doing, never while
 * they are editing, in the place they are already looking. Three rules keep it from nagging:
 *
 * - each offer is shown at most once on a device, whatever the person did with it;
 * - at most one offer is shown in a session (a tab, until it is closed);
 * - the session's offer keeps its place while the person moves around, until they dismiss it.
 *
 * What was seen is a per-device convenience in localStorage and sessionStorage. A browser that
 * clears them, or refuses them in a private window, may offer again, which is harmless.
 */

import { type InstallPlatform, canInstall } from './install-platform'

export type InstallOfferMoment =
    /** iPhone and iPad, before the first sign-in: the Installed App keeps storage apart from Safari's. */
    | 'before-sign-in'
    /** The browser cleared some of EtherPK's data, and installing makes that less likely. */
    | 'storage-cleared'
    /** A folder graph asks for access again. An installed app keeps it, on a computer only. */
    | 'folder-access'
    /** Quick notes: sharing from other apps needs the Installed App, on Android and ChromeOS. */
    | 'quick-notes'

export interface InstallOfferContext {
    platform: InstallPlatform
    /** Running as the Installed App now. */
    installed: boolean
    /** Known to be installed on this device, though this is a browser tab. */
    installedOnDevice: boolean
}

/** Whether the offer makes sense here at all, before the once-only rules are applied. */
export function installOfferEligible(moment: InstallOfferMoment, context: InstallOfferContext): boolean {
    if (context.installed || context.installedOnDevice || !canInstall(context.platform)) return false
    switch (moment) {
        case 'before-sign-in':
            return context.platform === 'ios'
        case 'folder-access':
            // Chrome keeps an Installed App's folder access between visits on a computer. Chrome on
            // Android never keeps it, so the offer would promise something untrue there.
            return context.platform === 'chromium-desktop' || context.platform === 'chromeos'
        case 'quick-notes':
            // The share target works on Android and ChromeOS only.
            return context.platform === 'chromium-android' || context.platform === 'chromeos'
        case 'storage-cleared':
            return true
    }
}

interface SessionOffer {
    moment: InstallOfferMoment
    dismissed: boolean
}

/** Where the once-only rules keep what was shown. */
export interface OfferMemory {
    seen(moment: InstallOfferMoment): boolean
    markSeen(moment: InstallOfferMoment): void
    sessionOffer(): SessionOffer | null
    setSessionOffer(offer: SessionOffer): void
}

/**
 * Whether the offer may be shown now, recording it when it may. Call when the place that holds
 * the offer is drawn, after `installOfferEligible` said yes.
 */
export function claimInstallOffer(moment: InstallOfferMoment, memory: OfferMemory = browserOfferStore()): boolean {
    const current = memory.sessionOffer()
    if (current) return current.moment === moment && !current.dismissed
    if (memory.seen(moment)) return false
    memory.markSeen(moment)
    memory.setSessionOffer({ moment, dismissed: false })
    return true
}

/** The person closed the offer: it stays closed for the rest of the session. */
export function dismissInstallOffer(moment: InstallOfferMoment, memory: OfferMemory = browserOfferStore()): void {
    const current = memory.sessionOffer()
    if (current?.moment === moment) memory.setSessionOffer({ moment, dismissed: true })
}

/** An in-memory store, for tests and for a browser that refuses storage. `endSession` starts a new session. */
export function memoryOfferStore(): OfferMemory & { endSession(): void } {
    const seen = new Set<InstallOfferMoment>()
    let session: SessionOffer | null = null
    return {
        seen: (moment) => seen.has(moment),
        markSeen: (moment) => void seen.add(moment),
        sessionOffer: () => session,
        setSessionOffer: (offer) => {
            session = offer
        },
        endSession: () => {
            session = null
        },
    }
}

const SEEN_KEY = 'etherpk:install-offers-seen'
const SESSION_KEY = 'etherpk:install-offer-session'

/** Used when storage throws, so the rules still hold within this page. */
const fallback = memoryOfferStore()

/** The store over localStorage (seen, per device) and sessionStorage (this tab's offer). */
export function browserOfferStore(): OfferMemory {
    return {
        seen(moment) {
            try {
                return readSeen().includes(moment)
            } catch {
                return fallback.seen(moment)
            }
        },
        markSeen(moment) {
            try {
                const seen = readSeen()
                if (!seen.includes(moment)) localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, moment]))
            } catch {
                fallback.markSeen(moment)
            }
        },
        sessionOffer() {
            try {
                const raw = sessionStorage.getItem(SESSION_KEY)
                return raw ? (JSON.parse(raw) as SessionOffer) : null
            } catch {
                return fallback.sessionOffer()
            }
        },
        setSessionOffer(offer) {
            try {
                sessionStorage.setItem(SESSION_KEY, JSON.stringify(offer))
            } catch {
                fallback.setSessionOffer(offer)
            }
        },
    }
}

function readSeen(): string[] {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}
