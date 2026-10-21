/**
 * How a person installs EtherPK as an [[Installed App]] on the browser and device they are using.
 *
 * Only Chromium browsers let a page open the install dialog (`beforeinstallprompt`, read in
 * `app-install.ts`). Everywhere else installing is a step in the browser's own menus, so the
 * Client shows the steps for the platform it is on. The platform is read from the user agent,
 * which is enough to choose wording: a wrong guess shows the wrong steps, never a wrong action.
 *
 * Pure, so the unit tier covers every user agent without a browser.
 */

export type InstallPlatform =
    /** Chrome, Edge, Brave or Opera on Windows, macOS or Linux: the address bar's install icon. */
    | 'chromium-desktop'
    /** Chrome on a Chromebook: installs as on a computer, and also takes shares from other apps. */
    | 'chromeos'
    /** Chrome, Edge or Samsung Internet on Android: the browser menu. */
    | 'chromium-android'
    /** Any browser on an iPhone or iPad. All of them use Safari's engine and its Share sheet. */
    | 'ios'
    /** Safari on a Mac: Add to Dock. */
    | 'safari-mac'
    /** Firefox on Windows, version 143 and later: Add tab to taskbar. */
    | 'firefox-windows'
    /** Firefox on Android: the browser menu, which makes a home screen shortcut. */
    | 'firefox-android'
    /** Firefox on macOS or Linux, which cannot install web apps. */
    | 'firefox-desktop'
    | 'other'

/**
 * The platform for a user agent. `maxTouchPoints` tells an iPad apart from a Mac: iPadOS Safari
 * reports itself as a Mac, but a Mac has no touch screen.
 */
export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
    const ua = userAgent.toLowerCase()
    if (/iphone|ipad|ipod/.test(ua)) return 'ios'
    if (ua.includes('firefox/')) {
        if (ua.includes('android')) return 'firefox-android'
        if (ua.includes('windows')) return 'firefox-windows'
        return 'firefox-desktop'
    }
    const chromium = /chrome\/|chromium\/|crios\/|edg\//.test(ua)
    if (ua.includes('android')) return chromium ? 'chromium-android' : 'other'
    if (chromium) return ua.includes('cros') ? 'chromeos' : 'chromium-desktop'
    if (ua.includes('macintosh') && ua.includes('safari/')) return maxTouchPoints > 1 ? 'ios' : 'safari-mac'
    return 'other'
}

/** Whether the browser on this platform can install a web app at all. */
export function canInstall(platform: InstallPlatform): boolean {
    return platform !== 'firefox-desktop' && platform !== 'other'
}

/**
 * The steps to install from the browser's own menus, one sentence each, for a platform where the
 * page cannot open the dialog itself (or the browser has not offered it yet). Empty where the
 * browser cannot install.
 */
export function installSteps(platform: InstallPlatform): string[] {
    switch (platform) {
        case 'chromium-desktop':
        case 'chromeos':
            return [
                'Select the install icon at the right end of the address bar.',
                'If it is not there, open the browser menu and look for Install EtherPK. In Chrome it is under Cast, save, and share.',
            ]
        case 'chromium-android':
            return ['Open the browser menu.', 'Choose Install app or Add to Home screen, then Install.']
        case 'ios':
            return [
                'Tap Share. In Safari it is in the toolbar, or under the More button.',
                'Choose Add to Home Screen. If it is not in the list, scroll down or tap Edit Actions.',
                'Leave Open as Web App switched on, then tap Add.',
            ]
        case 'safari-mac':
            return ['Open the File menu and choose Add to Dock.']
        case 'firefox-windows':
            return ['Select Add tab to taskbar at the right end of the address bar.']
        case 'firefox-android':
            return ['Open the browser menu.', 'Choose Add to Home screen, then Add.']
        case 'firefox-desktop':
        case 'other':
            return []
    }
}

/** The platform of the browser this code runs in, or `other` outside a browser. */
export function currentInstallPlatform(): InstallPlatform {
    if (typeof navigator === 'undefined') return 'other'
    return installPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)
}
