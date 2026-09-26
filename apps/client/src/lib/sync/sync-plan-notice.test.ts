import { describe, expect, it } from 'vitest'
import type { SyncAccountSummary } from '@appsoftwareltd/etherpk-shared'
import { ownerCanWrite, syncPlanNotice } from './sync-plan-notice'

const syncPlusLimits = { ownedGraphs: 25, ownedStorageBytes: 50_000, playersPerGraph: 10, assetBytes: 100, assetChunks: 10 }
const freeLimits = { ownedGraphs: 0, ownedStorageBytes: 0, playersPerGraph: 0, assetBytes: 0, assetChunks: 0 }

function account(
    entitlement: Partial<SyncAccountSummary['entitlement']>,
    mode: 'managed' | 'standalone' = 'managed',
): SyncAccountSummary {
    return {
        principal: { id: '019c9e42-0b89-7000-8000-000000000001', email: null, name: null, image: null },
        authentication: mode === 'managed' ? { mode, method: 'oidc' } : { mode, method: 'session' },
        entitlement: {
            plan: 'sync_plus',
            status: 'active',
            limits: syncPlusLimits,
            usage: { ownedGraphs: 1, ownedStorageBytes: 10 },
            ...entitlement,
        },
    }
}

describe('syncPlanNotice', () => {
    it('shows a lapsed owner that Sync+ ended, not the Free trial pitch', () => {
        // What /me returns after a cancellation: the Free allowance, read-only, and a graph
        // still owned. The Free limits alone would make this look like a brand-new Free account.
        expect(syncPlanNotice(account({ plan: 'free', status: 'read_only', limits: freeLimits }))).toBe('ended')
    })

    it('tells a failed card apart from a cancellation', () => {
        expect(syncPlanNotice(account({ status: 'grace' }))).toBe('payment_failed')
        expect(syncPlanNotice(account({ status: 'grace', paymentOverdue: true }))).toBe('payment_failed')
        expect(syncPlanNotice(account({ status: 'read_only', paymentOverdue: true }))).toBe('payment_overdue')
    })

    it('does not call an unconfirmed plan an ended one', () => {
        // The Sync Server's own stand-in when its cached statement from EtherPK has expired.
        expect(syncPlanNotice(account({ plan: 'remote-unavailable', status: 'read_only', limits: freeLimits })))
            .toBe('unconfirmed')
    })

    it('offers Sync+ to a Free account that owns nothing', () => {
        expect(syncPlanNotice(account({ plan: 'free', limits: freeLimits, usage: { ownedGraphs: 0, ownedStorageBytes: 0 } })))
            .toBe('upsell')
    })

    it('says nothing on an active paid plan, or on a self-hosted Server', () => {
        expect(syncPlanNotice(account({}))).toBeNull()
        expect(syncPlanNotice(account({ status: 'read_only', limits: freeLimits }, 'standalone'))).toBeNull()
    })
})

describe('ownerCanWrite', () => {
    it('follows the Sync Server\'s write rule: active and grace write, everything else is refused', () => {
        expect(ownerCanWrite(account({ status: 'active' }))).toBe(true)
        expect(ownerCanWrite(account({ status: 'grace' }))).toBe(true)
        expect(ownerCanWrite(account({ status: 'read_only' }))).toBe(false)
        expect(ownerCanWrite(account({ status: 'suspended' }))).toBe(false)
        expect(ownerCanWrite(null)).toBe(true)
    })
})
