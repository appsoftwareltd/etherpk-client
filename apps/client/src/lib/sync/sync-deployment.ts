import { parseNavigationOrigin } from '@appsoftwareltd/etherpk-shared'

export type PublicSyncEnvironment = Record<string, string | undefined>

/** Whether this Client deployment offers the managed OAuth preset. */
export function isManagedSyncConfigured(environment: PublicSyncEnvironment): boolean {
    return Boolean(environment.PUBLIC_MANAGED_SYNC_URL?.trim())
}

/** Optional deployment default for the PAT-authenticated custom Server form. */
export function defaultCustomSyncUrl(environment: PublicSyncEnvironment): string {
    return environment.PUBLIC_CUSTOM_SYNC_URL?.trim().replace(/\/$/, '') ?? ''
}

/**
 * Resolve the Server portal paired with this Client deployment. Managed is deliberately preferred
 * when both presets exist because it is the primary product profile; standalone deployments leave
 * the managed preset blank and therefore use their configured custom Server.
 */
export function configuredSyncServerUrl(environment: PublicSyncEnvironment): string | null {
    const configured = environment.PUBLIC_MANAGED_SYNC_URL?.trim()
        || environment.PUBLIC_CUSTOM_SYNC_URL?.trim()
    if (!configured) return null
    return parseNavigationOrigin(configured, 'configured Sync Server URL')
}
