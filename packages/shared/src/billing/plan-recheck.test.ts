import { describe, expect, it } from 'vitest'
import {
    PLAN_PENDING_PATIENCE_MS,
    PLAN_RECHECK_INTERVAL_MS,
    displayedPlanNotice,
    nextPlanRecheckMs,
    planRecheckDelayMs,
} from './plan-recheck'

describe('planRecheckDelayMs', () => {
    it('checks soon after a pending plan first shows, then backs off to a steady pace', () => {
        const delays = Array.from({ length: 9 }, (_, attempt) => planRecheckDelayMs(attempt))
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 30_000, 30_000])
        expect(planRecheckDelayMs(100)).toBe(PLAN_RECHECK_INTERVAL_MS)
    })

    it('spends exactly the patience on the quick checks, so the check that ends it is a real one', () => {
        // The last quick check lands as the patience runs out: a page that is still pending
        // then shows the unconfirmed notice on an answer it has just had, not on a stale one.
        let elapsed = 0
        let attempt = 0
        while (planRecheckDelayMs(attempt) < PLAN_RECHECK_INTERVAL_MS) elapsed += planRecheckDelayMs(attempt++)
        expect(elapsed).toBe(PLAN_PENDING_PATIENCE_MS)
    })

    it('treats an attempt number it cannot use as the first', () => {
        expect(planRecheckDelayMs(-1)).toBe(1_000)
        expect(planRecheckDelayMs(1.5)).toBe(2_000)
    })
})

describe('nextPlanRecheckMs', () => {
    it('paces a pending plan by the backoff and an unconfirmed one steadily', () => {
        expect(nextPlanRecheckMs('pending', 0)).toBe(1_000)
        expect(nextPlanRecheckMs('pending', 7)).toBe(PLAN_RECHECK_INTERVAL_MS)
        expect(nextPlanRecheckMs('unconfirmed', 0)).toBe(PLAN_RECHECK_INTERVAL_MS)
    })

    it('stops once the plan is known, whatever it says', () => {
        for (const notice of ['payment_failed', 'payment_overdue', 'ended', 'upsell', null] as const) {
            expect(nextPlanRecheckMs(notice, 0)).toBeNull()
        }
    })
})

describe('displayedPlanNotice', () => {
    const since = 1_000_000

    it('shows a pending plan as pending until the patience runs out', () => {
        expect(displayedPlanNotice('pending', since, since)).toBe('pending')
        expect(displayedPlanNotice('pending', since, since + PLAN_PENDING_PATIENCE_MS - 1)).toBe('pending')
    })

    it('says the plan cannot be confirmed once the patience has run out', () => {
        expect(displayedPlanNotice('pending', since, since + PLAN_PENDING_PATIENCE_MS)).toBe('unconfirmed')
    })

    it('shows pending while the page has not started timing it', () => {
        // The server-rendered page, before the browser has seen the plan pending.
        expect(displayedPlanNotice('pending', null, since + 10 * PLAN_PENDING_PATIENCE_MS)).toBe('pending')
    })

    it('passes every other notice through', () => {
        for (const notice of ['payment_failed', 'payment_overdue', 'ended', 'unconfirmed', 'upsell', null] as const) {
            expect(displayedPlanNotice(notice, since, since + 10 * PLAN_PENDING_PATIENCE_MS)).toBe(notice)
        }
    })
})
