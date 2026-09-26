import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncActivity } from './graph-sync'
import { createIndicatorSettle, describeSyncActivity, INDICATOR_SETTLE_MS, type SyncIndicator } from './sync-indicator'

const activity = (patch: Partial<SyncActivity> = {}): SyncActivity => ({
    connection: 'open',
    unsentDocuments: 0,
    refusal: null,
    ...patch,
})

describe('describeSyncActivity', () => {
    it('says Synced only when connected with nothing unsent', () => {
        expect(describeSyncActivity(activity(), true)).toMatchObject({ state: 'synced', label: 'Synced', unsent: 0 })
        expect(describeSyncActivity(activity({ unsentDocuments: 2 }), true)).toMatchObject({
            state: 'sending',
            label: 'Sending',
            unsent: 2,
        })
    })

    it('names the documents kept on this device while offline, and says what happens next', () => {
        const offline = describeSyncActivity(activity({ connection: 'reconnecting', unsentDocuments: 3 }), false)
        expect(offline).toMatchObject({ state: 'offline', label: 'Offline', unsent: 3 })
        expect(offline.detail).toBe(
            'This device is offline. Changes to 3 documents are kept on this device and sync when the connection returns.',
        )
        expect(describeSyncActivity(activity({ connection: 'reconnecting', unsentDocuments: 1 }), true)).toMatchObject({
            state: 'reconnecting',
            label: 'Reconnecting',
            detail: 'The connection to the sync server dropped and EtherPK is reconnecting. Changes to 1 document are kept on this device until it does.',
        })
        expect(describeSyncActivity(activity({ connection: 'connecting' }), true).state).toBe('connecting')
    })

    it('puts a refusal before everything else, with the reason the workspace worked out', () => {
        const refused = describeSyncActivity(
            activity({ refusal: { quotaCode: 'entitlement_inactive' }, unsentDocuments: 1, connection: 'reconnecting' }),
            false,
            'Your Sync+ subscription has ended.',
        )
        expect(refused).toMatchObject({ state: 'refused', label: 'Not syncing', unsent: 1 })
        expect(refused.detail).toBe(
            'The sync server is not accepting changes to this graph. Your Sync+ subscription has ended. Changes to 1 document are kept on this device.',
        )
    })

    it('says access ended once the session ended for good', () => {
        expect(describeSyncActivity(activity({ connection: 'ended' }), true)).toMatchObject({ state: 'ended', label: 'Not syncing' })
    })
})

describe('createIndicatorSettle', () => {
    afterEach(() => vi.useRealTimers())
    const synced = describeSyncActivity(activity(), true)
    const sending = describeSyncActivity(activity({ unsentDocuments: 1 }), true)
    const reconnecting = describeSyncActivity(activity({ connection: 'reconnecting' }), true)
    const offline = describeSyncActivity(activity({ connection: 'reconnecting' }), false)

    it('shows a passing state (an ack on its way, a reconnect) only once it has lasted, so nothing flashes', () => {
        vi.useFakeTimers()
        const shown: SyncIndicator[] = []
        const settle = createIndicatorSettle((indicator) => shown.push(indicator))
        settle.update(synced)
        settle.update(sending)
        vi.advanceTimersByTime(INDICATOR_SETTLE_MS - 1)
        settle.update(synced) // the ack arrived in time
        vi.advanceTimersByTime(INDICATOR_SETTLE_MS)
        expect(shown.map((indicator) => indicator.state)).toEqual(['synced', 'synced'])

        settle.update(reconnecting)
        vi.advanceTimersByTime(INDICATOR_SETTLE_MS)
        expect(shown.at(-1)?.state).toBe('reconnecting')
        settle.dispose()
    })

    it('shows offline and refusals at once: they are news, not progress', () => {
        vi.useFakeTimers()
        const shown: SyncIndicator[] = []
        const settle = createIndicatorSettle((indicator) => shown.push(indicator))
        settle.update(synced)
        settle.update(offline)
        expect(shown.at(-1)?.state).toBe('offline')
        settle.dispose()
    })
})
