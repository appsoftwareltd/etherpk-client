import { describe, expect, it } from 'vitest'
import { SYNC_PLUS_OFFER_TEXT, SYNC_PLUS_PRICING_LABEL } from './sync-plus-offer'

// The one offer a Free account sees on the Sync Server's dashboard, the Client's Graphs page and
// Corporate's Billing page. Its wording is the owner's, so a change to it is deliberate.
describe('the Sync+ offer', () => {
    it('says what is free and what Sync+ adds, in one sentence set', () => {
        expect(SYNC_PLUS_OFFER_TEXT).toBe(
            'Local folder graphs are free. Sync+ adds end-to-end encrypted sync across your devices, multiplayer and managed storage. Synced graphs shared with you are free.',
        )
        expect(SYNC_PLUS_PRICING_LABEL).toBe('Sync+ Pricing')
    })
})
