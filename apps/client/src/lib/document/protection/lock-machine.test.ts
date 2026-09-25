import { describe, expect, it } from 'vitest'

import {
    DEFAULT_LOCK_SETTINGS,
    type LockEvent,
    type LockState,
    initialLockState,
    lockReducer,
} from './lock-machine'

const KEY = new Uint8Array(32).fill(7)
const SETTINGS = { ...DEFAULT_LOCK_SETTINGS, maskGraceMs: 60_000, idleLockMs: 300_000 }

/** Drive the machine from a starting state, returning the final state and everything it asked for. */
function run(state: LockState, events: LockEvent[], settings = SETTINGS) {
    const effects: string[] = []
    let current = state
    for (const event of events) {
        const next = lockReducer(current, event, settings)
        effects.push(...next.effects.map((e) => e.kind))
        current = next.state
    }
    return { state: current, effects }
}

function unlocked(at = 0): LockState {
    return lockReducer(initialLockState(), { type: 'unlocked', key: KEY, now: at }, SETTINGS).state
}

describe('the resting state', () => {
    it('is locked, holding no key', () => {
        expect(initialLockState().status).toBe('locked')
        expect(initialLockState().key).toBeNull()
    })
})

describe('unlocking', () => {
    it('brings the key into memory', () => {
        expect(unlocked().status).toBe('unlocked')
        expect(unlocked().key).toBe(KEY)
    })

    it('is the unit of access: one unlock covers the whole graph', () => {
        // The machine holds a key, not a set of documents, which is what makes a per-document gate
        // over a key we already hold impossible to express here (ADR 0058).
        expect(Object.keys(unlocked())).not.toContain('unlockedDocuments')
    })
})

describe('masking (instant, attention-driven)', () => {
    it.each([['hidden'], ['blurred'], ['navigatedAway']] as const)('masks on %s without discarding the key', (type) => {
        const { state } = run(unlocked(), [{ type, now: 1_000 }])

        expect(state.status).toBe('masked')
        expect(state.key).toBe(KEY)
    })

    it('reveals again with no credential when attention returns inside the grace period', () => {
        const { state } = run(unlocked(), [
            { type: 'hidden', now: 1_000 },
            { type: 'shown', now: 30_000 },
        ])

        expect(state.status).toBe('unlocked')
        expect(state.key).toBe(KEY)
    })

    it('never masks a state that holds no key', () => {
        const { state } = run(initialLockState(), [{ type: 'hidden', now: 1_000 }])

        expect(state.status).toBe('locked')
    })
})

describe('locking (timed, durable)', () => {
    it('discards the key when the mask grace period expires', () => {
        const { state } = run(unlocked(), [
            { type: 'hidden', now: 1_000 },
            { type: 'tick', now: 1_000 + SETTINGS.maskGraceMs },
        ])

        expect(state.status).toBe('locked')
        expect(state.key).toBeNull()
    })

    it('does not lock while still inside the grace period', () => {
        const { state } = run(unlocked(), [
            { type: 'hidden', now: 1_000 },
            { type: 'tick', now: 1_000 + SETTINGS.maskGraceMs - 1 },
        ])

        expect(state.status).toBe('masked')
    })

    it('discards the key after the idle timeout with no input anywhere in the app', () => {
        const { state } = run(unlocked(), [{ type: 'tick', now: SETTINGS.idleLockMs }])

        expect(state.status).toBe('locked')
    })

    it('treats any activity as resetting the idle timer', () => {
        const { state } = run(unlocked(), [
            { type: 'activity', now: SETTINGS.idleLockMs - 1 },
            { type: 'tick', now: SETTINGS.idleLockMs + 10 },
        ])

        expect(state.status).toBe('unlocked')
    })

    it('locks immediately on an explicit Lock now', () => {
        const { state } = run(unlocked(), [{ type: 'lockNow', now: 1_000 }])

        expect(state.status).toBe('locked')
        expect(state.key).toBeNull()
    })

    it('locks from masked as readily as from unlocked', () => {
        const { state } = run(unlocked(), [
            { type: 'hidden', now: 1_000 },
            { type: 'lockNow', now: 2_000 },
        ])

        expect(state.status).toBe('locked')
    })
})

describe('committing before the key goes (ADR 0058)', () => {
    // The key is held at the instant of every lock transition by definition, so the forced commit
    // cannot fail. This is what makes locking never lose work.
    it('asks for a commit before discarding the key on an idle lock', () => {
        const { effects } = run(unlocked(), [{ type: 'tick', now: SETTINGS.idleLockMs }])

        expect(effects).toEqual(['commit', 'discardKey'])
    })

    it('asks for a commit before discarding the key on Lock now', () => {
        const { effects } = run(unlocked(), [{ type: 'lockNow', now: 1_000 }])

        expect(effects).toEqual(['commit', 'discardKey'])
    })

    it('asks for a commit when masking too, so a killed tab loses nothing beyond the debounce', () => {
        const { effects } = run(unlocked(), [{ type: 'hidden', now: 1_000 }])

        expect(effects).toEqual(['commit'])
    })

    it('asks for nothing when already locked', () => {
        const { effects } = run(initialLockState(), [{ type: 'lockNow', now: 1_000 }, { type: 'tick', now: 9_999_999 }])

        expect(effects).toEqual([])
    })
})

describe('a zero grace period', () => {
    // A security parameter, not a comfort one (ADR 0058): someone who wants a hard lock on every
    // blur must be able to have one.
    it('locks on hide with no window at all', () => {
        const { state } = run(unlocked(), [{ type: 'hidden', now: 1_000 }], { ...SETTINGS, maskGraceMs: 0 })

        expect(state.status).toBe('locked')
    })

    it('still commits before discarding', () => {
        const { effects } = run(unlocked(), [{ type: 'hidden', now: 1_000 }], { ...SETTINGS, maskGraceMs: 0 })

        expect(effects).toEqual(['commit', 'discardKey'])
    })
})

describe('a disabled idle timeout', () => {
    it('never idle-locks, but still locks on mask grace and on Lock now', () => {
        const settings = { ...SETTINGS, idleLockMs: 0 }

        expect(run(unlocked(), [{ type: 'tick', now: 86_400_000 }], settings).state.status).toBe('unlocked')
        expect(run(unlocked(), [{ type: 'lockNow', now: 1 }], settings).state.status).toBe('locked')
    })
})

describe('the next moment the machine needs to be woken', () => {
    it('is the idle deadline while unlocked', () => {
        expect(unlocked(1_000).wakeAt).toBe(1_000 + SETTINGS.idleLockMs)
    })

    it('is the sooner of the mask grace and the idle deadline while masked', () => {
        const { state } = run(unlocked(0), [{ type: 'hidden', now: 1_000 }])

        expect(state.wakeAt).toBe(1_000 + SETTINGS.maskGraceMs)
    })

    it('is null while locked, so nothing is scheduled at rest', () => {
        expect(initialLockState().wakeAt).toBeNull()
    })
})

describe('default settings', () => {
    it('are a 60 second mask grace and a 5 minute idle lock', () => {
        expect(DEFAULT_LOCK_SETTINGS.maskGraceMs).toBe(60_000)
        expect(DEFAULT_LOCK_SETTINGS.idleLockMs).toBe(300_000)
    })
})
