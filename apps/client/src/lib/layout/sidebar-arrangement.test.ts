import { describe, expect, it } from 'vitest'

import {
    DEFAULT_ARRANGEMENT,
    fromLayout,
    hiddenKinds,
    hide,
    moveBy,
    moveToRole,
    normalise,
    parseArrangement,
    regionOfRole,
    roleOf,
    roleOfRegion,
    seatAt,
    serializeArrangement,
    show,
    shown,
    swapSides,
    type KnownSidebarView,
    type SidebarArrangement,
} from './sidebar-arrangement'

/** A graph's Sidebar Views as the Client declares them: the default order and Sidebar of each. */
const KNOWN: KnownSidebarView[] = [
    { kind: 'garden', role: 'primary' },
    { kind: 'kitchen', role: 'primary' },
    { kind: 'attic', role: 'secondary' },
    { kind: 'cellar', role: 'secondary' },
]

describe('the default arrangement', () => {
    it('puts each View in its default Sidebar, in the declared order, on the left', () => {
        expect(shown(DEFAULT_ARRANGEMENT, KNOWN)).toEqual({ primary: ['garden', 'kitchen'], secondary: ['attic', 'cellar'] })
        expect(regionOfRole(DEFAULT_ARRANGEMENT, 'primary')).toBe('left-sidebar')
        expect(regionOfRole(DEFAULT_ARRANGEMENT, 'secondary')).toBe('right-sidebar')
        expect(hiddenKinds(DEFAULT_ARRANGEMENT, KNOWN)).toEqual([])
    })

    it('adds a View declared later to the end of its default Sidebar', () => {
        const arranged = moveBy(DEFAULT_ARRANGEMENT, KNOWN, 'kitchen', -1)
        const later: KnownSidebarView[] = [...KNOWN, { kind: 'shed', role: 'primary' }]
        expect(shown(arranged, later).primary).toEqual(['kitchen', 'garden', 'shed'])
    })
})

describe('swapping sides', () => {
    it('moves the Primary Sidebar to the right and back', () => {
        const swapped = swapSides(DEFAULT_ARRANGEMENT)
        expect(regionOfRole(swapped, 'primary')).toBe('right-sidebar')
        expect(regionOfRole(swapped, 'secondary')).toBe('left-sidebar')
        expect(roleOfRegion(swapped, 'left-sidebar')).toBe('secondary')
        expect(swapSides(swapped).primarySide).toBe('left')
    })

    it('leaves which Views each Sidebar holds as they were', () => {
        expect(shown(swapSides(DEFAULT_ARRANGEMENT), KNOWN)).toEqual(shown(DEFAULT_ARRANGEMENT, KNOWN))
    })
})

describe('hiding and showing', () => {
    it('takes a hidden View out of what is shown and lists it as hidden', () => {
        const hidden = hide(DEFAULT_ARRANGEMENT, KNOWN, 'garden')
        expect(shown(hidden, KNOWN).primary).toEqual(['kitchen'])
        expect(hiddenKinds(hidden, KNOWN)).toEqual(['garden'])
    })

    it('brings a View back to the place it had', () => {
        const back = show(hide(DEFAULT_ARRANGEMENT, KNOWN, 'garden'), KNOWN, 'garden')
        expect(shown(back, KNOWN).primary).toEqual(['garden', 'kitchen'])
        expect(hiddenKinds(back, KNOWN)).toEqual([])
    })

    it('keeps the Sidebar a hidden View belongs to', () => {
        const hidden = hide(moveToRole(DEFAULT_ARRANGEMENT, KNOWN, 'garden', 'secondary'), KNOWN, 'garden')
        expect(roleOf(hidden, KNOWN, 'garden')).toBe('secondary')
    })
})

describe('moving a View', () => {
    it('moves it to the end of the other Sidebar', () => {
        const moved = moveToRole(DEFAULT_ARRANGEMENT, KNOWN, 'garden', 'secondary')
        expect(shown(moved, KNOWN)).toEqual({ primary: ['kitchen'], secondary: ['attic', 'cellar', 'garden'] })
    })

    it('shows a hidden View that is moved', () => {
        const moved = moveToRole(hide(DEFAULT_ARRANGEMENT, KNOWN, 'garden'), KNOWN, 'garden', 'secondary')
        expect(hiddenKinds(moved, KNOWN)).toEqual([])
    })

    it('moves it up and down past the Views that are shown', () => {
        const hidden = hide(DEFAULT_ARRANGEMENT, [...KNOWN, { kind: 'shed', role: 'primary' }], 'kitchen')
        const known: KnownSidebarView[] = [...KNOWN, { kind: 'shed', role: 'primary' }]
        // The hidden kitchen is between the two: one step still passes the shed.
        expect(shown(moveBy(hidden, known, 'garden', 1), known).primary).toEqual(['shed', 'garden'])
        expect(shown(moveBy(hidden, known, 'shed', -1), known).primary).toEqual(['shed', 'garden'])
    })

    it('does nothing at either end', () => {
        expect(shown(moveBy(DEFAULT_ARRANGEMENT, KNOWN, 'garden', -1), KNOWN)).toEqual(shown(DEFAULT_ARRANGEMENT, KNOWN))
        expect(shown(moveBy(DEFAULT_ARRANGEMENT, KNOWN, 'kitchen', 1), KNOWN)).toEqual(shown(DEFAULT_ARRANGEMENT, KNOWN))
    })

    it('seats it at a place among the Views that are shown', () => {
        const known: KnownSidebarView[] = [...KNOWN, { kind: 'shed', role: 'primary' }]
        expect(shown(seatAt(DEFAULT_ARRANGEMENT, known, 'shed', 0), known).primary).toEqual(['shed', 'garden', 'kitchen'])
        expect(shown(seatAt(DEFAULT_ARRANGEMENT, known, 'garden', 2), known).primary).toEqual(['kitchen', 'shed', 'garden'])
    })
})

describe('a View this graph or device cannot show', () => {
    const elsewhere: SidebarArrangement = { primarySide: 'left', primary: ['garden', 'orchard', 'kitchen'], secondary: ['attic'], hidden: ['orchard'] }

    it('is left out of what is shown', () => {
        expect(shown(elsewhere, KNOWN).primary).toEqual(['garden', 'kitchen'])
        expect(hiddenKinds(elsewhere, KNOWN)).toEqual([])
    })

    it('is not changed by a change that names it', () => {
        expect(hide(elsewhere, KNOWN, 'orchard')).toEqual(normalise(elsewhere, KNOWN))
        expect(show(elsewhere, KNOWN, 'orchard').hidden).toContain('orchard')
        expect(moveToRole(elsewhere, KNOWN, 'orchard', 'secondary').primary).toContain('orchard')
        expect(seatAt(elsewhere, KNOWN, 'orchard', 0)).toEqual(normalise(elsewhere, KNOWN))
    })

    it('keeps its place and its hidden state through a change made here', () => {
        const changed = moveBy(elsewhere, KNOWN, 'kitchen', -1)
        expect(changed.primary).toEqual(['kitchen', 'orchard', 'garden'])
        expect(changed.hidden).toContain('orchard')
    })
})

describe('reading the arrangement off a Layout', () => {
    it('is the arrangement itself when the Layout matches it', () => {
        const arranged = hide(moveToRole(DEFAULT_ARRANGEMENT, KNOWN, 'garden', 'secondary'), KNOWN, 'attic')
        expect(fromLayout(arranged, KNOWN, shown(arranged, KNOWN))).toEqual(normalise(arranged, KNOWN))
    })

    it('takes the order of the tabs', () => {
        const read = fromLayout(DEFAULT_ARRANGEMENT, KNOWN, { primary: ['kitchen', 'garden'], secondary: ['attic', 'cellar'] })
        expect(shown(read, KNOWN).primary).toEqual(['kitchen', 'garden'])
    })

    it('hides a View that is not open', () => {
        const read = fromLayout(DEFAULT_ARRANGEMENT, KNOWN, { primary: ['garden', 'kitchen'], secondary: ['attic'] })
        expect(hiddenKinds(read, KNOWN)).toEqual(['cellar'])
        expect(roleOf(read, KNOWN, 'cellar')).toBe('secondary')
    })

    it('moves a View found in the other Sidebar, where it sits', () => {
        const read = fromLayout(DEFAULT_ARRANGEMENT, KNOWN, { primary: ['kitchen'], secondary: ['attic', 'garden', 'cellar'] })
        expect(shown(read, KNOWN)).toEqual({ primary: ['kitchen'], secondary: ['attic', 'garden', 'cellar'] })
    })

    it('ignores a View that is not a Sidebar View, and one listed twice', () => {
        const read = fromLayout(DEFAULT_ARRANGEMENT, KNOWN, { primary: ['garden', 'page', 'kitchen', 'garden'], secondary: ['attic', 'cellar', 'kitchen'] })
        expect(shown(read, KNOWN)).toEqual({ primary: ['garden', 'kitchen'], secondary: ['attic', 'cellar'] })
    })
})

describe('keeping the arrangement as text', () => {
    it('reads back what it wrote', () => {
        const arranged = swapSides(hide(moveBy(DEFAULT_ARRANGEMENT, KNOWN, 'kitchen', -1), KNOWN, 'attic'))
        expect(parseArrangement(serializeArrangement(arranged))).toEqual(arranged)
    })

    it('reads nothing, or text that is not an arrangement, as the default', () => {
        expect(parseArrangement(undefined)).toEqual(DEFAULT_ARRANGEMENT)
        expect(parseArrangement('not json')).toEqual(DEFAULT_ARRANGEMENT)
        expect(parseArrangement('{"primarySide":"up","primary":"garden"}')).toEqual(DEFAULT_ARRANGEMENT)
    })

    it('keeps a View in one Sidebar when the text lists it in both', () => {
        const read = parseArrangement('{"primarySide":"right","primary":["garden","garden"],"secondary":["garden","attic"],"hidden":["attic","attic",7]}')
        expect(read).toEqual({ primarySide: 'right', primary: ['garden'], secondary: ['attic'], hidden: ['attic'] })
    })
})
