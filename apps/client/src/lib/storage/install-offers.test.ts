import { describe, expect, it } from 'vitest'

import { claimInstallOffer, dismissInstallOffer, installOfferEligible, memoryOfferStore } from './install-offers'

const notInstalled = { installed: false, installedOnDevice: false }

describe('installOfferEligible', () => {
    it('offers nothing once the app is installed, here or elsewhere on the device', () => {
        expect(installOfferEligible('storage-cleared', { ...notInstalled, platform: 'chromium-android' })).toBe(true)
        expect(installOfferEligible('storage-cleared', { installed: true, installedOnDevice: false, platform: 'chromium-android' })).toBe(false)
        expect(installOfferEligible('storage-cleared', { installed: false, installedOnDevice: true, platform: 'chromium-android' })).toBe(false)
    })

    it('offers nothing where the browser cannot install', () => {
        expect(installOfferEligible('storage-cleared', { ...notInstalled, platform: 'firefox-desktop' })).toBe(false)
        expect(installOfferEligible('storage-cleared', { ...notInstalled, platform: 'other' })).toBe(false)
    })

    it('asks iPhone and iPad to install before signing in, and no one else', () => {
        expect(installOfferEligible('before-sign-in', { ...notInstalled, platform: 'ios' })).toBe(true)
        expect(installOfferEligible('before-sign-in', { ...notInstalled, platform: 'chromium-android' })).toBe(false)
    })

    it('offers to keep folder access only where an installed app keeps it: Chrome and Edge on a computer', () => {
        expect(installOfferEligible('folder-access', { ...notInstalled, platform: 'chromium-desktop' })).toBe(true)
        expect(installOfferEligible('folder-access', { ...notInstalled, platform: 'chromeos' })).toBe(true)
        expect(installOfferEligible('folder-access', { ...notInstalled, platform: 'chromium-android' })).toBe(false)
    })

    it('offers sharing from other apps only where the share target works: Android and ChromeOS', () => {
        expect(installOfferEligible('quick-notes', { ...notInstalled, platform: 'chromium-android' })).toBe(true)
        expect(installOfferEligible('quick-notes', { ...notInstalled, platform: 'chromeos' })).toBe(true)
        expect(installOfferEligible('quick-notes', { ...notInstalled, platform: 'chromium-desktop' })).toBe(false)
        expect(installOfferEligible('quick-notes', { ...notInstalled, platform: 'ios' })).toBe(false)
    })
})

describe('claimInstallOffer', () => {
    function fresh() {
        return memoryOfferStore()
    }

    it('shows each offer at most once per device', () => {
        const device = fresh()
        expect(claimInstallOffer('storage-cleared', device)).toBe(true)
        // A later session on the same device: the offer was seen.
        device.endSession()
        expect(claimInstallOffer('storage-cleared', device)).toBe(false)
    })

    it('shows at most one offer per session', () => {
        const device = fresh()
        expect(claimInstallOffer('storage-cleared', device)).toBe(true)
        expect(claimInstallOffer('quick-notes', device)).toBe(false)
        device.endSession()
        expect(claimInstallOffer('quick-notes', device)).toBe(true)
    })

    it('keeps showing the session offer when its place is drawn again, until it is dismissed', () => {
        const device = fresh()
        expect(claimInstallOffer('quick-notes', device)).toBe(true)
        expect(claimInstallOffer('quick-notes', device)).toBe(true)
        dismissInstallOffer('quick-notes', device)
        expect(claimInstallOffer('quick-notes', device)).toBe(false)
    })
})
