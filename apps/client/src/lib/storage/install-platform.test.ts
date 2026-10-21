import { describe, expect, it } from 'vitest'

import { canInstall, installPlatform, installSteps } from './install-platform'

// Real user agent strings, trimmed to the parts the detection reads.
const UA = {
    chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    edgeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
    chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36',
    samsungAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/138.0.0.0 Mobile Safari/537.36',
    firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:158.0) Gecko/158.0 Firefox/158.0',
    firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0',
    safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1',
}

describe('installPlatform', () => {
    it('tells the Chromium platforms apart, since each installs differently', () => {
        expect(installPlatform(UA.chromeWindows)).toBe('chromium-desktop')
        expect(installPlatform(UA.edgeMac)).toBe('chromium-desktop')
        expect(installPlatform(UA.chromeOs)).toBe('chromeos')
        expect(installPlatform(UA.chromeAndroid)).toBe('chromium-android')
        expect(installPlatform(UA.samsungAndroid)).toBe('chromium-android')
    })

    it('puts every browser on an iPhone on iOS, whatever its name', () => {
        expect(installPlatform(UA.safariIphone)).toBe('ios')
        expect(installPlatform(UA.chromeIphone)).toBe('ios')
    })

    it('reads an iPad that reports itself as a Mac from its touch points', () => {
        expect(installPlatform(UA.safariMac, 5)).toBe('ios')
        expect(installPlatform(UA.safariMac, 0)).toBe('safari-mac')
    })

    it('separates the Firefox builds that install from the ones that cannot', () => {
        expect(installPlatform(UA.firefoxWindows)).toBe('firefox-windows')
        expect(installPlatform(UA.firefoxAndroid)).toBe('firefox-android')
        expect(installPlatform(UA.firefoxLinux)).toBe('firefox-desktop')
    })

    it('falls back to other for anything it does not recognise', () => {
        expect(installPlatform('curl/8.0')).toBe('other')
        expect(installPlatform('')).toBe('other')
    })
})

describe('installSteps', () => {
    it('gives iPhone and iPad the Share sheet steps', () => {
        const steps = installSteps('ios').join(' ')
        expect(steps).toContain('Share')
        expect(steps).toContain('Add to Home Screen')
        expect(steps).toContain('Open as Web App')
    })

    it('gives every platform that can install at least one step, and the others none', () => {
        for (const platform of ['chromium-desktop', 'chromeos', 'chromium-android', 'ios', 'safari-mac', 'firefox-windows', 'firefox-android'] as const) {
            expect(canInstall(platform)).toBe(true)
            expect(installSteps(platform).length).toBeGreaterThan(0)
        }
        expect(canInstall('firefox-desktop')).toBe(false)
        expect(canInstall('other')).toBe(false)
        expect(installSteps('firefox-desktop')).toEqual([])
    })
})
