import { NATIVE_BRIDGE_VERSION, type NativePort } from '@appsoftwareltd/etherpk-native-bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'

function port(over: Partial<NativePort['info']> = {}): NativePort {
    return {
        info: {
            bridgeVersion: NATIVE_BRIDGE_VERSION,
            platform: 'android',
            appVersion: '1.2.3',
            features: { watch: false, showInFileManager: false, print: true, signIn: false, updates: true },
            ...over,
        },
        call: async () => ({ ok: false, name: 'NotSupportedError', message: 'no' }),
        on: () => () => {},
    }
}

async function loadIn(window: object | undefined) {
    vi.resetModules()
    vi.unstubAllGlobals()
    if (window) vi.stubGlobal('window', window)
    return import('./bridge.js')
}

afterEach(() => vi.unstubAllGlobals())

describe('the Native Bridge, as the Client reads it', () => {
    it('is absent on the server, which has no window', async () => {
        const native = await loadIn(undefined)
        expect(native.nativeBridge()).toBeNull()
        expect(native.isNativeApp()).toBe(false)
        expect(native.nativePlatform()).toBeNull()
        expect(native.hasNativeFeature('print')).toBe(false)
    })

    it('is absent in a browser', async () => {
        const native = await loadIn({})
        expect(native.nativeBridge()).toBeNull()
        expect(native.isNativeApp()).toBe(false)
    })

    it('is there in a Native App, with the platform and its features', async () => {
        const native = await loadIn({ etherpkNative: port() })
        expect(native.isNativeApp()).toBe(true)
        expect(native.nativePlatform()).toBe('android')
        expect(native.hasNativeFeature('print')).toBe(true)
        expect(native.hasNativeFeature('watch')).toBe(false)
    })

    it('throws a failure as the DOMException the shell named', async () => {
        const native = await loadIn({ etherpkNative: port() })
        await expect(native.nativeBridge()!.call('updates.check', {})).rejects.toMatchObject({ name: 'NotSupportedError' })
    })

    it('keeps the port it read first', async () => {
        const window: Record<string, unknown> = { etherpkNative: port() }
        const native = await loadIn(window)
        const before = native.nativeBridge()
        window.etherpkNative = port({ platform: 'windows' })
        expect(native.nativeBridge()).toBe(before)
        expect(native.nativePlatform()).toBe('android')
    })

    it('refuses a shell that speaks another version', async () => {
        await expect(loadIn({ etherpkNative: port({ bridgeVersion: NATIVE_BRIDGE_VERSION + 1 }) })).rejects.toThrow(/bridge version/)
    })
})
