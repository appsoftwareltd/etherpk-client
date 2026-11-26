import { parseNavigationOrigin } from '@appsoftwareltd/etherpk-shared'

import { shellSyncServerInUse } from './shell-sync-server'

export type PublicSyncEnvironment = Record<string, string | undefined>

// A Native App pointed at a Sync Server of the person's own (ADR 0214): that server is then the
// deployment's, as `PUBLIC_CUSTOM_SYNC_URL` would make it, and Managed Sync is not offered. Every
// reader of the deployment's servers goes through the functions below, so they are the one place
// the override is laid over the settings the page was built with.
export { useShellSyncServer } from './shell-sync-server'

/** Whether this Client deployment offers the managed OAuth preset. */
export function isManagedSyncConfigured(environment: PublicSyncEnvironment): boolean {
    if (shellSyncServerInUse() !== null) return false
    return Boolean(environment.PUBLIC_MANAGED_SYNC_URL?.trim())
}

/** The Managed Sync server's origin, when this deployment offers Managed Sync; null otherwise. */
export function managedSyncOrigin(environment: PublicSyncEnvironment): string | null {
    if (shellSyncServerInUse() !== null) return null
    const configured = environment.PUBLIC_MANAGED_SYNC_URL?.trim()
    if (!configured) return null
    try {
        return new URL(configured).origin
    } catch {
        return null
    }
}

/** Optional deployment default for the PAT-authenticated custom Server form. */
export function defaultCustomSyncUrl(environment: PublicSyncEnvironment): string {
    const shell = shellSyncServerInUse()
    if (shell !== null) return shell
    return environment.PUBLIC_CUSTOM_SYNC_URL?.trim().replace(/\/$/, '') ?? ''
}

/**
 * Resolve the Server portal paired with this Client deployment. Managed is deliberately preferred
 * when both presets exist because it is the primary product profile; standalone deployments leave
 * the managed preset blank and therefore use their configured custom Server.
 */
export function configuredSyncServerUrl(environment: PublicSyncEnvironment): string | null {
    const shell = shellSyncServerInUse()
    if (shell !== null) return shell
    const configured = environment.PUBLIC_MANAGED_SYNC_URL?.trim()
        || environment.PUBLIC_CUSTOM_SYNC_URL?.trim()
    if (!configured) return null
    return parseNavigationOrigin(configured, 'configured Sync Server URL')
}
