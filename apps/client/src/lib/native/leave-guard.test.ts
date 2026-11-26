import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { STILL_SAVING, guardLeaving, settleBeforeLeaving } from './leave-guard'

const held: (() => void)[] = []
const guard = (...args: Parameters<typeof guardLeaving>) => held.push(guardLeaving(...args))
afterEach(() => {
    held.splice(0).forEach((stop) => stop())
    vi.restoreAllMocks()
})

describe('settling before the window closes', () => {
    it('lets it close with nothing to settle', async () => {
        expect(await settleBeforeLeaving()).toEqual([])
    })

    it('waits for a save and lets it close once saved', async () => {
        let saved = false
        guard(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            saved = true
            return null
        })
        expect(await settleBeforeLeaving()).toEqual([])
        expect(saved).toBe(true)
    })

    it('names what would be lost, each thing once', async () => {
        guard(() => 'One edit is not saved.')
        guard(async () => 'One edit is not saved.')
        guard(() => 'An import is running.')
        guard(() => null)
        expect(await settleBeforeLeaving()).toEqual(['One edit is not saved.', 'An import is running.'])
    })

    it('does not wait for ever, and says it is still saving', async () => {
        guard(() => new Promise(() => {}))
        expect(await settleBeforeLeaving(10)).toEqual([STILL_SAVING])
    })

    it('asks the person when a guard fails, since not knowing is not being safe', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        guard(() => {
            throw new Error('x')
        })
        const losses = await settleBeforeLeaving()
        expect(losses).toHaveLength(1)
        expect(losses[0]).not.toContain('x')
    })

    it('asks no guard that was taken away', async () => {
        guardLeaving(() => 'Gone.')()
        expect(await settleBeforeLeaving()).toEqual([])
    })

    it('lets it close exactly when every guard is content, whatever order they answer in', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(fc.record({ loses: fc.boolean(), delay: fc.integer({ min: 0, max: 4 }) }), { maxLength: 6 }), async (all) => {
                const stops = all.map(({ loses, delay }, at) =>
                    guardLeaving(async () => {
                        await new Promise((resolve) => setTimeout(resolve, delay))
                        return loses ? `Thing ${at}.` : null
                    }),
                )
                const losses = await settleBeforeLeaving()
                stops.forEach((stop) => stop())
                expect(losses).toEqual(all.flatMap(({ loses }, at) => (loses ? [`Thing ${at}.`] : [])))
            }),
            { seed: 20261125, numRuns: 60 },
        )
    })
})
