import { describe, expect, it } from 'vitest'
import { PAID_PLAN_IDS, isPaidPlan } from './plan-tiers'

describe('paid plans', () => {
    it('lists the tiers cheapest first', () => {
        expect(PAID_PLAN_IDS).toEqual(['sync_plus', 'sync_plus_pro'])
    })

    it('tells a tier of Sync+ from every other plan', () => {
        expect(isPaidPlan('sync_plus')).toBe(true)
        expect(isPaidPlan('sync_plus_pro')).toBe(true)
        for (const other of ['free', 'unlimited', 'fixed', 'remote-pending', 'remote-unavailable', 'pro', '']) {
            expect(isPaidPlan(other), other).toBe(false)
        }
    })
})
