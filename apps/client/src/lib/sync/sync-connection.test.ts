import { describe, expect, it } from 'vitest'
import {
    configuredSyncServerUrl,
    defaultCustomSyncUrl,
    isManagedSyncConfigured,
} from './sync-deployment'

describe('deployment Sync presets', () => {
    it('disables Managed Sync when its public URL is blank', () => {
        expect(isManagedSyncConfigured({ PUBLIC_MANAGED_SYNC_URL: '' })).toBe(false)
        expect(isManagedSyncConfigured({})).toBe(false)
    })

    it('enables Managed Sync only when its public URL is present', () => {
        expect(isManagedSyncConfigured({
            PUBLIC_MANAGED_SYNC_URL: 'https://sync.example.com',
        })).toBe(true)
    })

    it('provides an optional standalone custom Server default', () => {
        expect(defaultCustomSyncUrl({
            PUBLIC_CUSTOM_SYNC_URL: ' https://standalone-sync.example.com/ ',
        })).toBe('https://standalone-sync.example.com')
        expect(defaultCustomSyncUrl({})).toBe('')
    })

    it('uses the managed Server for navigation when the managed preset is enabled', () => {
        expect(configuredSyncServerUrl({
            PUBLIC_MANAGED_SYNC_URL: ' https://sync.example.com/ ',
            PUBLIC_CUSTOM_SYNC_URL: 'https://private.example.com',
        })).toBe('https://sync.example.com')
    })

    it('uses the custom Server for navigation in a standalone deployment', () => {
        expect(configuredSyncServerUrl({
            PUBLIC_MANAGED_SYNC_URL: '',
            PUBLIC_CUSTOM_SYNC_URL: ' https://sync.example.org/ ',
        })).toBe('https://sync.example.org')
        expect(configuredSyncServerUrl({})).toBeNull()
    })
})
