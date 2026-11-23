/**
 * The [[Sidebar Arrangement]] (ADR 0199): what a person has set up about their two Sidebars. Which
 * side the [[Primary Sidebar]] is on, which Sidebar each View belongs to, the order of the
 * [[Activity Bar]]'s icons and of the Secondary Sidebar's tabs, and which Views are hidden.
 *
 * Pure data and pure functions over it. A Sidebar View is named by its View kind, because a
 * Sidebar holds one View of a kind (Backlinks is keyed by a document, and is still one tab).
 *
 * The arrangement belongs to the person and serves every graph and device, so it can name a kind
 * the open graph or this device cannot show: the Graph View in the Phone Layout, a View of an
 * extension that is off. Every function here takes the kinds that can be shown (`known`), leaves
 * the others where they are, and never drops them: the next device still wants them.
 */

import type { SidebarSide } from './types'

/** The two Sidebars by job, whichever side each is on. */
export type SidebarRole = 'primary' | 'secondary'

/** The two Sidebar regions of a Layout, which are positions. */
export type SidebarRegion = 'left-sidebar' | 'right-sidebar'

export interface SidebarArrangement {
    /** The side the Primary Sidebar is on. */
    primarySide: SidebarSide
    /** The Primary Sidebar's View kinds in order, hidden ones in their places. */
    primary: string[]
    /** The Secondary Sidebar's, the same way. */
    secondary: string[]
    /** The kinds that are hidden. */
    hidden: string[]
}

/** A Sidebar View this graph and device can show, with the Sidebar it starts in. */
export interface KnownSidebarView {
    kind: string
    role: SidebarRole
}

/** The Views each Sidebar shows, in order. */
export type SidebarViews = Record<SidebarRole, string[]>

/**
 * A person who has arranged nothing. The lists are empty and each known View joins the end of its
 * default Sidebar, so the defaults are the Client's and an update can change them.
 */
export const DEFAULT_ARRANGEMENT: SidebarArrangement = Object.freeze({
    primarySide: 'left',
    primary: Object.freeze([]) as unknown as string[],
    secondary: Object.freeze([]) as unknown as string[],
    hidden: Object.freeze([]) as unknown as string[],
}) as SidebarArrangement

const ROLES: readonly SidebarRole[] = ['primary', 'secondary']

const otherRole = (role: SidebarRole): SidebarRole => (role === 'primary' ? 'secondary' : 'primary')

/** Whether a kind can be shown here. A change names a View on screen, so one naming any other kind does nothing. */
const canShow = (known: readonly KnownSidebarView[], kind: string) => known.some((view) => view.kind === kind)

/**
 * The arrangement with every known View written into a list: one not yet in either joins the end
 * of its default Sidebar, in the order `known` gives. What every other function works from.
 */
export function normalise(arrangement: SidebarArrangement, known: readonly KnownSidebarView[]): SidebarArrangement {
    const primary = [...arrangement.primary]
    const secondary = arrangement.secondary.filter((kind) => !primary.includes(kind))
    const placed = new Set([...primary, ...secondary])
    for (const view of known) {
        if (placed.has(view.kind)) continue
        placed.add(view.kind)
        ;(view.role === 'primary' ? primary : secondary).push(view.kind)
    }
    return { primarySide: arrangement.primarySide, primary, secondary, hidden: [...new Set(arrangement.hidden)] }
}

/** The Views each Sidebar shows here: its kinds in order, less the hidden and the unknown. */
export function shown(arrangement: SidebarArrangement, known: readonly KnownSidebarView[]): SidebarViews {
    const all = normalise(arrangement, known)
    const can = new Set(known.map((view) => view.kind))
    const visible = (kinds: string[]) => kinds.filter((kind) => can.has(kind) && !all.hidden.includes(kind))
    return { primary: visible(all.primary), secondary: visible(all.secondary) }
}

/** The hidden Views that could be shown here, the Primary Sidebar's first, each in its place. */
export function hiddenKinds(arrangement: SidebarArrangement, known: readonly KnownSidebarView[]): string[] {
    const all = normalise(arrangement, known)
    const can = new Set(known.map((view) => view.kind))
    return [...all.primary, ...all.secondary].filter((kind) => can.has(kind) && all.hidden.includes(kind))
}

/** The Sidebar a View belongs to, shown or hidden, or undefined for a kind that is no Sidebar View. */
export function roleOf(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string): SidebarRole | undefined {
    const all = normalise(arrangement, known)
    if (all.primary.includes(kind)) return 'primary'
    return all.secondary.includes(kind) ? 'secondary' : undefined
}

/** The Layout region a Sidebar is in. */
export function regionOfRole(arrangement: SidebarArrangement, role: SidebarRole): SidebarRegion {
    const side: SidebarSide = role === 'primary' ? arrangement.primarySide : arrangement.primarySide === 'left' ? 'right' : 'left'
    return side === 'left' ? 'left-sidebar' : 'right-sidebar'
}

/** The Sidebar in a Layout region. */
export function roleOfRegion(arrangement: SidebarArrangement, region: SidebarRegion): SidebarRole {
    return regionOfRole(arrangement, 'primary') === region ? 'primary' : 'secondary'
}

/** The Primary Sidebar on the other side. */
export function swapSides(arrangement: SidebarArrangement): SidebarArrangement {
    return { ...arrangement, primarySide: arrangement.primarySide === 'left' ? 'right' : 'left' }
}

/** Hide a View. It keeps its Sidebar and its place. */
export function hide(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string): SidebarArrangement {
    const all = normalise(arrangement, known)
    if (all.hidden.includes(kind) || !canShow(known, kind)) return all
    return { ...all, hidden: [...all.hidden, kind] }
}

/** Show a hidden View, where it was. */
export function show(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string): SidebarArrangement {
    const all = normalise(arrangement, known)
    if (!canShow(known, kind)) return all
    return { ...all, hidden: all.hidden.filter((hidden) => hidden !== kind) }
}

/** Move a View to the end of a Sidebar, and show it. One already there stays where it is. */
export function moveToRole(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string, role: SidebarRole): SidebarArrangement {
    const all = show(arrangement, known, kind)
    const from = canShow(known, kind) ? roleOf(all, known, kind) : undefined
    if (from === undefined || from === role) return all
    return { ...all, [from]: all[from].filter((other) => other !== kind), [role]: [...all[role], kind] }
}

/**
 * Seat a View at `index` among the Views its Sidebar shows: where a dragged icon is dropped. The
 * Views that are hidden, or that cannot be shown here, keep their places in the list.
 */
export function seatAt(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string, index: number): SidebarArrangement {
    const all = normalise(arrangement, known)
    const role = roleOf(all, known, kind)
    if (role === undefined) return all
    const visible = shown(all, known)[role]
    const from = visible.indexOf(kind)
    if (from < 0) return all
    const order = visible.filter((other) => other !== kind)
    order.splice(Math.max(0, Math.min(index, order.length)), 0, kind)
    return { ...all, [role]: refill(all[role], new Set(visible), order) }
}

/** Move a View one place up (`-1`) or down (`1`) among the Views its Sidebar shows. */
export function moveBy(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], kind: string, delta: -1 | 1): SidebarArrangement {
    const role = roleOf(arrangement, known, kind)
    const at = role === undefined ? -1 : shown(arrangement, known)[role].indexOf(kind)
    return at < 0 ? normalise(arrangement, known) : seatAt(arrangement, known, kind, at + delta)
}

/**
 * `list` with the kinds in `movable` put in the order `order` gives, and every other kind left in
 * the slot it had. A kind of `order` that `list` lacks joins the end.
 */
function refill(list: readonly string[], movable: ReadonlySet<string>, order: readonly string[]): string[] {
    const next = [...order]
    const filled = list.flatMap((kind) => {
        if (!movable.has(kind)) return [kind]
        const taken = next.shift()
        return taken === undefined ? [] : [taken]
    })
    return [...filled, ...next]
}

/**
 * The arrangement a Layout shows, given the kinds of the Views open in each Sidebar, in tab order.
 * A known View that is open belongs to the Sidebar it is in, at the place its tab has. A known
 * View that is not open is hidden, and keeps its Sidebar and its place. A kind that cannot be
 * shown here keeps whatever the arrangement said of it. A kind that is no Sidebar View (a page
 * dragged into a Sidebar) and a second View of a kind are passed over.
 */
export function fromLayout(arrangement: SidebarArrangement, known: readonly KnownSidebarView[], layout: SidebarViews): SidebarArrangement {
    const all = normalise(arrangement, known)
    const can = new Set(known.map((view) => view.kind))
    const seen = new Set<string>()
    const open: SidebarViews = { primary: [], secondary: [] }
    for (const role of ROLES) {
        for (const kind of layout[role]) {
            if (!can.has(kind) || seen.has(kind)) continue
            seen.add(kind)
            open[role].push(kind)
        }
    }
    const lists: SidebarViews = { primary: [], secondary: [] }
    for (const role of ROLES) {
        // A View now open in the other Sidebar has left this one.
        const stayed = all[role].filter((kind) => !open[otherRole(role)].includes(kind))
        lists[role] = refill(stayed, new Set(open[role]), open[role])
    }
    const hidden = [...all.hidden.filter((kind) => !can.has(kind)), ...known.map((view) => view.kind).filter((kind) => !seen.has(kind))]
    return { primarySide: all.primarySide, primary: lists.primary, secondary: lists.secondary, hidden }
}

/** Whether two arrangements say the same thing. */
export function sameArrangement(a: SidebarArrangement, b: SidebarArrangement): boolean {
    const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((kind, at) => kind === y[at])
    return a.primarySide === b.primarySide && same(a.primary, b.primary) && same(a.secondary, b.secondary) && same([...a.hidden].sort(), [...b.hidden].sort())
}

/** The arrangement as the text a person's settings keep. */
export function serializeArrangement(arrangement: SidebarArrangement): string {
    const { primarySide, primary, secondary, hidden } = arrangement
    return JSON.stringify({ primarySide, primary, secondary, hidden })
}

/**
 * The arrangement in a person's settings. The text comes from another device or an earlier Client,
 * so nothing in it is trusted: what is not an arrangement reads as the default, a kind listed
 * twice is kept once, and one in both Sidebars stays in the Primary.
 */
export function parseArrangement(text: string | undefined): SidebarArrangement {
    if (!text) return DEFAULT_ARRANGEMENT
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return DEFAULT_ARRANGEMENT
    }
    if (typeof raw !== 'object' || raw === null) return DEFAULT_ARRANGEMENT
    const field = raw as Record<string, unknown>
    const kinds = (value: unknown): string[] | null =>
        Array.isArray(value) ? [...new Set(value.filter((kind): kind is string => typeof kind === 'string' && kind !== ''))] : null
    const primary = kinds(field.primary)
    const secondary = kinds(field.secondary)
    if ((field.primarySide !== 'left' && field.primarySide !== 'right') || !primary || !secondary) return DEFAULT_ARRANGEMENT
    return {
        primarySide: field.primarySide,
        primary,
        secondary: secondary.filter((kind) => !primary.includes(kind)),
        hidden: kinds(field.hidden) ?? [],
    }
}
