import { describe, expect, it, vi } from 'vitest'

vi.mock('../native/bridge.js', async (original) => ({ ...(await original<object>()), isNativeApp: () => true }))

import { SyncProtocolMismatchError } from './messages'
import { describeStorageFault, describeSyncFailure } from './sync-error-copy'

describe('sync failures in a Native App', () => {
    it('that an update fixes say to update EtherPK: there is no page to reload', () => {
        const message = describeSyncFailure(new SyncProtocolMismatchError(9, 2), 'save your latest changes')
        expect(message).toContain('This app runs')
        expect(message).toContain('Update EtherPK, then open this graph again.')
        expect(message).toContain('Your changes are kept on this device.')
        expect(message).not.toMatch(/reload|Client to upgrade/i)
    })

    it('of an older Sync Server are still its operator’s to fix', () => {
        expect(describeSyncFailure(new SyncProtocolMismatchError(1, 2), 'save your latest changes')).toContain('Its operator needs to upgrade the server')
    })

    it('never name a tab or a browser', () => {
        const fault = describeStorageFault(new DOMException('The connection was closed.', 'InvalidStateError'))
        if (fault) expect(fault).not.toMatch(/\btab\b|browser/i)
        expect(describeStorageFault(new DOMException('x', 'QuotaExceededError'))).not.toMatch(/browser/i)
    })
})
