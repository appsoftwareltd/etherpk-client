/**
 * The protection lock preferences — a **per-device** record (ADR 0058, following ADR 0013's
 * precedent for [[Layout]]). `localStorage`, not a cookie: it is purely client-side and never
 * needed at SSR, the same reasoning as `editor-font.ts`.
 *
 * Per device rather than per graph because the right timeout is a property of where the device
 * physically is, and only the device knows that. A desktop in a locked room and a laptop on a
 * train deserve different answers, and a setting that synced between them would have to be wrong
 * for one of them. The same holds for what a [[Lock Now]] does to the tab strip: it acts on the
 * Layout, which is per device too.
 *
 * Both ends of each range are reachable on purpose:
 * - a **zero mask grace** means lock the instant attention leaves, which is a security parameter
 *   rather than a comfort one and must not be hidden behind a floor;
 * - a **zero idle timeout** disables idle locking, for a device the user considers physically safe.
 */
import { DEFAULT_LOCK_SETTINGS, type LockSettings } from './lock-machine'

const STORAGE_KEY = 'etherpk:protection-lock'

/**
 * The whole per-device record: the reducer's timings, plus what a [[Lock Now]] does beyond
 * discarding the key. Kept apart from {@link LockSettings} because the lock machine has no
 * business knowing about tabs — it is clock-only by design, and this flag is read by the
 * workspace at the three places the user can press Lock now, never by the reducer.
 */
export interface LockPreferences extends LockSettings {
    /**
     * Close every open View on a [[Protected Document]] after a Lock Now. A privacy setting, not
     * a tidiness one: a deliberate lock is the user saying they are leaving, and a row of
     * padlocked tabs still names what they had open. Only a Lock Now — a timer running out
     * mid-work must never take the user's tabs away.
     */
    closeOnLockNow: boolean
}

export const DEFAULT_LOCK_PREFERENCES: LockPreferences = { ...DEFAULT_LOCK_SETTINGS, closeOnLockNow: true }

/** Above this a "grace period" stops being one; the idle timer should be doing the work instead. */
export const MAX_MASK_GRACE_MS = 10 * 60_000
/** A day is already far past the point of usefulness; beyond it, turn idle locking off instead. */
export const MAX_IDLE_LOCK_MS = 24 * 60 * 60_000

/**
 * Clamp to the supported range. A non-finite or negative timing, or a non-boolean flag, falls
 * back to its default.
 */
export function clampLockSettings(raw: Partial<LockPreferences> | null | undefined): LockPreferences {
    return {
        maskGraceMs: clamp(raw?.maskGraceMs, DEFAULT_LOCK_SETTINGS.maskGraceMs, MAX_MASK_GRACE_MS),
        idleLockMs: clamp(raw?.idleLockMs, DEFAULT_LOCK_SETTINGS.idleLockMs, MAX_IDLE_LOCK_MS),
        closeOnLockNow:
            typeof raw?.closeOnLockNow === 'boolean' ? raw.closeOnLockNow : DEFAULT_LOCK_PREFERENCES.closeOnLockNow,
    }
}

function clamp(value: unknown, fallback: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
    return Math.min(max, Math.round(value))
}

/** Parse the stored JSON, tolerating anything malformed — a corrupt value must not disable locking. */
export function parseLockSettings(value: string | null | undefined): LockPreferences {
    if (!value) return { ...DEFAULT_LOCK_PREFERENCES }
    try {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ...DEFAULT_LOCK_PREFERENCES }
        }
        return clampLockSettings(parsed as Partial<LockPreferences>)
    } catch {
        return { ...DEFAULT_LOCK_PREFERENCES }
    }
}

export function readLockSettings(): LockPreferences {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_LOCK_PREFERENCES }
    return parseLockSettings(localStorage.getItem(STORAGE_KEY))
}

export function writeLockSettings(settings: Partial<LockPreferences>): LockPreferences {
    const clamped = clampLockSettings({ ...readLockSettings(), ...settings })
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(clamped))
    return clamped
}
