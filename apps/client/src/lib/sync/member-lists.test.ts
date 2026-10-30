import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'

import { createGraphSync } from './graph-sync'
import { openGraphCache } from './local-cache'
import { createLoopbackRelay } from './loopback-relay'
import { addBookmark, resetBookmarks, setBookmarks } from '$lib/document/bookmarks/bookmarks'

import {
    activeMemberKeys,
    BOOKMARKS_NEED_MEMBER_KEY,
    clearDepartedMemberLists,
    createPersonalLists,
    ownerRoleFromListing,
    personalQuickNotes,
    refusingBookmarksPersist,
} from './member-lists'
import { fixedSyncToken } from './sync-token'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
let counter = 0

async function graph() {
    const graphId = `g-member-lists-${Math.floor(performance.now() * 1000)}-${counter++}`
    const cache = await openGraphCache(graphId)
    const gs = createGraphSync({
        graphId,
        rootDocId: ROOT,
        keyring: createGraphKeyring(graphId),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache,
        connect: createLoopbackRelay().connect,
        debounceMs: 5,
    })
    await gs.ready()
    return gs
}

const own = { id: 'own-1', text: 'water the beans', createdAt: 200 }
const legacy = { id: 'legacy-1', text: 'sweep the porch', createdAt: 100 }
const ids = (notes: { id: string }[]) => notes.map((n) => n.id).sort()

describe('personalQuickNotes: the Quick Notes one person sees on a synced graph (ADR 0159)', () => {
    it('is the shared array alone when the person is not known on this device, as before per-person lists', async () => {
        const gs = await graph()
        gs.quickNotes().add(legacy)
        const notes = personalQuickNotes(gs, undefined, () => false)
        notes.add(own)
        expect(ids(notes.list())).toEqual(['legacy-1', 'own-1'])
        expect(ids(gs.quickNotes().list())).toEqual(['legacy-1', 'own-1'])
        gs.dispose()
    })

    it('is the person’s own array for a Member who is not the Owner: the authorless shared notes stay out', async () => {
        const gs = await graph()
        gs.quickNotes().add(legacy)
        const notes = personalQuickNotes(gs, 'm1', () => false)
        notes.add(own)
        expect(ids(notes.list())).toEqual(['own-1'])
        expect(ids(gs.quickNotesOf('m1').list())).toEqual(['own-1'])
        expect(ids(gs.quickNotes().list())).toEqual(['legacy-1'])
        gs.dispose()
    })

    it('adds the shared notes for the Owner, once the role is known, and removes a shared note from the shared array', async () => {
        const gs = await graph()
        gs.quickNotes().add(legacy)
        let owner = false
        const notes = personalQuickNotes(gs, 'm1', () => owner)
        notes.add(own)
        expect(ids(notes.list())).toEqual(['own-1'])

        owner = true
        expect(ids(notes.list())).toEqual(['legacy-1', 'own-1'])
        // New notes go to the person's own array, never the shared one.
        notes.add({ id: 'own-2', text: 'buy flour', createdAt: 300 })
        expect(ids(gs.quickNotes().list())).toEqual(['legacy-1'])

        notes.remove(['legacy-1', 'own-1'])
        expect(ids(notes.list())).toEqual(['own-2'])
        expect(gs.quickNotes().list()).toEqual([])
        gs.dispose()
    })

    it('tells the listener about a change to either array, so a note an older build appends to the shared array shows', async () => {
        const gs = await graph()
        const notes = personalQuickNotes(gs, 'm1', () => true)
        const seen: string[][] = []
        const stop = notes.observe(() => seen.push(ids(notes.list())))
        gs.quickNotes().add(legacy)
        gs.quickNotesOf('m1').add(own)
        expect(seen).toEqual([['legacy-1'], ['legacy-1', 'own-1']])
        stop()
        gs.quickNotes().add({ id: 'legacy-2', text: 'oil the gate', createdAt: 50 })
        expect(seen).toHaveLength(2)
        gs.dispose()
    })
})

describe('activeMemberKeys', () => {
    it('is the active members’ ids plus this person’s own key; invitees and duplicates are left out', () => {
        const roster = [
            { userId: 'owner', status: 'active' as const },
            { userId: 'player' },
            { userId: 'invitee', status: 'invited' as const },
            { userId: 'player', status: 'active' as const },
        ]
        expect(activeMemberKeys(roster, 'owner')).toEqual(['owner', 'player'])
        // The person's own lists are never cleared, even when the roster does not list them.
        expect(activeMemberKeys([{ userId: 'player' }], 'owner')).toEqual(['player', 'owner'])
    })
})

describe('clearDepartedMemberLists: the Owner’s Client deletes a departed Member’s lists (ADR 0159)', () => {
    it('waits for the root doc to catch up, then empties the lists of everyone not on the roster and saves the change', async () => {
        const gs = await graph()
        gs.favourites('left').replace(['Garden'])
        gs.favourites('stays').replace(['Kitchen'])
        gs.favourites('owner').replace(['Pantry'])
        const order: string[] = []
        const flushAll = vi.spyOn(gs, 'flushAll')

        const cleared = await clearDepartedMemberLists({
            graph: {
                rootCaughtUp: async () => {
                    order.push('caught up')
                },
                clearDepartedMembers: (keys) => gs.clearDepartedMembers(keys),
                flushAll: () => gs.flushAll(),
            },
            listMembers: async () => {
                order.push('roster')
                return [
                    { userId: 'owner', email: 'o@example.com', role: 'owner', status: 'active' as const },
                    { userId: 'stays', email: 's@example.com', role: 'player', status: 'active' as const },
                ]
            },
            ownKey: 'owner',
            stillOpen: () => true,
        })

        expect(order).toEqual(['caught up', 'roster'])
        expect(cleared).toEqual(['favourites:left'])
        expect(gs.favourites('left').list()).toEqual([])
        expect(gs.favourites('stays').list()).toEqual(['Kitchen'])
        expect(gs.favourites('owner').list()).toEqual(['Pantry'])
        expect(flushAll).toHaveBeenCalledTimes(1)
        gs.dispose()
    })

    it('clears nothing when the roster cannot be read, when it is empty, or when the graph closed meanwhile', async () => {
        const gs = await graph()
        gs.favourites('left').replace(['Garden'])
        const base = {
            graph: gs,
            ownKey: 'owner',
            listMembers: async () => [{ userId: 'owner', email: 'o@example.com', role: 'owner' }],
            stillOpen: () => true,
        }
        expect(await clearDepartedMemberLists({ ...base, listMembers: async () => Promise.reject(new Error('offline')) })).toBeNull()
        expect(await clearDepartedMemberLists({ ...base, listMembers: async () => [] })).toBeNull()
        expect(await clearDepartedMemberLists({ ...base, stillOpen: () => false })).toBeNull()
        expect(gs.favourites('left').list()).toEqual(['Garden'])

        expect(await clearDepartedMemberLists(base)).toEqual(['favourites:left'])
        gs.dispose()
    })

    it('clears nothing when the graph closed while the roster was being read', async () => {
        // Open when the root doc caught up, closed by the time the roster came back: the roster
        // belongs to a session that has ended, and nothing may be written for it.
        const gs = await graph()
        gs.favourites('left').replace(['Garden'])
        const flushAll = vi.spyOn(gs, 'flushAll')
        let open = true
        const stillOpen = vi.fn(() => open)
        const cleared = await clearDepartedMemberLists({
            graph: gs,
            ownKey: 'owner',
            listMembers: async () => {
                open = false
                return [{ userId: 'owner', email: 'o@example.com', role: 'owner' }]
            },
            stillOpen,
        })
        expect(cleared).toBeNull()
        expect(stillOpen).toHaveBeenCalledTimes(2)
        expect(gs.favourites('left').list()).toEqual(['Garden'])
        expect(flushAll).not.toHaveBeenCalled()
        gs.dispose()
    })
})

describe('ownerRoleFromListing: whether this person owns the graph, from the Sync Server’s graph list', () => {
    it('is true for the owner, false for a player, and null when the graph is not listed or the list cannot be read', async () => {
        const listing = [
            { id: 'g1', role: 'owner' },
            { id: 'g2', role: 'player' },
        ]
        expect(await ownerRoleFromListing(Promise.resolve(listing), 'g1')).toBe(true)
        expect(await ownerRoleFromListing(Promise.resolve(listing), 'g2')).toBe(false)
        expect(await ownerRoleFromListing(Promise.resolve(listing), 'g3')).toBeNull()
        expect(await ownerRoleFromListing(Promise.reject(new Error('offline')), 'g1')).toBeNull()
    })
})

describe('refusingBookmarksPersist: bookmarks on a synced graph opened without a member key', () => {
    it('rejects every write with the reason, so the in-memory list rolls back instead of keeping a bookmark that was never saved', async () => {
        setBookmarks([], refusingBookmarksPersist(BOOKMARKS_NEED_MEMBER_KEY))
        await expect(addBookmark('Garden', { line: 0, text: 'water the beans' })).rejects.toThrow(BOOKMARKS_NEED_MEMBER_KEY)
        expect(BOOKMARKS_NEED_MEMBER_KEY).toBe(
            'Bookmarks need this device to know your account on the sync server. Sign in again from the Graphs page.',
        )
        resetBookmarks()
    })
})

describe('createPersonalLists: one person’s lists for one open of a synced graph (ADR 0159)', () => {
    it('builds the Quick Notes once, and tells their listeners when the Owner role arrives', async () => {
        const gs = await graph()
        gs.quickNotes().add(legacy)
        const lists = createPersonalLists(gs, 'm1')
        expect(lists.quickNotes).toBe(lists.quickNotes)
        expect(lists.isOwner()).toBe(false)
        let heard = 0
        const stop = lists.quickNotes.observe(() => heard++)

        lists.setOwner(true)
        expect(heard).toBe(1)
        expect(lists.isOwner()).toBe(true)
        expect(ids(lists.quickNotes.list())).toEqual(['legacy-1'])
        // The same answer again is no change.
        lists.setOwner(true)
        expect(heard).toBe(1)
        stop()
        gs.dispose()
    })

    it('has no bookmarks without a member key, and the person’s own map with one', async () => {
        const gs = await graph()
        expect(createPersonalLists(gs, undefined).bookmarks).toBeNull()
        const lists = createPersonalLists(gs, 'm1')
        lists.bookmarks?.apply({ put: [{ id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', createdAt: 1 }], remove: [] })
        expect(gs.bookmarks('m1').list().map((b) => b.id)).toEqual(['b1'])
        gs.dispose()
    })

    it('gives the Local Mirror and an Export the person’s own favourites, Quick Notes and bookmarks with the shared settings', async () => {
        const gs = await graph()
        gs.setMetaSettings({ favourites: ['Garden'], toolbarColor: '#336699' })
        gs.favourites('m1').seedOnce(['Garden'])
        gs.favourites('m1').replace(['Garden', 'Kitchen'])
        gs.favourites('m2').replace(['Cellar'])
        gs.quickNotes().add(legacy)
        gs.quickNotesOf('m1').add(own)
        gs.bookmarks('m1').apply({ put: [{ id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', createdAt: 1 }], remove: [] })
        const lists = createPersonalLists(gs, 'm1')

        let mirrored = lists.mirrored()
        expect(mirrored.settings).toEqual({ favourites: ['Garden', 'Kitchen'], toolbarColor: '#336699' })
        expect(ids(mirrored.quickNotes)).toEqual(['own-1'])
        expect(mirrored.bookmarks?.map((b) => b.id)).toEqual(['b1'])

        lists.setOwner(true)
        mirrored = lists.mirrored()
        expect(ids(mirrored.quickNotes)).toEqual(['legacy-1', 'own-1'])

        // An empty own list leaves the field out rather than writing the shared one.
        gs.favourites('m1').replace([])
        expect(lists.mirrored().settings).toEqual({ toolbarColor: '#336699' })

        // Without a member key: the shared settings and notes as stored, and no bookmarks file.
        const shared = createPersonalLists(gs, undefined).mirrored()
        expect(shared.settings).toEqual({ favourites: ['Garden'], toolbarColor: '#336699' })
        expect(ids(shared.quickNotes)).toEqual(['legacy-1'])
        expect(shared.bookmarks).toBeUndefined()
        gs.dispose()
    })

    it('tells a mirror listener about a change to the person’s favourites, Quick Notes, bookmarks or Owner role', async () => {
        const gs = await graph()
        const lists = createPersonalLists(gs, 'm1')
        let heard = 0
        const stop = lists.observeMirrored(() => heard++)
        gs.favourites('m1').replace(['Garden'])
        gs.quickNotesOf('m1').add(own)
        gs.bookmarks('m1').apply({ put: [{ id: 'b1', concept: 'Garden', line: 0, text: 'water the beans', createdAt: 1 }], remove: [] })
        expect(heard).toBe(3)
        lists.setOwner(true)
        expect(heard).toBe(4)
        stop()
        gs.favourites('m1').replace([])
        expect(heard).toBe(4)
        gs.dispose()
    })
})
