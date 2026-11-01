import type { LayoutServerLoad } from './$types'
import * as privateEnv from '$app/env/private'
import * as publicEnv from '$app/env/public'
import { buildAccountUrl, buildBillingUrl, buildHomeUrl, buildPricingUrl, buildSyncServerUrl } from '@appsoftwareltd/etherpk-shared'
import { parseOptionalManagedClientAuthConfig } from '#lib/server/auth/config.js'
import { configuredSyncServerUrl } from '#lib/sync/sync-deployment.js'
import { clientLegalLinks } from '#lib/server/legal.js'

export const load: LayoutServerLoad = ({ locals }) => {
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
