import { describe, expect, it } from 'vitest'
import {
    ENTITLEMENT_AUDIENCE,
    IDENTITY_STATEMENT_AUDIENCE,
    identityStatementSchema,
    isEntitlementSubject,
    MANAGED_SYNC_AUDIENCE,
    MANAGED_SYNC_SCOPE,
    managedUsageSchema,
    serviceEntitlementSchema,
    syncAccountSummarySchema,
    syncServerCapabilitiesSchema,
} from './managed-service'

describe('managed service contracts', () => {
    it('keeps managed identity constants exact and provider-neutral', () => {
        expect(MANAGED_SYNC_AUDIENCE).toBe('urn:etherpk:managed-sync')
        expect(MANAGED_SYNC_SCOPE).toBe('sync')
        expect(ENTITLEMENT_AUDIENCE).toBe('urn:etherpk:sync-entitlements')
    })

    it('accepts a standalone capability document without exposing private configuration', () => {
        expect(syncServerCapabilitiesSchema.parse({
            syncApiVersion: 1,
            auth: {
                mode: 'standalone',
                portalUrl: 'https://sync.example.com/account/tokens',
                pat: true,
            },
        })).toMatchObject({ auth: { mode: 'standalone', pat: true } })

        expect(() => syncServerCapabilitiesSchema.parse({
            syncApiVersion: 1,
            auth: { mode: 'standalone', portalUrl: 'https://sync.example.com', pat: true },
            clientSecret: 'must-not-leak',
        })).toThrow()
    })

    it('allows plain HTTP only for loopback hosts, including names beneath localhost', () => {
        const standalone = (portalUrl: string) => syncServerCapabilitiesSchema.parse({
            syncApiVersion: 1,
            auth: { mode: 'standalone', portalUrl, pat: true },
        })
        expect(standalone('http://localhost:5173/account/tokens')).toBeTruthy()
        expect(standalone('http://sa.staging.sync.etherpk.localhost:8081/account/tokens')).toBeTruthy()
        expect(() => standalone('http://sync.example.com/account/tokens')).toThrow('HTTPS')
    })

    it('rejects negative limits and non-increasing entitlement revisions', () => {
        const valid = {
            eventId: '019c9e42-0b89-7000-8000-000000000001',
            issuer: 'https://www.etherpk.com',
            audience: ENTITLEMENT_AUDIENCE,
            subject: 'billing-account:019c9e42-0b89-7000-8000-000000000002',
            service: 'managed-sync',
            revision: 1,
            status: 'active',
            plan: 'free',
            limits: {
                ownedGraphs: 3,
                ownedStorageBytes: 262_144_000,
                playersPerGraph: 3,
                assetBytes: 26_214_400,
                assetChunks: 512,
            },
            effectiveAt: '2026-08-11T12:00:00.000Z',
            expiresAt: '2026-09-11T12:00:00.000Z',
        }

        expect(serviceEntitlementSchema.parse(valid)).toEqual(valid)
        expect(() => serviceEntitlementSchema.parse({ ...valid, revision: 0 })).toThrow()
        expect(() => serviceEntitlementSchema.parse({
            ...valid,
            limits: { ...valid.limits, ownedStorageBytes: -1 },
        })).toThrow()

        // A failed card is carried as a flag, so a read-only statement can say why.
        // It is optional: statements without it are every statement issued before it existed.
        const overdue = { ...valid, status: 'grace', paymentOverdue: true }
        expect(serviceEntitlementSchema.parse(overdue)).toEqual(overdue)
        expect(() => serviceEntitlementSchema.parse({ ...valid, paymentOverdue: 'yes' })).toThrow()
    })

    it('accepts only aggregate, content-free managed usage', () => {
        const usage = {
            subject: 'billing-account:019c9e42-0b89-7000-8000-000000000002',
            service: 'managed-sync',
            measuredAt: '2026-08-11T12:00:00.000Z',
            ownedGraphs: 3,
            ownedStorageBytes: 123_456,
        }

        expect(managedUsageSchema.parse(usage)).toEqual(usage)
        expect(() => managedUsageSchema.parse({ ...usage, graphIds: ['private-id'] })).toThrow()
        expect(() => managedUsageSchema.parse({ ...usage, ownedStorageBytes: -1 })).toThrow()
    })

    it('defines the authenticated Sync account summary without exposing provider subjects', () => {
        const summary = {
            principal: {
                id: '019c9e42-0b89-7000-8000-000000000001',
                email: 'person@example.com',
                name: 'Person One',
                image: null,
            },
            authentication: {
                mode: 'managed',
                method: 'oidc',
            },
            entitlement: {
                plan: 'personal',
                status: 'active',
                limits: {
                    ownedGraphs: 10,
                    ownedStorageBytes: 1_000_000,
                    playersPerGraph: 5,
                    assetBytes: 100_000,
                    assetChunks: 128,
                },
                usage: {
                    ownedGraphs: 2,
                    ownedStorageBytes: 12_345,
                },
            },
        }

        expect(syncAccountSummarySchema.parse(summary)).toEqual(summary)
        expect(() => syncAccountSummarySchema.parse({
            ...summary,
            providerSubject: 'corporate-user-1',
        })).toThrow()

        const overdue = { ...summary, entitlement: { ...summary.entitlement, status: 'read_only', paymentOverdue: true } }
        expect(syncAccountSummarySchema.parse(overdue)).toEqual(overdue)
    })

    it('supports every browser authentication route while keeping mode and method distinct', () => {
        const base = {
            principal: {
                id: '019c9e42-0b89-7000-8000-000000000001',
                email: null,
                name: null,
                image: null,
            },
            entitlement: {
                plan: 'unlimited',
                status: 'active',
                limits: {
                    ownedGraphs: 1,
                    ownedStorageBytes: 1,
                    playersPerGraph: 1,
                    assetBytes: 1,
                    assetChunks: 1,
                },
                usage: { ownedGraphs: 0, ownedStorageBytes: 0 },
            },
        }

        expect(syncAccountSummarySchema.parse({
            ...base,
            authentication: { mode: 'standalone', method: 'session' },
        }).authentication.method).toBe('session')
        expect(syncAccountSummarySchema.parse({
            ...base,
            authentication: { mode: 'standalone', method: 'pat' },
        }).authentication.method).toBe('pat')
        expect(() => syncAccountSummarySchema.parse({
            ...base,
            authentication: { mode: 'managed', method: 'session' },
        })).toThrow()
    })
})

describe('entitlement subject pattern', () => {
    it('accepts a v4 billing account id, which is what is minted today', () => {
        expect(isEntitlementSubject('billing-account:2f1a6f0e-2c3d-4a5b-8c9d-0e1f2a3b4c5d')).toBe(true)
    })

    it('accepts a uuidv7, which the old patterns would have silently rejected', () => {
        // better-auth already mints uuidv7 ids. The Stripe metadata fallback used a v1-to-v5
        // pattern, so a billing account id that ever moved to v7 would have answered 409
        // "Unknown Stripe customer" for a legitimate subscription.
        expect(isEntitlementSubject('billing-account:01a0541b-708b-7fb2-8d80-c8feef333992')).toBe(true)
    })

    it('rejects anything that is not billing-account: followed by a UUID', () => {
        expect(isEntitlementSubject('user@example.com')).toBe(false)
        expect(isEntitlementSubject('billing-account:not-a-uuid')).toBe(false)
        expect(isEntitlementSubject('billing-account:')).toBe(false)
        // 36 characters of hex and dashes, which one of the old patterns accepted.
        expect(isEntitlementSubject('billing-account:------------------------------------')).toBe(false)
        expect(isEntitlementSubject(undefined)).toBe(false)
        expect(isEntitlementSubject(42)).toBe(false)
    })
})

describe('identity statement (ADR 0101)', () => {
    const statement = {
        eventId: '00000000-0000-4000-8000-000000000001',
        issuer: 'https://www.etherpk.com',
        audience: IDENTITY_STATEMENT_AUDIENCE,
        subject: '0192f8a4-0000-7000-8000-000000000001',
        revision: 3,
        disabled: false,
        deleted: false,
        credentialsRevokedAt: '2026-09-24T10:00:00.000Z',
        issuedAt: '2026-09-24T10:00:00.000Z',
    }

    it('accepts a whole-state statement with or without a credential cut-off', () => {
        expect(identityStatementSchema.parse(statement)).toEqual(statement)
        expect(identityStatementSchema.parse({ ...statement, credentialsRevokedAt: null }).credentialsRevokedAt).toBeNull()
    })

    it('refuses an Entitlement audience, a zero revision and unknown fields', () => {
        expect(identityStatementSchema.safeParse({ ...statement, audience: ENTITLEMENT_AUDIENCE }).success).toBe(false)
        expect(identityStatementSchema.safeParse({ ...statement, revision: 0 }).success).toBe(false)
        expect(identityStatementSchema.safeParse({ ...statement, banned: true }).success).toBe(false)
    })
})
