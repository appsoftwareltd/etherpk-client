/**
 * The root layout's data that a Native App's page has to find out for itself.
 *
 * Everything else the layout carries says which services the app was built for, and is in the page
 * (`installed-build.ts`). Empty in a browser, where the server has answered.
 */
import { buildSyncServerUrl } from '@appsoftwareltd/etherpk-shared'

import { showNotice } from '#lib/activity/notices.js'

import { isNativeApp } from './bridge.js'
import { GRAPHS_PATH } from './installed-pages.js'
import { nativeSessionAvailable } from './session.js'
import { shellSyncServer } from './sync-server.js'

export interface InstalledLayoutData {
    managedSessionAvailable: boolean
    /** Asks the account site from a page with its cookies, which a Native App does not share. */
    signedInElsewhereCheck: null
    /** Where the logo leads: a Native App holds none of the public pages. */
    deploymentHomeUrl: string
}

/**
 * In place of the account site the page was built with, where the person pointed the app at a Sync
 * Server of their own (ADR 0214): that server's pages, and none of the account site's, whose
 * account, billing and Sync+ belong to Managed Sync, which the app then does not offer.
 */
interface OwnServerLayoutData {
    managedService: false
    serverPortalUrl: string
    corporateAccountUrl: null
    corporateBillingUrl: null
    corporatePricingUrl: null
    corporateSyncPlusSignUpUrl: null
    corporateHomeUrl: null
    syncPlusOffer: null
}

export async function installedLayoutData(): Promise<InstalledLayoutData | (InstalledLayoutData & OwnServerLayoutData) | Record<never, never>> {
    if (!isNativeApp()) return {}
    const own = shellSyncServer()
    const data: InstalledLayoutData = {
        // The shell keeps no sign-in to Managed Sync while another server takes its place.
        managedSessionAvailable: own === null ? await signedIn() : false,
        signedInElsewhereCheck: null,
        deploymentHomeUrl: GRAPHS_PATH,
    }
    if (own === null) return data
    return {
        ...data,
        managedService: false,
        serverPortalUrl: buildSyncServerUrl(own),
        corporateAccountUrl: null,
        corporateBillingUrl: null,
        corporatePricingUrl: null,
        corporateSyncPlusSignUpUrl: null,
        corporateHomeUrl: null,
        syncPlusOffer: null,
    }
}

/**
 * Whether the shell holds a sign-in. A shell that cannot say (its key store refused) opens the app
 * signed out: the root load throwing would leave every page on the error page, graphs on disk too.
 */
async function signedIn(): Promise<boolean> {
    try {
        return await nativeSessionAvailable()
    } catch (error) {
        console.error('The app could not read whether someone is signed in.', error)
        showNotice({
            id: 'native-sign-in-unread',
            tone: 'error',
            text: 'EtherPK could not read whether you are signed in, so it opened signed out. Sign in again to use your synced graphs.',
        })
        return false
    }
}
