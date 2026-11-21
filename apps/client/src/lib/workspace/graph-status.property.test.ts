import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { SyncIndicator, SyncIndicatorState } from '#lib/sync/sync-indicator.js'
import { calloutToShow, graphStatus, type StatusTone } from './graph-status'
import type { MirrorIndicatorView } from './mirror-indicator'

/**
 * The combined status dot, over every pairing of a sync state and a mirror state.
 *
 * Fixed seed and run count, so a failure reproduces. `STATUS_FUZZ_RUNS` and `STATUS_FUZZ_SEED`
 * change them for a longer local run, or to replay a seed a failure printed.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.STATUS_FUZZ_SEED
    return { numRuns: Number(process.env.STATUS_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261120 : Number(seed) }
}

const SYNC_STATES: SyncIndicatorState[] = ['synced', 'sending', 'connecting', 'reconnecting', 'turned-away', 'offline', 'refused', 'waiting-for-key', 'ended']
const RANK: Record<StatusTone, number> = { ok: 0, idle: 1, busy: 2, stopped: 3 }

const syncArb: fc.Arbitrary<SyncIndicator | null> = fc.option(
    fc.record({ state: fc.constantFrom(...SYNC_STATES), label: fc.string(), detail: fc.string(), unsent: fc.nat(50) }),
    { nil: null },
)
const mirrorArb: fc.Arbitrary<MirrorIndicatorView> = fc.oneof(
    fc.constant<MirrorIndicatorView>({ state: 'hidden' }),
    fc.record({ state: fc.constantFrom('writing', 'current', 'paused', 'waiting'), title: fc.string() }),
)

describe('graphStatus, over every pairing', () => {
    it('is green only when sync is synced and the mirror, where there is one, is working', () => {
        fc.assert(
            fc.property(syncArb, mirrorArb, (sync, mirror) => {
                const status = graphStatus(true, sync, mirror)
                if (!status.shown) throw new Error('a synced graph always has a status')
                const working = sync?.state === 'synced' && ['hidden', 'current', 'waiting'].includes(mirror.state)
                expect(status.tone === 'ok').toBe(working)
                // The dot is never calmer than either part.
                for (const part of [status.sync, status.mirror]) if (part) expect(RANK[status.tone]).toBeGreaterThanOrEqual(RANK[part.tone])
                // A notice is about the sync state it names, and always says the changes are kept.
                if (status.callout) {
                    expect(status.callout.id).toBe(sync?.state)
                    expect(status.callout.text).toContain('Your changes are kept on this device and sync')
                }
            }),
            fuzz(500),
        )
    })

    it('a closed notice never shows again while its state lasts, and always shows after the state came back', () => {
        fc.assert(
            fc.property(fc.array(fc.record({ state: fc.constantFrom(...SYNC_STATES), close: fc.boolean() }), { maxLength: 30 }), (steps) => {
                let dismissed: string | null = null
                let previous: SyncIndicatorState | null = null
                let closedInThisSpell = false
                for (const step of steps) {
                    const status = graphStatus(true, { state: step.state, label: '', detail: '', unsent: 0 }, { state: 'hidden' })
                    if (!status.shown) throw new Error('a synced graph always has a status')
                    if (step.state !== previous) closedInThisSpell = false
                    const shown = calloutToShow(status.callout, dismissed)
                    dismissed = shown.nextDismissed
                    expect(shown.show !== null).toBe(status.callout !== null && !closedInThisSpell)
                    if (shown.show && step.close) {
                        dismissed = shown.show.id
                        closedInThisSpell = true
                    }
                    previous = step.state
                }
            }),
            fuzz(500),
        )
    })
})
