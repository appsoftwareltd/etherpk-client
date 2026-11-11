import { describe, expect, it } from 'vitest'
import { buildSyncPlusOfferUrl, parseSyncPlusOfferTerms, SYNC_PLUS_OFFER_PATH, syncPlusPricePhrase } from './sync-plus-offer-terms'

// Made-up figures: no deployment's price belongs in this package.
const terms = { billingEnabled: true, monthlyPriceDisplay: '¤12.34', billedYearly: false, priceIsLowest: false, trialDays: 9 }

describe('parseSyncPlusOfferTerms', () => {
    it('accepts the terms as the account site answers them', () => {
        expect(parseSyncPlusOfferTerms(terms)).toEqual(terms)
        const yearly = { ...terms, billingEnabled: false, billedYearly: true, priceIsLowest: true, trialDays: 0 }
        expect(parseSyncPlusOfferTerms(yearly)).toEqual(yearly)
    })

    it.each([
        ['nothing', null],
        ['a string', JSON.stringify(terms)],
        ['an array', [terms]],
        ['a missing field', { billingEnabled: true, monthlyPriceDisplay: '¤12.34', billedYearly: false, priceIsLowest: false }],
        ['a field it does not know', { ...terms, note: 'limited offer' }],
        ['the shape an older account site answered', { billingEnabled: true, priceDisplay: '¤12.34', billingInterval: 'month', trialDays: 9 }],
        ['a flag that is not a boolean', { ...terms, billingEnabled: 'true' }],
        ['an empty price', { ...terms, monthlyPriceDisplay: '' }],
        ['a price that is not text', { ...terms, monthlyPriceDisplay: 1234 }],
        ['a price too long to be one', { ...terms, monthlyPriceDisplay: '1'.repeat(33) }],
        ['a price carrying markup', { ...terms, monthlyPriceDisplay: '<b>12</b>' }],
        ['a price carrying a control character', { ...terms, monthlyPriceDisplay: '12\n34' }],
        ['a price carrying an invisible character', { ...terms, monthlyPriceDisplay: '12‮34' }],
        ['a negative trial', { ...terms, trialDays: -1 }],
        ['a fractional trial', { ...terms, trialDays: 7.5 }],
        ['a trial longer than a year', { ...terms, trialDays: 367 }],
        ['a trial given as text', { ...terms, trialDays: '9' }],
    ])('reads %s as not known', (_name, value) => {
        expect(parseSyncPlusOfferTerms(value)).toBeNull()
    })
})

describe('syncPlusPricePhrase', () => {
    it('says the one price plainly, and the lowest of several as "from"', () => {
        expect(syncPlusPricePhrase(terms)).toBe('¤12.34 a month')
        expect(syncPlusPricePhrase({ ...terms, priceIsLowest: true })).toBe('from ¤12.34 a month')
    })

    it('says when the monthly figure is charged by the year', () => {
        expect(syncPlusPricePhrase({ ...terms, billedYearly: true, priceIsLowest: true })).toBe('from ¤12.34 a month, billed yearly')
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
