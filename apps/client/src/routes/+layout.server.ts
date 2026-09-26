import type { LayoutServerLoad } from './$types'
import { env as privateEnv } from '$env/dynamic/private'
import { env as publicEnv } from '$env/dynamic/public'
import { buildAccountUrl, buildBillingUrl, buildHomeUrl, buildPricingUrl, buildSyncServerUrl } from '@appsoftwareltd/etherpk-shared'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { configuredSyncServerUrl } from '$lib/sync/sync-deployment'
import { clientLegalLinks } from '$lib/server/legal'

export const load: LayoutServerLoad = ({ locals }) => {
    const managedAuthConfig = parseOptionalManagedClientAuthConfig(privateEnv)
    const serverPortalOrigin = configuredSyncServerUrl(publicEnv)
    return {
        themePreference: locals.themePreference,
        resolvedTheme: locals.resolvedTheme,
        serverPortalUrl: serverPortalOrigin ? buildSyncServerUrl(serverPortalOrigin) : null,
        managedSessionAvailable: locals.managedSessionAvailable,
        corporateAccountUrl: managedAuthConfig ? buildAccountUrl(managedAuthConfig.issuer) : null,
        corporateBillingUrl: managedAuthConfig ? buildBillingUrl(managedAuthConfig.issuer) : null,
        corporatePricingUrl: managedAuthConfig ? buildPricingUrl(managedAuthConfig.issuer) : null,
        // The landing page's canonical URL: Corporate's copy, when there is a Corporate.
        corporateHomeUrl: managedAuthConfig ? buildHomeUrl(managedAuthConfig.issuer) : null,
        // EtherPK runs this deployment: its footer names the operating company.
        managedService: managedAuthConfig !== null,
        legalLinks: clientLegalLinks(privateEnv, publicEnv),
    }
}
