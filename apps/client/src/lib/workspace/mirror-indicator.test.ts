import { describe, expect, it } from 'vitest'

import { type MirrorStatus, OFFLINE_MESSAGE } from '$lib/storage/server/local-mirror'

import { mirrorIndicatorView } from './mirror-indicator'

function status(overrides: Partial<MirrorStatus> = {}): MirrorStatus {
    return {
        folder: 'Notes',
        running: true,
        syncing: false,
        lastSyncAt: 1,
        documents: 3,
        assets: 0,
        skipped: [],
        collisions: [],
        missingAssets: [],
        danglingLinks: [],
        changesElsewhereUnchecked: false,
        ...overrides,
    }
}

describe('the mirror dot', () => {
    it('says the folder matches only once a pass has completed with nothing outstanding', () => {
        expect(mirrorIndicatorView(status(), false)).toEqual({ state: 'current', title: '“Notes” matches this graph.' })
        expect(mirrorIndicatorView(status({ lastSyncAt: undefined }), false)).toEqual({
            state: 'writing',
            title: 'Getting ready to mirror to “Notes”.',
        })
    })

    it('waits, amber, while a failed pass waits for its retry, and says why', () => {
        const view = mirrorIndicatorView(status({ retrying: { kind: 'offline', message: OFFLINE_MESSAGE } }), false)
        expect(view).toEqual({
            state: 'writing',
            title: `Waiting to mirror to “Notes”. ${OFFLINE_MESSAGE}`,
        })
    })

    it('says a pause in words, whatever stopped it', () => {
        expect(mirrorIndicatorView(status({ running: false, paused: { kind: 'offline', message: OFFLINE_MESSAGE } }), false))
            .toEqual({ state: 'paused', title: `Mirroring to “Notes” has stopped. ${OFFLINE_MESSAGE}` })
    })

    it('is hidden without a mirror, and waits while another tab holds the folder', () => {
        expect(mirrorIndicatorView(null, false)).toEqual({ state: 'hidden' })
        expect(mirrorIndicatorView(null, true)).toEqual({
            state: 'waiting',
            title: 'Another tab of this browser is mirroring this graph to its folder.',
        })
    })
})
