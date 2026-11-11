import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { devicePasscodeMarkDue, devicePasscodeNoticeShown, markDevicePasscodeNoticeShown } from './device-passcode-notice'

function memoryStorage(): Storage {
    const store = new Map<string, string>()
    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, String(value)),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() {
            return store.size
        },
    }
}

describe('the Device Passcode notice, shown once per device (ADR 0129)', () => {
    beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
    afterEach(() => vi.unstubAllGlobals())

    it('is due until it has been shown, and never again after', () => {
        expect(devicePasscodeNoticeShown()).toBe(false)
        markDevicePasscodeNoticeShown()
        expect(devicePasscodeNoticeShown()).toBe(true)
        expect(localStorage.getItem('etherpk.device-passcode-notice-shown')).toBe('1')
    })

    it('counts as shown where storage refuses, rather than showing on every open', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new DOMException('denied', 'SecurityError')
            },
            setItem: () => {
                throw new DOMException('denied', 'SecurityError')
            },
        })
        expect(devicePasscodeNoticeShown()).toBe(true)
        expect(() => markDevicePasscodeNoticeShown()).not.toThrow()
    })
})

describe('the mark on the This Device tab for a passcode not set (ADR 0129)', () => {
    const managed = (vaultUnlocked: boolean) => ({ connection: { kind: 'managed' as const }, vaultUnlocked })
    const custom = (vaultUnlocked: boolean) => ({ connection: { kind: 'custom' as const }, vaultUnlocked })

    it('stays off on a device that holds no Sync Server', () => {
        expect(devicePasscodeMarkDue('off', [])).toBe(false)
    })

    it('stays off for Managed Sync held without its Encryption Keys: signed out, or not unlocked here', () => {
        // Managed Sync's credential is the Client's session, so without the keys nothing is stored
        // that a passcode would encrypt.
        expect(devicePasscodeMarkDue('off', [managed(false)])).toBe(false)
    })

    it('shows once this device holds a server\'s Encryption Keys', () => {
        expect(devicePasscodeMarkDue('off', [managed(true)])).toBe(true)
        expect(devicePasscodeMarkDue('off', [managed(false), custom(true)])).toBe(true)
    })

    it('shows for a custom server before its keys are held, because its access token is stored', () => {
        expect(devicePasscodeMarkDue('off', [custom(false)])).toBe(true)
    })

    it('never shows while a passcode is set, entered or not', () => {
        expect(devicePasscodeMarkDue('locked', [managed(true), custom(true)])).toBe(false)
        expect(devicePasscodeMarkDue('unlocked', [managed(true), custom(true)])).toBe(false)
    })
})
