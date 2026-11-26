import { afterEach, describe, expect, it } from 'vitest'
import {
    configuredSyncServerUrl,
    defaultCustomSyncUrl,
    isManagedSyncConfigured,
    managedSyncOrigin,
    useShellSyncServer,
} from './sync-deployment'

const managedBuild = { PUBLIC_MANAGED_SYNC_URL: 'https://managed.example.test', PUBLIC_CUSTOM_SYNC_URL: undefined }

describe('the Sync Server a deployment offers', () => {
    afterEach(() => useShellSyncServer(null))

    it('is the managed one the build names', () => {
        expect(isManagedSyncConfigured(managedBuild)).toBe(true)
        expect(managedSyncOrigin(managedBuild)).toBe('https://managed.example.test')
        expect(defaultCustomSyncUrl(managedBuild)).toBe('')
        expect(configuredSyncServerUrl(managedBuild)).toBe('https://managed.example.test')
    })

    it('is the one a Native App was pointed at in place of the managed one, which is then not offered', () => {
        useShellSyncServer('https://own.example.test')
        expect(isManagedSyncConfigured(managedBuild)).toBe(false)
        expect(managedSyncOrigin(managedBuild)).toBe(null)
        expect(defaultCustomSyncUrl(managedBuild)).toBe('https://own.example.test')
        expect(configuredSyncServerUrl(managedBuild)).toBe('https://own.example.test')
    })

    it('goes back to the build\'s when the shell names none', () => {
        useShellSyncServer('https://own.example.test')
        useShellSyncServer(null)
        expect(managedSyncOrigin(managedBuild)).toBe('https://managed.example.test')
    })
})
