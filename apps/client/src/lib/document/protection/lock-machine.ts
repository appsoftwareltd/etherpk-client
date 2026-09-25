/**
 * The lock lifecycle as a pure reducer (ADR 0058). No timers, no DOM, no key storage — the host
 * (`protection-session.svelte.ts`) supplies `now`, listens for the browser events and carries out
 * the effects. Keeping it pure is what makes "does a backgrounded tab still hold the key?" a
 * question a unit test can answer.
 *
 * Two events on two clocks, and the whole point is that they are separate:
 *
 * - **Masking** is instantaneous and attention-driven — the window hidden or blurred, or the user
 *   navigating off the document. The key stays in memory, so returning reveals the content again
 *   with no credential. This is what stops a backgrounded app reactivating on plaintext.
 * - **Locking** is timed and durable — the key is discarded, after which no protected plaintext
 *   exists on the device.
 *
 * Conflate them and you get an app that either leaks a frame of plaintext on resume, or demands a
 * passphrase every time you alt-tab to paste a password somewhere.
 */

export type LockStatus =
    /** No key in memory. The resting state: a graph opens here and returns here. */
    | 'locked'
    /** Key in memory, content on screen. */
    | 'unlocked'
    /** Key in memory, content hidden. Reversible with no credential. */
    | 'masked'

export interface LockSettings {
    /**
     * How long a masked document keeps its key before locking. Zero means lock on every hide — a
     * security parameter, not a comfort one, so it must be reachable.
     */
    maskGraceMs: number
    /** Idle time with no activity anywhere in the app before locking. Zero disables idle locking. */
    idleLockMs: number
}

/** Per device, following ADR 0013 — the right timeout depends on where the device physically is. */
export const DEFAULT_LOCK_SETTINGS: LockSettings = {
    maskGraceMs: 60_000,
    idleLockMs: 300_000,
}

export interface LockState {
    status: LockStatus
    /** The Protection Key, or null when locked. Never persisted anywhere. */
    key: Uint8Array | null
    /** When the key was last used or the user last acted — the idle timer's origin. */
    lastActivityAt: number
    /** When masking began, or null when not masked — the grace timer's origin. */
    maskedAt: number | null
    /** The soonest moment a `tick` could change anything, or null when nothing is pending. */
    wakeAt: number | null
}

export type LockEvent =
    /** A passphrase or passkey brought the key into memory. */
    | { type: 'unlocked'; key: Uint8Array; now: number }
    /** The tab was hidden (`visibilitychange`) or is unloading (`pagehide`). */
    | { type: 'hidden'; now: number }
    /** The window lost focus. */
    | { type: 'blurred'; now: number }
    /** The user navigated off the protected document. */
    | { type: 'navigatedAway'; now: number }
    /** Attention returned — the tab is visible and focused, or the document is open again. */
    | { type: 'shown'; now: number }
    /** Any user input anywhere in the app; resets the idle timer. */
    | { type: 'activity'; now: number }
    /** The explicit **Lock now** command. */
    | { type: 'lockNow'; now: number }
    /** A timer fired, or the host is re-evaluating. Never changes anything on its own. */
    | { type: 'tick'; now: number }

export type LockEffect =
    /**
     * Re-encrypt and write any pending plaintext BEFORE the key goes. The key is held at this
     * instant by definition, so this cannot fail — which is what makes locking never lose work.
     */
    | { kind: 'commit' }
    /** Drop the key. Emitted only after a `commit` in the same transition. */
    | { kind: 'discardKey' }

export interface LockTransition {
    state: LockState
    effects: LockEffect[]
}

export function initialLockState(): LockState {
    return { status: 'locked', key: null, lastActivityAt: 0, maskedAt: null, wakeAt: null }
}

/** Locking always commits first; that ordering is the contract, not an implementation detail. */
function lock(now: number): LockTransition {
    return {
        state: { status: 'locked', key: null, lastActivityAt: now, maskedAt: null, wakeAt: null },
        effects: [{ kind: 'commit' }, { kind: 'discardKey' }],
    }
}

/** When a tick could next matter: the mask grace if masked, else the idle deadline. */
function nextWake(state: Omit<LockState, 'wakeAt'>, settings: LockSettings): number | null {
    const deadlines: number[] = []
    if (state.maskedAt !== null && settings.maskGraceMs > 0) deadlines.push(state.maskedAt + settings.maskGraceMs)
    if (settings.idleLockMs > 0) deadlines.push(state.lastActivityAt + settings.idleLockMs)
    return deadlines.length ? Math.min(...deadlines) : null
}

function settled(state: Omit<LockState, 'wakeAt'>, settings: LockSettings, effects: LockEffect[] = []): LockTransition {
    return { state: { ...state, wakeAt: nextWake(state, settings) }, effects }
}

/** Has this state outlived either deadline? */
function expired(state: LockState, now: number, settings: LockSettings): boolean {
    if (state.maskedAt !== null && now >= state.maskedAt + settings.maskGraceMs) return true
    return settings.idleLockMs > 0 && now >= state.lastActivityAt + settings.idleLockMs
}

export function lockReducer(state: LockState, event: LockEvent, settings: LockSettings): LockTransition {
    // Nothing to protect and nothing to discard: every event is a no-op while locked, which is what
    // keeps a locked graph from scheduling timers or asking for commits it cannot make.
    if (state.status === 'locked' && event.type !== 'unlocked') {
        return { state, effects: [] }
    }

    switch (event.type) {
        case 'unlocked':
            return settled(
                { status: 'unlocked', key: event.key, lastActivityAt: event.now, maskedAt: null },
                settings,
            )

        case 'lockNow':
            return lock(event.now)

        case 'hidden':
        case 'blurred':
        case 'navigatedAway': {
            // A zero grace period means masking and locking coincide — the user asked for a hard
            // lock on every blur, and gets one.
            if (settings.maskGraceMs === 0) return lock(event.now)
            if (state.status === 'masked') return settled({ ...state }, settings)
            // The commit rides the mask, not the lock, so a tab killed while backgrounded loses
            // nothing beyond the debounce.
            return settled({ ...state, status: 'masked', maskedAt: event.now }, settings, [{ kind: 'commit' }])
        }

        case 'shown':
            if (expired(state, event.now, settings)) return lock(event.now)
            return settled({ ...state, status: 'unlocked', maskedAt: null, lastActivityAt: event.now }, settings)

        case 'activity':
            if (expired(state, event.now, settings)) return lock(event.now)
            return settled({ ...state, lastActivityAt: event.now }, settings)

        case 'tick':
            if (expired(state, event.now, settings)) return lock(event.now)
            return settled({ ...state }, settings)
    }
}
