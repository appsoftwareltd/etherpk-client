import { describe, expect, it } from 'vitest'
import { parseManagedClientAuthConfig, parseOptionalManagedClientAuthConfig } from './config'

const environment = {
    CLIENT_PUBLIC_URL: 'https://app.example.com',
    CORPORATE_ISSUER: 'https://accounts.example.com',
    MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
    MANAGED_SYNC_URL: 'https://sync.example.com',
    CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
}

describe('parseManagedClientAuthConfig', () => {
    it('builds exact OAuth and managed service endpoints', () => {
        expect(parseManagedClientAuthConfig(environment)).toEqual({
            clientPublicUrl: 'https://app.example.com',
            callbackUrl: 'https://app.example.com/auth/callback',
            issuer: 'https://accounts.example.com',
            clientId: 'etherpk-client',
            managedSyncUrl: 'https://sync.example.com',
            postLogoutUrl: 'https://sync.example.com/auth/portal/logout/managed?finish=client',
            sessionSecret: environment.CLIENT_SESSION_SECRET,
            scopes: ['openid', 'profile', 'email', 'offline_access', 'sync'],
        })
    })

    it('rejects missing, non-canonical, or weak security inputs', () => {
        expect(() => parseManagedClientAuthConfig({ ...environment, CLIENT_PUBLIC_URL: '' }))
            .toThrow('CLIENT_PUBLIC_URL is required')
        expect(() => parseManagedClientAuthConfig({ ...environment, CORPORATE_ISSUER: 'https://accounts.example.com/path' }))
            .toThrow('CORPORATE_ISSUER must be an origin')
        expect(() => parseManagedClientAuthConfig({ ...environment, CLIENT_SESSION_SECRET: 'too-short' }))
            .toThrow('CLIENT_SESSION_SECRET must contain at least 32 bytes')
    })

    it('accepts reserved localhost subdomains for isolated local apps', () => {
        expect(parseManagedClientAuthConfig({
            ...environment,
            CLIENT_PUBLIC_URL: 'http://client.localhost:5174',
            CORPORATE_ISSUER: 'http://accounts.localhost:5175',
            MANAGED_SYNC_URL: 'http://sync.localhost:5173',
        })).toMatchObject({
            clientPublicUrl: 'http://client.localhost:5174',
            issuer: 'http://accounts.localhost:5175',
            managedSyncUrl: 'http://sync.localhost:5173',
        })
    })

    it('allows a deployment to disable the managed OAuth preset completely', () => {
        expect(parseOptionalManagedClientAuthConfig({
            CLIENT_PUBLIC_URL: 'https://notes.example.com',
            CORPORATE_ISSUER: '',
            MANAGED_OAUTH_CLIENT_ID: '',
            MANAGED_SYNC_URL: '',
            CLIENT_SESSION_SECRET: '',
        })).toBeNull()
    })

    it('rejects a partially configured managed OAuth preset', () => {
        expect(() => parseOptionalManagedClientAuthConfig({
            ...environment,
            CORPORATE_ISSUER: '',
        })).toThrow('Managed Client OAuth configuration must be either complete or disabled')
    })
})
