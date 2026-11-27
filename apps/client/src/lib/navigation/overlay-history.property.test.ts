/**
 * Properties of a [[Dismissable Overlay]]'s history entry (`overlay-history.ts`), over any run of
 * overlays opening and closing, Visits, and Back and Forward pressed with the page's own history
 * writes still queued or settled:
 *
 * - **Back never moves the page from under an overlay Back closes.** Pressed while one is on top,
 *   it closes that overlay (unless it must be answered) and the Visit in front stays.
 * - **The entry in front matches the overlays**, once the writes have run: an overlay's entry
 *   while one Back closes is on top, and a Visit's otherwise. So Back after the last overlay has
 *   closed always walks the Visits, and Forward never lands on a left-behind entry.
 * - **The entry in front names the page shown**, once the writes have run, in any run where Back
 *   and Forward wait for them: an overlay closing never takes the page back to what was under it,
 *   whether the page then opened a Visit or replaced the one in front.
 *
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `NAVIGATION_FUZZ_SEED=<n>` (any integer) and optionally `NAVIGATION_FUZZ_RUNS=<n>`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { createDialogStack } from '@appsoftwareltd/etherpk-shared/ui'
import { createFakeHistory, type FakeOverlay } from './testing/fake-overlay-history'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.NAVIGATION_FUZZ_SEED
    return { numRuns: Number(process.env.NAVIGATION_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261127 : Number(seed) }
}

type Step =
    | { kind: 'open'; refuses: boolean; ownEntry: boolean }
    | { kind: 'close'; which: number }
    | { kind: 'visit' | 'replace'; name: string }
    | { kind: 'open-settings' | 'close-settings' }
    | { kind: 'back' | 'forward' | 'press-back' | 'press-forward' | 'settle' }

const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant('open' as const), refuses: fc.boolean(), ownEntry: fc.boolean() }),
    fc.record({ kind: fc.constant('close' as const), which: fc.nat(4) }),
    fc.record({ kind: fc.constantFrom('visit' as const, 'replace' as const), name: fc.constantFrom('Garden', 'Kitchen', 'Shed', 'Orchard') }),
    fc.constantFrom<Step>({ kind: 'open-settings' }, { kind: 'close-settings' }),
    fc.constantFrom<Step>({ kind: 'back' }, { kind: 'forward' }, { kind: 'press-back' }, { kind: 'press-forward' }, { kind: 'settle' }),
)

describe('the history entry of a Dismissable Overlay, over any run of steps', () => {
    it('never lets Back move the page from under an overlay, and leaves the entry in front matching the overlays', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
                const stack = createDialogStack()
                const world = createFakeHistory(stack)
                const open: { overlay: FakeOverlay; refuses: boolean }[] = []
                const backClosable = () => stack.top()?.dismiss !== undefined
                /** The overlay on top: the stack's order is the order of opening. */
                const onTop = () => open.filter((o) => o.overlay.isOpen()).at(-1)

                const stillOpen = () => open.filter((o) => o.overlay.isOpen())
                /** The page was replaced under an overlay Back closes: the known gap in overlay-history.test.ts. */
                let replacedUnder = false
                /**
                 * Back or Forward pressed over a write still queued can leave a Visit's entry behind
                 * the page, overlays or none, as in any browser, until the next Visit. Settings
                 * closing goes Back to the entry under its own, which the page shows: a Visit made
                 * in that moment is outside what this module decides.
                 */
                let unsettled = false
                /** Whether the writes queued by the step that made it unsettled have all run. */
                let settledSince = true
                for (const s of steps) {
                    if (!backClosable()) replacedUnder = false
                    // Which overlays may close in this step: the one closed, or the one Back closes.
                    const openBefore = stillOpen()
                    let mayClose: FakeOverlay | undefined
                    if (s.kind === 'open') open.push({ overlay: world.openOverlay('overlay', s), refuses: s.refuses })
                    else if (s.kind === 'close') {
                        mayClose = openBefore[s.which]?.overlay
                        mayClose?.closeOtherWay()
                    }
                    else if (s.kind === 'visit') {
                        if (settledSince) unsettled = false
                        world.visit(s.name)
                    }
                    else if (s.kind === 'replace') {
                        replacedUnder ||= backClosable()
                        world.replace(s.name)
                    }
                    else if (s.kind === 'open-settings') world.openSettings()
                    else if (s.kind === 'close-settings') world.closeSettings()
                    else if (s.kind === 'settle') await world.settle()
                    else if (s.kind === 'press-back') world.pressBack()
                    else if (s.kind === 'press-forward') world.pressForward()
                    else if (s.kind === 'back') {
                        await world.settle()
                        const top = onTop()
                        const before = world.front().visit
                        const covered = backClosable()
                        if (covered) mayClose = top?.overlay
                        await world.userBack()
                        if (covered) {
                            if (!replacedUnder) expect(world.front().visit).toBe(before)
                            // Unless Back reached a Settings entry left under the overlay, which
                            // opens Settings over it: the known gap pinned in overlay-history.test.ts.
                            if (!world.settingsOpen()) expect(top?.overlay.isOpen()).toBe(top?.refuses)
                        }
                        // Never on an entry left behind, after Back as after any other step.
                        expect(world.front().overlay).toBe(backClosable())
                    } else {
                        await world.settle()
                        const before = world.front().visit
                        const covered = backClosable()
                        await world.userForward()
                        // Nothing lies ahead of an overlay's entry, so Forward under one does nothing.
                        if (covered) expect(world.front().visit).toBe(before)
                        expect(world.front().overlay).toBe(backClosable())
                    }
                    if (['settle', 'back', 'forward'].includes(s.kind)) {
                        settledSince = true
                        // The entry in front names the page shown, once the writes have run.
                        if (!unsettled) expect(world.front().visit).toBe(world.shown())
                    }
                    if (['close-settings', 'press-back', 'press-forward'].includes(s.kind)) {
                        unsettled = true
                        settledSince = false
                    }
                    // Back and Forward pressed without waiting can each close what is on top then.
                    if (s.kind === 'press-back' || s.kind === 'press-forward') continue
                    const closed = openBefore.filter((o) => !o.overlay.isOpen()).map((o) => o.overlay)
                    expect(closed.filter((o) => o !== mayClose)).toEqual([])
                }
                await world.settle()
                expect(world.front().overlay).toBe(backClosable())
                if (!unsettled) expect(world.front().visit).toBe(world.shown())
            }),
            fuzz(2000),
        )
    })
})
