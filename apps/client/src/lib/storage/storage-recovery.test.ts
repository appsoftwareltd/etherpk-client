import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    STORAGE_RECOVERY_FOOTNOTE,
    STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH,
    STORAGE_RECOVERY_HEADLINE,
    STORAGE_RECOVERY_INTRO,
    acknowledgeStorageRecoveries,
    reportStorageRecovery,
    storageRecoveries,
    storageRecoveryItems,
    subscribeStorageRecoveries,
} from './storage-recovery'

beforeEach(() => {
    acknowledgeStorageRecoveries()
})

describe('the storage recovery log', () => {
    it('collects what was restored and replays it to a late subscriber', () => {
        reportStorageRecovery({ kind: 'graphs', restored: ['Work'] })
        const listener = vi.fn()
        subscribeStorageRecoveries(listener)

        expect(listener).toHaveBeenCalledWith([{ kind: 'graphs', restored: ['Work'] }])
    })

    it('merges repeated reports of one kind, so two reads of a healed wrap are one line', () => {
        reportStorageRecovery({ kind: 'passkeys', restored: ['g1'] })
        reportStorageRecovery({ kind: 'passkeys', restored: ['g1', 'g2'] })

        expect(storageRecoveries()).toEqual([{ kind: 'passkeys', restored: ['g1', 'g2'] }])
    })

    it('notifies subscribers on each report and stops after unsubscribe', () => {
        const listener = vi.fn()
        const stop = subscribeStorageRecoveries(listener)
        reportStorageRecovery({ kind: 'graphs', restored: ['A'] })
        stop()
        reportStorageRecovery({ kind: 'graphs', restored: ['B'] })

        expect(listener).toHaveBeenCalledTimes(2)
    })

    it('is empty once acknowledged, and says so to subscribers', () => {
        const listener = vi.fn()
        subscribeStorageRecoveries(listener)
        reportStorageRecovery({ kind: 'graphs', restored: ['A'] })
        acknowledgeStorageRecoveries()

        expect(storageRecoveries()).toEqual([])
        expect(listener).toHaveBeenLastCalledWith([])
    })
})

describe('the recovery notice items', () => {
    it('lists each restored graph by name and each passkey by its graph', () => {
        expect(
            storageRecoveryItems(
                [
                    { kind: 'graphs', restored: ['Work', 'Home'] },
                    { kind: 'passkeys', restored: ['g1'] },
                ],
                (graphId) => (graphId === 'g1' ? 'Work' : undefined),
            ),
        ).toEqual(['Synced graph "Work"', 'Synced graph "Home"', 'Passkey for protected documents in "Work"'])
    })

    it('names a passkey without its graph when the caller cannot name it', () => {
        expect(storageRecoveryItems([{ kind: 'passkeys', restored: ['g1'] }])).toEqual(['Passkey for protected documents'])
    })

    it('is empty when nothing was restored', () => {
        expect(storageRecoveryItems([])).toEqual([])
    })

    it('says where the items came from in words a person uses, not the mechanism’s name', () => {
        expect(STORAGE_RECOVERY_INTRO).toBe('Restored from local storage:')
        expect(STORAGE_RECOVERY_HEADLINE).not.toContain('safety copy')
        expect(STORAGE_RECOVERY_FOOTNOTE).toContain('download again')
    })

    it('tells an open graph that no refresh is needed, since its re-download is already under way', () => {
        expect(STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH).toContain('no refresh is needed')
        expect(STORAGE_RECOVERY_FOOTNOTE_OPEN_GRAPH).not.toContain('next open')
    })
})
