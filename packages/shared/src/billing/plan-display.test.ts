import { describe, expect, it } from 'vitest'

import { UNLIMITED_ALLOWANCE, entitlementStatusLabel, formatLimit, formatUsage, isServerAllowance, planLabel } from './plan-display'

const formatDate = (iso: string) => iso.slice(0, 10)

describe('plan display', () => {
    it('names each plan, and says so when the plan cannot be read', () => {
        expect(planLabel('sync_plus')).toBe('Sync+')
        expect(planLabel('free')).toBe('Free')
        expect(planLabel('unlimited')).toBe('Unlimited')
        expect(planLabel('fixed')).toBe('Fixed limits')
        expect(planLabel('remote-unavailable')).toBe('Plan status unavailable')
        expect(planLabel('team')).toBe('team')
    })

    it("tells a Sync Server's own allowance from a plan someone holds", () => {
        expect(isServerAllowance('unlimited')).toBe(true)
        expect(isServerAllowance('fixed')).toBe(true)
        expect(isServerAllowance('sync_plus')).toBe(false)
        expect(isServerAllowance('free')).toBe(false)
        expect(isServerAllowance('remote-unavailable')).toBe(false)
    })

    it('says a trial with its end date, and a payment problem as one', () => {
        expect(entitlementStatusLabel({ status: 'active', trialEndsAt: '2026-10-07T10:00:00.000Z' }, formatDate)).toBe(
            'Trial, ends 2026-10-07',
        )
        expect(entitlementStatusLabel({ status: 'active' }, formatDate)).toBe('Active')
        expect(entitlementStatusLabel({ status: 'grace', paymentOverdue: true }, formatDate)).toBe('Payment failed')
        expect(entitlementStatusLabel({ status: 'read_only', paymentOverdue: true }, formatDate)).toBe('Payment overdue')
        expect(entitlementStatusLabel({ status: 'read_only' }, formatDate)).toBe('Read-only')
        expect(entitlementStatusLabel({ status: 'suspended' }, formatDate)).toBe('Suspended')
        expect(entitlementStatusLabel({ status: 'identity_disabled' }, formatDate)).toBe('Account disabled')
    })

    it('ignores a trial date on a status that is not active', () => {
        expect(entitlementStatusLabel({ status: 'read_only', trialEndsAt: '2026-10-07T10:00:00.000Z' }, formatDate)).toBe(
            'Read-only',
        )
    })

    it('calls no limit Unlimited, whatever it measures', () => {
        expect(formatLimit(UNLIMITED_ALLOWANCE, 'bytes')).toBe('Unlimited')
        expect(formatLimit(UNLIMITED_ALLOWANCE, 'count')).toBe('Unlimited')
        expect(formatLimit(3, 'count')).toBe('3')
        expect(formatLimit(2500, 'count')).toBe('2,500')
        expect(formatLimit(1_048_576, 'bytes')).toBe('1 MiB')
        expect(formatLimit(0, 'bytes')).toBe('0 B')
    })

    it('writes usage against its limit, or alone where there is no limit', () => {
        expect(formatUsage(3, 25, 'count')).toBe('3 of 25')
        expect(formatUsage(3, UNLIMITED_ALLOWANCE, 'count')).toBe('3')
        expect(formatUsage(1536, 10 * 1024 ** 3, 'bytes')).toBe('1.5 KiB of 10 GiB')
        expect(formatUsage(1536, UNLIMITED_ALLOWANCE, 'bytes')).toBe('1.5 KiB')
    })
})
