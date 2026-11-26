import type { LayoutServerLoad } from './$types'
import * as privateEnv from '$app/env/private'
import * as publicEnv from '$app/env/public'
import { buildAccountUrl, buildBillingUrl, buildHomeUrl, buildPricingUrl, buildSyncPlusSignUpUrl, buildSyncServerUrl } from '@appsoftwareltd/etherpk-shared'
import { parseOptionalManagedClientAuthConfig } from '#lib/server/auth/config.js'
import { GRAPHS_PATH } from '#lib/native/installed-pages.js'
import { configuredSyncServerUrl } from '#lib/sync/sync-deployment.js'
import { clientLegalLinks } from '#lib/server/legal.js'
import { readSyncPlusOffer } from '#lib/server/sync-plus-offer.js'

/** Pages of the account site, or nulls on a standalone deployment, which has none. */
function accountSiteLinks(issuer: string | null) {
    const page = (build: (issuer: string) => string) => (issuer ? build(issuer) : null)
    return {
        corporateAccountUrl: page(buildAccountUrl),
        corporateBillingUrl: page(buildBillingUrl),
        corporatePricingUrl: page(buildPricingUrl),
        // Registration that goes on to Billing: where the Graphs page sends someone new who wants a synced graph.
        corporateSyncPlusSignUpUrl: page(buildSyncPlusSignUpUrl),
        // The landing page's canonical URL: Corporate's copy, when there is a Corporate.
        corporateHomeUrl: page(buildHomeUrl),
        // EtherPK runs this deployment: its footer names the operating company.
        managedService: issuer !== null,
        legalLinks: clientLegalLinks(privateEnv, publicEnv, issuer),
    }
}

export const load: LayoutServerLoad = async ({ locals }) => {
    const managedAuthConfig = parseOptionalManagedClientAuthConfig(privateEnv)
    const serverPortalOrigin = configuredSyncServerUrl(publicEnv)
    // A Native App signs in through its shell, so its build knows the account site without the
    // settings a server needs to sign anyone in.
    const accountSite = accountSiteLinks(__INSTALLED_BUILD__ ? __INSTALLED_BUILD__.accountIssuer : (managedAuthConfig?.issuer ?? null))
    return {
        themePreference: locals.themePreference,
        resolvedTheme: locals.resolvedTheme,
        serverPortalUrl: serverPortalOrigin ? buildSyncServerUrl(serverPortalOrigin) : null,
        managedSessionAvailable: locals.managedSessionAvailable,
        signedInElsewhereCheck: locals.signedInElsewhereCheck ?? null,
        ...accountSite,
        // The price and trial the account site offers Sync+ on, for the Graphs page to state; null
        // on a standalone deployment, in a Native App, whose page outlives any price it was built
        // with, and when the account site did not answer in time.
        syncPlusOffer: managedAuthConfig ? await readSyncPlusOffer(managedAuthConfig.issuer) : null,
        // Where the EtherPK logo leads: Corporate's home on the managed service, the deployment's
        // one public home, and this Client's own on a standalone deployment, which has no Corporate.
        // A Native App has no public pages, so its logo leads to the Graphs page.
        deploymentHomeUrl: __INSTALLED_BUILD__ ? GRAPHS_PATH : (accountSite.corporateHomeUrl ?? '/home'),
    }
}
