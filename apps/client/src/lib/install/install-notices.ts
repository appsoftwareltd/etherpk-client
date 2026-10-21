/**
 * Install messages that belong to a notice rather than a place of their own: the welcome on the
 * Installed App's first launch, and the claim a notice makes when it adds an Install button (the
 * storage recovery notice). Offers that stand in a place of their own are `InstallOffer.svelte`.
 */

import { showNotice } from '$lib/activity/notices'
import { appInstallState } from '$lib/storage/app-install'
import { type InstallOfferMoment, claimInstallOffer, installOfferEligible } from '$lib/storage/install-offers'
import { currentInstallPlatform } from '$lib/storage/install-platform'

export const INSTALL_WELCOME_NOTICE = 'install-welcome'

const WELCOME_SEEN_KEY = 'etherpk:installed-app-welcomed'

/**
 * Whether the offer for `moment` may be shown now, claiming it if so, for a caller that adds the
 * offer to a notice of its own.
 */
export function claimInstallOfferHere(moment: InstallOfferMoment): boolean {
    const context = { platform: currentInstallPlatform(), ...appInstallState() }
    return installOfferEligible(moment, context) && claimInstallOffer(moment)
}

/**
 * Once per device, on the first launch of the Installed App: say what the install gives. A
 * report, so it goes by itself.
 */
export function welcomeInstalledApp(): void {
    if (!appInstallState().installed) return
    try {
        if (localStorage.getItem(WELCOME_SEEN_KEY)) return
        localStorage.setItem(WELCOME_SEEN_KEY, '1')
    } catch {
        // Without storage the welcome could repeat on every launch, so it is not shown at all.
        return
    }
    showNotice({
        id: INSTALL_WELCOME_NOTICE,
        tone: 'info',
        text: 'EtherPK is installed. It opens from your home screen, Dock or taskbar, starts with no network, and your browser is less likely to clear its data.',
    })
}
