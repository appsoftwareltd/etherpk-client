import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

import { createGraphKeyring } from '$lib/crypto'

import { createGraphSync } from './graph-sync'
import { openGraphCache } from './local-cache'
import { createLoopbackRelay } from './loopback-relay'
import { personalFavourites, settingsKeepingSharedFavourites } from './personal-favourites'
import { fixedSyncToken } from './sync-token'

const ROOT = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'
let counter = 0

/**
 * A graph session whose root catch-up the test resolves by hand, so it can act before and after
 * it. `flushAll` is counted: a background write must leave the append debounce at once.
 */
async function graph() {
    const graphId = `g-personal-favourites-${Math.floor(performance.now() * 1000)}-${counter++}`
    const gs = createGraphSync({
        graphId,
        rootDocId: ROOT,
        keyring: createGraphKeyring(graphId),
        relayUrl: 'ws://loopback/sync',
        token: fixedSyncToken('t'),
        cache: await openGraphCache(graphId),
        connect: createLoopbackRelay().connect,
        debounceMs: 5,
    })
    await gs.ready()
    let catchUp!: () => void
    const caughtUp = new Promise<void>((resolve) => (catchUp = resolve))
    const flushAll = vi.fn(async () => {})
    const session = { ...gs, rootCaughtUp: () => caughtUp, flushAll }
    return { gs, session, catchUp, flushAll }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('personalFavourites: the Favourites one person sees on a synced graph (ADR 0159)', () => {
    it('is the shared Graph Settings list when the person is not known on this device, written back into the current settings', async () => {
        // The graph registry hides a synced graph without its account scope, so this is the
        // fallback for a graph opened another way (the dev gate before it had a key).
        const { gs, session } = await graph()
        gs.setMetaSettings({ favourites: ['Garden'], toolbarColor: '#336699' })
        const favourites = personalFavourites(session, undefined)
        expect(favourites.list()).toEqual(['Garden'])

        let heard = 0
        const stop = favourites.observe(() => heard++)
        gs.setMetaSettings({ ...gs.getMeta().settings, recentDocumentCount: 12 })
        expect(heard).toBe(1)
        stop()

        await favourites.persist(['Garden', 'Kitchen'])
        expect(gs.getMeta().settings).toEqual({ favourites: ['Garden', 'Kitchen'], toolbarColor: '#336699', recentDocumentCount: 12 })
        gs.dispose()
    })

    it('shows the person’s own list joined with the shared one until the seed, own first, without writing', async () => {
        const { gs, session } = await graph()
        gs.setMetaSettings({ favourites: ['Garden', 'cellar', 'Kitchen'] })
        gs.favourites('m1').replace(['Cellar'])
        const favourites = personalFavourites(session, 'm1')

        expect(favourites.list()).toEqual(['Cellar', 'Garden', 'Kitchen'])
        expect(gs.favourites('m1').list()).toEqual(['Cellar'])
        expect(gs.favourites('m1').seeded()).toBe(false)
        gs.dispose()
    })

    it('writes the joined list and marks it seeded when the person changes it before the seed, so the seed never refills it', async () => {
        const { gs, session, catchUp } = await graph()
        gs.setMetaSettings({ favourites: ['Garden', 'Kitchen'] })
        gs.favourites('m1').replace(['Cellar'])
        const favourites = personalFavourites(session, 'm1')
        const stop = favourites.follow(() => true)

        // The person removes Garden from the joined list they see.
        await favourites.persist(['Cellar', 'Kitchen'])
        expect(gs.favourites('m1').list()).toEqual(['Cellar', 'Kitchen'])
        expect(gs.favourites('m1').seeded()).toBe(true)

        catchUp()
        await settle()
        expect(favourites.list()).toEqual(['Cellar', 'Kitchen'])
        stop()
        gs.dispose()
    })

    it('passes a move on to the list, so only the moved entry is re-inserted', async () => {
        const { gs, session } = await graph()
        gs.favourites('m1').seedOnce([])
        gs.favourites('m1').replace(['Garden', 'Kitchen', 'Pantry'])
        const replace = vi.spyOn(gs.favourites('m1'), 'replace')
        const favourites = personalFavourites({ ...session, favourites: () => ({ ...gs.favourites('m1'), replace }) }, 'm1')
        await favourites.persist(['Kitchen', 'Garden', 'Pantry'], { moved: 'Kitchen' })
        expect(replace).toHaveBeenCalledWith(['Kitchen', 'Garden', 'Pantry'], { moved: 'Kitchen' })
        gs.dispose()
    })

    it('copies the shared list in only once the root document has caught up, and saves the copy at once', async () => {
        const { gs, session, catchUp, flushAll } = await graph()
        gs.setMetaSettings({ favourites: ['Garden', 'Kitchen'] })
        const favourites = personalFavourites(session, 'm1')
        const stop = favourites.follow(() => true)
        await settle()
        expect(gs.favourites('m1').seeded()).toBe(false)

        catchUp()
        await settle()
        expect(gs.favourites('m1').list()).toEqual(['Garden', 'Kitchen'])
        expect(gs.favourites('m1').seeded()).toBe(true)
        expect(flushAll).toHaveBeenCalledTimes(1)
        stop()
        gs.dispose()
    })

    it('after the seed, adds what an older Client favourites in the shared list as the change arrives', async () => {
        const { gs, session, catchUp } = await graph()
        gs.setMetaSettings({ favourites: ['Garden'] })
        const favourites = personalFavourites(session, 'm1')
        const stop = favourites.follow(() => true)
        catchUp()
        await settle()
        expect(favourites.list()).toEqual(['Garden'])

        gs.setMetaSettings({ favourites: ['Garden', 'Pantry'] })
        expect(favourites.list()).toEqual(['Garden', 'Pantry'])

        // Stopped: a later shared change is not followed.
        stop()
        gs.setMetaSettings({ favourites: ['Garden', 'Pantry', 'Cellar'] })
        expect(favourites.list()).toEqual(['Garden', 'Pantry'])
        gs.dispose()
    })

    it('reports a background save that fails instead of leaving the rejection unhandled', async () => {
        const { gs, session, catchUp, flushAll } = await graph()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            flushAll.mockRejectedValue(new Error('The disk is full.'))
            gs.setMetaSettings({ favourites: ['Garden'] })
            const stop = personalFavourites(session, 'm1').follow(() => true)
            catchUp()
            await settle()
            expect(gs.favourites('m1').list()).toEqual(['Garden'])
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('favourites'), expect.objectContaining({ message: 'The disk is full.' }))
            stop()
        } finally {
            warn.mockRestore()
            gs.dispose()
        }
    })

    it('copies nothing when the graph closed before the catch-up, or was stopped', async () => {
        const closed = await graph()
        closed.gs.setMetaSettings({ favourites: ['Garden'] })
        personalFavourites(closed.session, 'm1').follow(() => false)
        closed.catchUp()
        await settle()
        expect(closed.gs.favourites('m1').seeded()).toBe(false)
        closed.gs.dispose()

        const stopped = await graph()
        stopped.gs.setMetaSettings({ favourites: ['Garden'] })
        personalFavourites(stopped.session, 'm1').follow(() => true)()
        stopped.catchUp()
        await settle()
        expect(stopped.gs.favourites('m1').seeded()).toBe(false)
        stopped.gs.dispose()
    })
})

describe('settingsKeepingSharedFavourites: what the Graph Settings dialog saves on a synced graph', () => {
    it('never changes the shared favourites, so a favourite removed while the dialog was open does not come back to a Member who follows the shared list', async () => {
        // ADR 0159 decision 4: the shared list is never written again by a person's own changes.
        // The dialog copied it when it opened and does not edit it.
        const { gs, session, catchUp } = await graph()
        gs.setMetaSettings({ favourites: ['Garden', 'Kitchen'], recentDocumentCount: 10 })
        const favourites = personalFavourites(session, 'm1')
        const stop = favourites.follow(() => true)
        catchUp()
        await settle()
        // The person removes Garden from their own list.
        await favourites.persist(['Kitchen'])
        // The dialog opens with the settings as they are now.
        const opened = { favourites: ['Garden', 'Kitchen'], recentDocumentCount: 10 }
        // An older Client removes Garden from the shared list meanwhile.
        gs.setMetaSettings({ favourites: ['Kitchen'], recentDocumentCount: 10 })

        gs.setMetaSettings(settingsKeepingSharedFavourites({ ...opened, recentDocumentCount: 12 }, gs.getMeta().settings))

        expect(gs.getMeta().settings).toEqual({ favourites: ['Kitchen'], recentDocumentCount: 12 })
        expect(favourites.list()).toEqual(['Kitchen'])
        stop()
        gs.dispose()
    })

    it('writes no shared favourites where the graph has none, whatever the dialog holds', () => {
        expect(settingsKeepingSharedFavourites({ favourites: ['Garden'], toolbarColor: '#336699' }, { toolbarColor: '#000000' })).toEqual({
            toolbarColor: '#336699',
        })
        expect(settingsKeepingSharedFavourites({ recentDocumentCount: 12 }, undefined)).toEqual({ recentDocumentCount: 12 })
    })
})
