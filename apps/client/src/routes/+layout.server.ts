import type { LayoutServerLoad } from './$types'
import * as privateEnv from '$app/env/private'
import * as publicEnv from '$app/env/public'
import { buildAccountUrl, buildBillingUrl, buildHomeUrl, buildPricingUrl, buildSyncPlusSignUpUrl, buildSyncServerUrl } from '@appsoftwareltd/etherpk-shared'
import { parseOptionalManagedClientAuthConfig } from '#lib/server/auth/config.js'
import { configuredSyncServerUrl } from '#lib/sync/sync-deployment.js'
import { clientLegalLinks } from '#lib/server/legal.js'
import { readSyncPlusOffer } from '#lib/server/sync-plus-offer.js'

export const load: LayoutServerLoad = async ({ locals }) => {
    const managedAuthConfig = parseOptionalManagedClientAuthConfig(privateEnv)
    const serverPortalOrigin = configuredSyncServerUrl(publicEnv)
    const corporateHomeUrl = managedAuthConfig ? buildHomeUrl(managedAuthConfig.issuer) : null
    return {
        themePreference: locals.themePreference,
        resolvedTheme: locals.resolvedTheme,
        serverPortalUrl: serverPortalOrigin ? buildSyncServerUrl(serverPortalOrigin) : null,
        managedSessionAvailable: locals.managedSessionAvailable,
        signedInElsewhereCheck: locals.signedInElsewhereCheck ?? null,
        corporateAccountUrl: managedAuthConfig ? buildAccountUrl(managedAuthConfig.issuer) : null,
        corporateBillingUrl: managedAuthConfig ? buildBillingUrl(managedAuthConfig.issuer) : null,
        corporatePricingUrl: managedAuthConfig ? buildPricingUrl(managedAuthConfig.issuer) : null,
        // Registration that goes on to Billing: where the Graphs page sends someone new who wants a synced graph.
        corporateSyncPlusSignUpUrl: managedAuthConfig ? buildSyncPlusSignUpUrl(managedAuthConfig.issuer) : null,
        // The price and trial the account site offers Sync+ on, for the Graphs page to state; null
        // on a standalone deployment, and when the account site did not answer in time.
        syncPlusOffer: managedAuthConfig ? await readSyncPlusOffer(managedAuthConfig.issuer) : null,
        // The landing page's canonical URL: Corporate's copy, when there is a Corporate.
        corporateHomeUrl,
        // Where the EtherPK logo leads: Corporate's home on the managed service, the deployment's
        // one public home, and this Client's own on a standalone deployment, which has no Corporate.
        deploymentHomeUrl: corporateHomeUrl ?? '/home',
        // EtherPK runs this deployment: its footer names the operating company.
        managedService: managedAuthConfig !== null,
        legalLinks: clientLegalLinks(privateEnv, publicEnv),
    }
}
