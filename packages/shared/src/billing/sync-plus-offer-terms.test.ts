import { describe, expect, it } from 'vitest'
import { buildSyncPlusOfferUrl, parseSyncPlusOfferTerms, SYNC_PLUS_OFFER_PATH } from './sync-plus-offer-terms'

// Made-up figures: no deployment's price belongs in this package.
const terms = { billingEnabled: true, priceDisplay: '¤12.34', billingInterval: 'month', trialDays: 9 }

describe('parseSyncPlusOfferTerms', () => {
    it('accepts the terms as the account site answers them', () => {
        expect(parseSyncPlusOfferTerms(terms)).toEqual(terms)
        expect(parseSyncPlusOfferTerms({ ...terms, billingEnabled: false, billingInterval: 'year', trialDays: 0 }))
            .toEqual({ ...terms, billingEnabled: false, billingInterval: 'year', trialDays: 0 })
    })

    it.each([
        ['nothing', null],
        ['a string', JSON.stringify(terms)],
        ['an array', [terms]],
        ['a missing field', { billingEnabled: true, priceDisplay: '¤12.34', billingInterval: 'month' }],
        ['a field it does not know', { ...terms, note: 'limited offer' }],
        ['a flag that is not a boolean', { ...terms, billingEnabled: 'true' }],
        ['an empty price', { ...terms, priceDisplay: '' }],
        ['a price that is not text', { ...terms, priceDisplay: 1234 }],
        ['a price too long to be one', { ...terms, priceDisplay: '1'.repeat(33) }],
        ['a price carrying markup', { ...terms, priceDisplay: '<b>12</b>' }],
        ['a price carrying a control character', { ...terms, priceDisplay: '12\n34' }],
        ['a price carrying an invisible character', { ...terms, priceDisplay: '12‮34' }],
        ['an interval it does not know', { ...terms, billingInterval: 'week' }],
        ['a negative trial', { ...terms, trialDays: -1 }],
        ['a fractional trial', { ...terms, trialDays: 7.5 }],
        ['a trial longer than a year', { ...terms, trialDays: 367 }],
        ['a trial given as text', { ...terms, trialDays: '9' }],
    ])('reads %s as not known', (_name, value) => {
        expect(parseSyncPlusOfferTerms(value)).toBeNull()
    })
})

describe('buildSyncPlusOfferUrl', () => {
    it("names the account site's address for the terms", () => {
        expect(buildSyncPlusOfferUrl('https://www.example.com')).toBe(`https://www.example.com${SYNC_PLUS_OFFER_PATH}`)
        expect(SYNC_PLUS_OFFER_PATH).toBe('/api/v1/sync-plus-offer')
    })

    it('refuses an origin that is not one', () => {
        expect(() => buildSyncPlusOfferUrl('https://www.example.com/path')).toThrow()
    })
})
