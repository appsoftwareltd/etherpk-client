/**
 * The install state as Svelte reads it, and the one action every Install entry runs.
 *
 * `app-install.ts` owns the state and the browser's single-use install offer, framework-free.
 * This module makes that state reactive for components and holds the Install dialog's
 * visibility, so the account menu, the phone drawer, the Command Menu, Graph Settings and the
 * offers all open the same dialog, mounted once in the root layout.
 */

import { createSubscriber } from 'svelte/reactivity'

import { type AppInstallState, appInstallState, promptInstall, subscribeAppInstall } from '$lib/storage/app-install'
import { currentInstallPlatform } from '$lib/storage/install-platform'

const subscribe = createSubscriber((update) => subscribeAppInstall(() => update()))

/** The current install state; reading it inside a template or `$derived` re-runs on change. */
export function installState(): AppInstallState {
    subscribe()
    return appInstallState()
}

/** The platform's install route, read once: the user agent does not change under a page. */
export const installPlatform = currentInstallPlatform()

class InstallDialog {
    open = $state(false)
    /**
     * The browser's dialog was dismissed in this page. Its offer is single-use, so the Install
     * dialog then says how to install from the browser's menu instead.
     */
    dismissed = $state(false)

    show(): void {
        this.open = true
    }

    close(): void {
        this.open = false
    }
}

export const installDialog = new InstallDialog()

/**
 * What every Install entry does. Where the browser holds its install offer (Chromium), its own
 * dialog opens at once. Everywhere else the Install dialog opens with the steps for the
 * platform, because only the browser's menus can install there.
 */
export async function startInstall(): Promise<void> {
    if (appInstallState().promptAvailable) {
        // A dismissal is the person's answer, so nothing else opens after it.
        installDialog.dismissed = (await promptInstall()) === 'dismissed'
        return
    }
    installDialog.show()
}
