import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { devicePasscodeNoticeShown, markDevicePasscodeNoticeShown } from './device-passcode-notice'

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
