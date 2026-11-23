import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
    fromLayout,
    hiddenKinds,
    hide,
    moveBy,
    moveToRole,
    normalise,
    parseArrangement,
    roleOf,
    seatAt,
    serializeArrangement,
    show,
    shown,
    swapSides,
    type KnownSidebarView,
    type SidebarArrangement,
    type SidebarRole,
} from './sidebar-arrangement'

/**
 * For any arrangement a person's settings could hold, any set of Views a graph and device can
 * show, and any run of the changes a person can make: every View is in one Sidebar, a View this
 * device cannot show is never lost, and reading the arrangement back off a Layout that shows it
 * gives the same arrangement.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.LAYOUT_FUZZ_SEED
    return { numRuns: Number(process.env.LAYOUT_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261122 : Number(seed) }
}

const KINDS = ['garden', 'kitchen', 'attic', 'cellar', 'shed', 'orchard', 'pantry'] as const
const kind = fc.constantFrom(...KINDS)
const role = fc.constantFrom<SidebarRole>('primary', 'secondary')

/** Any arrangement that settings text can hold, read as the Client reads it. */
const arrangement = fc
    .record({
        primarySide: fc.constantFrom('left', 'right'),
        primary: fc.array(kind, { maxLength: 6 }),
        secondary: fc.array(kind, { maxLength: 6 }),
        hidden: fc.array(kind, { maxLength: 4 }),
    })
    .map((raw) => parseArrangement(JSON.stringify(raw)))

/** The Views a graph and device can show: some of the kinds, each with a default Sidebar. */
const known = fc
    .uniqueArray(fc.record({ kind, role, after: fc.option(kind, { nil: undefined }) }), { selector: (view) => view.kind, maxLength: KINDS.length })
    .map((views): KnownSidebarView[] => views)

type Change = (arrangement: SidebarArrangement, known: readonly KnownSidebarView[]) => SidebarArrangement

const change: fc.Arbitrary<Change> = fc.oneof(
    kind.map<Change>((k) => (a, known) => hide(a, known, k)),
    kind.map<Change>((k) => (a, known) => show(a, known, k)),
    fc.tuple(kind, role).map<Change>(([k, r]) => (a, known) => moveToRole(a, known, k, r)),
    fc.tuple(kind, fc.constantFrom<-1 | 1>(-1, 1)).map<Change>(([k, d]) => (a, known) => moveBy(a, known, k, d)),
    fc.tuple(kind, fc.integer({ min: -1, max: 8 })).map<Change>(([k, at]) => (a, known) => seatAt(a, known, k, at)),
    fc.constant<Change>((a) => swapSides(a)),
)

const after = (start: SidebarArrangement, known: readonly KnownSidebarView[], changes: Change[]) =>
    changes.reduce((a, apply) => apply(a, known), start)

describe('Sidebar Arrangement properties', () => {
    it('every known View is in exactly one Sidebar, shown or hidden', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(change, { maxLength: 12 }), (start, views, changes) => {
                const end = after(start, views, changes)
                const visible = shown(end, views)
                const hidden = hiddenKinds(end, views)
                for (const view of views) {
                    const places = [visible.primary, visible.secondary, hidden].filter((list) => list.includes(view.kind))
                    expect(places).toHaveLength(1)
                    expect(roleOf(end, views, view.kind)).toBeDefined()
                }
                const all = [...visible.primary, ...visible.secondary, ...hidden]
                expect(new Set(all).size).toBe(all.length)
                expect(all.every((k) => views.some((view) => view.kind === k))).toBe(true)
            }),
            fuzz(500),
        )
    })

    it('no kind is in both lists, and none is listed twice', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(change, { maxLength: 12 }), (start, views, changes) => {
                const end = after(start, views, changes)
                const all = [...end.primary, ...end.secondary]
                expect(new Set(all).size).toBe(all.length)
                expect(new Set(end.hidden).size).toBe(end.hidden.length)
            }),
            fuzz(500),
        )
    })

    it('a View that cannot be shown here keeps its Sidebar, its hidden state and its place among the others like it', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(change, { maxLength: 12 }), (start, views, changes) => {
                const can = new Set(views.map((view) => view.kind))
                const elsewhere = (a: SidebarArrangement) => ({
                    primary: a.primary.filter((k) => !can.has(k)),
                    secondary: a.secondary.filter((k) => !can.has(k)),
                    hidden: a.hidden.filter((k) => !can.has(k)).sort(),
                })
                expect(elsewhere(after(start, views, changes))).toEqual(elsewhere(normalise(start, views)))
            }),
            fuzz(500),
        )
    })

    it('a View that cannot be shown here keeps its slot in its list through a reorder', () => {
        fc.assert(
            fc.property(arrangement, known, kind, fc.constantFrom<-1 | 1>(-1, 1), fc.integer({ min: 0, max: 8 }), (start, views, k, delta, at) => {
                const can = new Set(views.map((view) => view.kind))
                const slots = (a: SidebarArrangement) => [a.primary, a.secondary].map((list) => list.map((other) => (can.has(other) ? null : other)))
                const before = slots(normalise(start, views))
                expect(slots(moveBy(start, views, k, delta))).toEqual(before)
                expect(slots(seatAt(start, views, k, at))).toEqual(before)
            }),
            fuzz(500),
        )
    })

    it('reading it back off a Layout that shows it gives the same arrangement', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(change, { maxLength: 8 }), (start, views, changes) => {
                const end = after(start, views, changes)
                const read = fromLayout(end, views, shown(end, views))
                expect(shown(read, views)).toEqual(shown(end, views))
                expect(hiddenKinds(read, views)).toEqual(hiddenKinds(end, views))
                expect(read.primary).toEqual(normalise(end, views).primary)
                expect(read.secondary).toEqual(normalise(end, views).secondary)
                // And again: a second read changes nothing, so two devices cannot pass a change back and forth.
                expect(fromLayout(read, views, shown(read, views))).toEqual(read)
            }),
            fuzz(500),
        )
    })

    it('a Layout read into it is the Layout it then shows', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(kind, { maxLength: 8 }), fc.array(kind, { maxLength: 8 }), (start, views, primary, secondary) => {
                const read = fromLayout(start, views, { primary, secondary })
                const can = new Set(views.map((view) => view.kind))
                const seen = new Set<string>()
                const first = (kinds: string[]) => kinds.filter((k) => can.has(k) && !seen.has(k) && seen.add(k))
                expect(shown(read, views)).toEqual({ primary: first(primary), secondary: first(secondary) })
            }),
            fuzz(500),
        )
    })

    it('a Layout read into it leaves a View that cannot be shown here as it was', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(kind, { maxLength: 8 }), fc.array(kind, { maxLength: 8 }), (start, views, primary, secondary) => {
                const can = new Set(views.map((view) => view.kind))
                const elsewhere = (a: SidebarArrangement) => ({
                    primary: a.primary.filter((k) => !can.has(k)),
                    secondary: a.secondary.filter((k) => !can.has(k)),
                    hidden: a.hidden.filter((k) => !can.has(k)).sort(),
                })
                expect(elsewhere(fromLayout(start, views, { primary, secondary }))).toEqual(elsewhere(normalise(start, views)))
            }),
            fuzz(500),
        )
    })

    it('hide then show, and a step down then up, put a View back where it was', () => {
        fc.assert(
            fc.property(arrangement, known, kind, (start, views, k) => {
                const before = normalise(start, views)
                fc.pre(views.some((view) => view.kind === k) && !before.hidden.includes(k))
                expect(show(hide(start, views, k), views, k)).toEqual(before)
                const visible = shown(start, views)[roleOf(start, views, k)!]
                fc.pre(visible.indexOf(k) < visible.length - 1)
                expect(shown(moveBy(moveBy(start, views, k, 1), views, k, -1), views)).toEqual(shown(start, views))
            }),
            fuzz(500),
        )
    })

    it('the text it is kept as reads back the same', () => {
        fc.assert(
            fc.property(arrangement, known, fc.array(change, { maxLength: 8 }), (start, views, changes) => {
                const end = after(start, views, changes)
                expect(parseArrangement(serializeArrangement(end))).toEqual(end)
            }),
            fuzz(300),
        )
    })
})
