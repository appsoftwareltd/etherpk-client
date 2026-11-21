import { describe, expect, it } from 'vitest'
import type { SyncIndicator, SyncIndicatorState } from '#lib/sync/sync-indicator.js'
import { calloutToShow, graphStatus } from './graph-status'
import type { MirrorIndicatorView } from './mirror-indicator'

const sync = (state: SyncIndicatorState, unsent = 0): SyncIndicator => ({ state, label: state, detail: `${state} detail.`, unsent })
const noMirror: MirrorIndicatorView = { state: 'hidden' }
const mirror = (state: 'writing' | 'current' | 'paused' | 'waiting'): MirrorIndicatorView => ({ state, title: `mirror ${state}.` })

describe('graphStatus', () => {
    it('shows nothing on a graph that is not synced', () => {
        expect(graphStatus(false, null, noMirror)).toEqual({ shown: false })
    })

    it('is green when sync works and there is no mirror, or the mirror works too', () => {
        expect(graphStatus(true, sync('synced'), noMirror)).toMatchObject({ shown: true, tone: 'ok', mirror: null })
        expect(graphStatus(true, sync('synced'), mirror('current'))).toMatchObject({ tone: 'ok' })
        // Another tab mirroring the graph is the mirror working.
        expect(graphStatus(true, sync('synced'), mirror('waiting'))).toMatchObject({ tone: 'ok' })
    })

    it('takes the more pressing of the two parts', () => {
        expect(graphStatus(true, sync('synced'), mirror('paused'))).toMatchObject({ tone: 'stopped' })
        expect(graphStatus(true, sync('turned-away'), mirror('current'))).toMatchObject({ tone: 'stopped' })
        expect(graphStatus(true, sync('synced'), mirror('writing'))).toMatchObject({ tone: 'busy' })
        expect(graphStatus(true, sync('offline'), mirror('current'))).toMatchObject({ tone: 'idle' })
        expect(graphStatus(true, sync('offline'), mirror('writing'))).toMatchObject({ tone: 'busy' })
    })

    it('is not green before the first sync state has settled', () => {
        expect(graphStatus(true, null, mirror('current'))).toMatchObject({ tone: 'busy', sync: null })
    })

    it('carries each part for the dialog, and both in the dot’s name', () => {
        const status = graphStatus(true, sync('sending', 2), mirror('current'))
        expect(status).toMatchObject({
            sync: { state: 'sending', label: 'sending', detail: 'sending detail.', unsent: 2, tone: 'busy' },
            mirror: { state: 'current', label: 'Up to date', detail: 'mirror current.', tone: 'ok' },
            title: 'Sync: sending. sending detail. Mirroring: Up to date. mirror current.',
        })
    })

    it('gives a notice for each state that is not syncing, saying changes are kept and when they sync', () => {
        const callout = (state: SyncIndicatorState) => {
            const status = graphStatus(true, sync(state), noMirror)
            return status.shown ? status.callout : null
        }
        expect(callout('turned-away')).toEqual({
            id: 'turned-away',
            text: 'Not syncing: this graph is open in too many tabs or devices. Your changes are kept on this device and sync once one of the other tabs is closed. If you close this tab your edits will sync when a newly opened tab next syncs.',
        })
        expect(callout('offline')?.text).toBe('Offline. Your changes are kept on this device and sync when the connection returns.')
        expect(callout('refused')?.text).toBe('The sync server is not accepting changes to this graph. Your changes are kept on this device and sync once it does.')
        expect(callout('waiting-for-key')?.text).toBe("Waiting for this graph's new key. Your changes are kept on this device and sync once it arrives.")
        for (const passing of ['synced', 'sending', 'connecting', 'reconnecting', 'ended'] as const) expect(callout(passing)).toBeNull()
    })
})

describe('calloutToShow', () => {
    const offline = { id: 'offline', text: 'Offline.' }

    it('shows a notice until it is closed, and keeps it closed while its state lasts', () => {
        expect(calloutToShow(offline, null)).toEqual({ show: offline, nextDismissed: null })
        expect(calloutToShow(offline, 'offline')).toEqual({ show: null, nextDismissed: 'offline' })
    })

    it('forgets the close once the state has gone, so the notice shows when it comes back', () => {
        expect(calloutToShow(null, 'offline')).toEqual({ show: null, nextDismissed: null })
        // Another state's notice is not the one that was closed.
        expect(calloutToShow({ id: 'refused', text: 'Refused.' }, 'offline')).toEqual({ show: { id: 'refused', text: 'Refused.' }, nextDismissed: null })
    })
})
