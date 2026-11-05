import { describe, expect, it } from 'vitest'

import { createPersonSettings } from '#lib/person-settings/person-settings.js'
import {
    applyGraphOrder,
    createGraphOrderStore,
    groupGraphs,
    mergeGraphOrder,
} from './graph-order'
import type { GraphRecord } from './graph-registry'

/** A `Storage` over a map, optionally refusing every write as a full or blocked store does. */
function fakeStorage(refuseWrites = false): Storage {
    const values = new Map<string, string>()
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            if (refuseWrites) throw new Error('refused')
            values.set(key, value)
        },
        removeItem: (key: string) => void values.delete(key),
    } as unknown as Storage
}

const local = (id: string): GraphRecord => ({ id, name: id, backend: 'filesystem', createdAt: 0, handle: null })
const synced = (id: string, serverOrigin: string): GraphRecord => ({
    id,
    name: id,
    backend: 'server',
    createdAt: 0,
    handle: null,
    serverScope: { serverOrigin, principalId: 'someone' },
})
const ids = (graphs: readonly { id: string }[]) => graphs.map((graph) => graph.id)

describe('applyGraphOrder', () => {
    const items = [{ id: 'garden' }, { id: 'kitchen' }, { id: 'shed' }]
    const idOf = (item: { id: string }) => item.id

    it('puts the graphs in the saved sequence', () => {
        expect(ids(applyGraphOrder(items, ['shed', 'garden', 'kitchen'], idOf))).toEqual(['shed', 'garden', 'kitchen'])
    })

    it('leaves a graph never positioned after the ones that are, in the order it came', () => {
        expect(ids(applyGraphOrder(items, ['kitchen'], idOf))).toEqual(['kitchen', 'garden', 'shed'])
    })

    it('passes over a saved graph this device does not hold', () => {
        expect(ids(applyGraphOrder(items, ['attic', 'shed', 'cellar', 'garden'], idOf))).toEqual(['shed', 'garden', 'kitchen'])
    })

    it('with nothing saved keeps the order it was given', () => {
        expect(ids(applyGraphOrder(items, [], idOf))).toEqual(['garden', 'kitchen', 'shed'])
    })
})

describe('mergeGraphOrder', () => {
    it('saves the sequence shown when nothing was saved before', () => {
        expect(mergeGraphOrder([], ['shed', 'garden'])).toEqual(['shed', 'garden'])
    })

    it('keeps a graph the list could not show in its place, so an offline drag does not lose it', () => {
        // `attic` is on the server but not shown while offline: the other three trade places around it.
        expect(mergeGraphOrder(['garden', 'attic', 'kitchen', 'shed'], ['shed', 'garden', 'kitchen'])).toEqual([
            'shed',
            'attic',
            'garden',
            'kitchen',
        ])
    })

    it('takes in a graph that had no place yet', () => {
        expect(mergeGraphOrder(['garden'], ['shed', 'garden', 'kitchen'])).toEqual(['shed', 'garden', 'kitchen'])
    })
})

describe('groupGraphs', () => {
    const noOrder = { origins: [] as string[], isDemo: () => false, orderOf: () => [] as string[] }

    it('lists synced groups first, then local', () => {
        const groups = groupGraphs([local('garden'), synced('kitchen', 'https://one.example')], {
            ...noOrder,
            origins: ['https://one.example'],
        })
        expect(groups.map((group) => [group.origin, ids(group.graphs)])).toEqual([
            ['https://one.example', ['kitchen']],
            [null, ['garden']],
        ])
    })

    it('keeps the servers in the sequence it is given', () => {
        const groups = groupGraphs([synced('garden', 'https://two.example'), synced('kitchen', 'https://one.example')], {
            ...noOrder,
            origins: ['https://one.example', 'https://two.example'],
        })
        expect(groups.map((group) => group.origin)).toEqual(['https://one.example', 'https://two.example'])
    })

    it('still shows a graph whose server is not in the sequence, after the ones that are', () => {
        const groups = groupGraphs([synced('garden', 'https://two.example'), synced('kitchen', 'https://one.example')], {
            ...noOrder,
            origins: ['https://one.example'],
        })
        expect(groups.map((group) => group.origin)).toEqual(['https://one.example', 'https://two.example'])
    })

    it('orders each group by its own saved order', () => {
        const groups = groupGraphs(
            [local('garden'), local('kitchen'), synced('shed', 'https://one.example'), synced('attic', 'https://one.example')],
            {
                ...noOrder,
                origins: ['https://one.example'],
                orderOf: (origin) => (origin === null ? ['kitchen', 'garden'] : ['attic', 'shed']),
            },
        )
        expect(groups.map((group) => ids(group.graphs))).toEqual([
            ['attic', 'shed'],
            ['kitchen', 'garden'],
        ])
    })

    it('holds the demo at the end of local, whatever the saved order says', () => {
        const groups = groupGraphs([local('demo'), local('garden')], {
            ...noOrder,
            isDemo: (id) => id === 'demo',
            orderOf: () => ['demo', 'garden'],
        })
        expect(ids(groups[0].graphs)).toEqual(['garden', 'demo'])
    })

    it('leaves out a group with no graphs', () => {
        expect(groupGraphs([], { ...noOrder, origins: ['https://one.example'] })).toEqual([])
    })
})

describe('the graph order store', () => {
    /** One device: the same local storage across calls. */
    function device(localStorage: Storage = fakeStorage()) {
        const person = createPersonSettings(() => fakeStorage())
        return { person, orders: createGraphOrderStore(() => localStorage, person) }
    }

    it('reads nothing before anything is saved', () => {
        expect(device().orders.read(null)).toEqual([])
        expect(device().orders.read('https://one.example')).toEqual([])
    })

    it('keeps a server group apart from local and from another server', () => {
        const { orders } = device()
        orders.write(null, ['garden', 'kitchen'])
        orders.write('https://one.example', ['shed', 'attic'])
        expect(orders.read(null)).toEqual(['garden', 'kitchen'])
        expect(orders.read('https://one.example')).toEqual(['shed', 'attic'])
        expect(orders.read('https://two.example')).toEqual([])
    })

    it("puts a server group's order in the person's settings, so it follows them", () => {
        const { orders, person } = device()
        orders.write('https://one.example', ['shed', 'attic'])
        expect(person.keys('graph-order.')).toEqual(['graph-order.https://one.example'])
    })

    it("keeps local order out of the person's settings, since a folder stays on its device", () => {
        const { orders, person } = device()
        orders.write(null, ['garden', 'kitchen'])
        expect(person.all()).toEqual({})
    })

    it('reads an order another device saved, once it arrives in the settings', () => {
        const { orders, person } = device()
        person.set('graph-order.https://one.example', JSON.stringify(['attic', 'shed']))
        expect(orders.read('https://one.example')).toEqual(['attic', 'shed'])
    })

    it('merges a write with what was saved, so a graph not shown keeps its place', () => {
        const { orders } = device()
        orders.write(null, ['garden', 'attic', 'kitchen'])
        orders.write(null, ['kitchen', 'garden'])
        expect(orders.read(null)).toEqual(['kitchen', 'attic', 'garden'])
    })

    it('reads a damaged saved order as none', () => {
        const localStorage = fakeStorage()
        localStorage.setItem('etherpk:local-graph-order', '{not json')
        const { orders, person } = device(localStorage)
        person.set('graph-order.https://one.example', JSON.stringify({ not: 'a list' }))
        expect(orders.read(null)).toEqual([])
        expect(orders.read('https://one.example')).toEqual([])
    })

    it('keeps the order for the session when the browser refuses to store it', () => {
        const { orders } = device(fakeStorage(true))
        orders.write(null, ['kitchen', 'garden'])
        expect(orders.read(null)).toEqual(['kitchen', 'garden'])
    })

    it('tells a listener about a change to either kind of group, and stops when asked', () => {
        const { orders } = device()
        let heard = 0
        const stop = orders.subscribe(() => heard++)
        orders.write(null, ['garden'])
        orders.write('https://one.example', ['shed'])
        expect(heard).toBe(2)
        stop()
        orders.write(null, ['kitchen'])
        expect(heard).toBe(2)
    })

    it('tells a listener when another tab changes the local order', () => {
        const { orders } = device()
        let heard = 0
        orders.subscribe(() => heard++)
        orders.storageChanged('etherpk:local-graph-order')
        orders.storageChanged('something-else')
        expect(heard).toBe(1)
    })
})
