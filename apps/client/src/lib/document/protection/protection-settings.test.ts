import { describe, expect, it } from 'vitest'

import {
    DEFAULT_LOCK_PREFERENCES,
    MAX_IDLE_LOCK_MS,
    MAX_MASK_GRACE_MS,
    clampLockSettings,
    parseLockSettings,
} from './protection-settings'

describe('clamping', () => {
    it('keeps a sensible value untouched', () => {
        expect(clampLockSettings({ maskGraceMs: 30_000, idleLockMs: 120_000, closeOnLockNow: false })).toEqual({
            maskGraceMs: 30_000,
            idleLockMs: 120_000,
            closeOnLockNow: false,
        })
    })

    // A hard lock on every blur is a legitimate choice for someone who wants it, so zero must not
    // be floored away (ADR 0058).
    it('allows a zero mask grace, so hard-lock-on-blur stays reachable', () => {
        expect(clampLockSettings({ maskGraceMs: 0 }).maskGraceMs).toBe(0)
    })

    it('allows a zero idle timeout, which disables idle locking', () => {
        expect(clampLockSettings({ idleLockMs: 0 }).idleLockMs).toBe(0)
    })

    it('caps values that are past the point of being useful', () => {
        expect(clampLockSettings({ maskGraceMs: 1e9, idleLockMs: 1e12 })).toEqual({
            ...DEFAULT_LOCK_PREFERENCES,
            maskGraceMs: MAX_MASK_GRACE_MS,
            idleLockMs: MAX_IDLE_LOCK_MS,
        })
    })

    it('falls back to the default for a negative or non-finite value', () => {
        expect(clampLockSettings({ maskGraceMs: -1, idleLockMs: Number.NaN })).toEqual(DEFAULT_LOCK_PREFERENCES)
    })

    it('falls back to the defaults for an absent value', () => {
        expect(clampLockSettings(null)).toEqual(DEFAULT_LOCK_PREFERENCES)
    })

    // Closing on a Lock Now is a privacy setting, so a record written before the flag existed —
    // or one mangled into a string — must read as ON, never as off.
    it('defaults closing on Lock Now to on, including for a non-boolean value', () => {
        expect(clampLockSettings({ maskGraceMs: 30_000 }).closeOnLockNow).toBe(true)
        expect(clampLockSettings({ closeOnLockNow: 'yes' as unknown as boolean }).closeOnLockNow).toBe(true)
    })

    it('keeps closing on Lock Now off when the user turned it off', () => {
        expect(clampLockSettings({ closeOnLockNow: false }).closeOnLockNow).toBe(false)
    })
})

describe('parsing stored settings', () => {
    it('round-trips what was written', () => {
        expect(
            parseLockSettings(JSON.stringify({ maskGraceMs: 5_000, idleLockMs: 60_000, closeOnLockNow: false })),
        ).toEqual({
            maskGraceMs: 5_000,
            idleLockMs: 60_000,
            closeOnLockNow: false,
        })
    })

    // A corrupt value must never read as "no locking" — that would silently turn the feature off
    // on a device whose storage got mangled.
    it.each([[null], [''], ['not json'], ['[]'], ['"a string"']])('falls back to the defaults for %p', (stored) => {
        expect(parseLockSettings(stored)).toEqual(DEFAULT_LOCK_PREFERENCES)
    })

    it('clamps a value stored by a future or hand-edited client', () => {
        expect(parseLockSettings(JSON.stringify({ maskGraceMs: 999_999_999 })).maskGraceMs).toBe(MAX_MASK_GRACE_MS)
    })
})
