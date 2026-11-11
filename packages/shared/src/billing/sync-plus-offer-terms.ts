/**
 * The terms the managed service offers Sync+ on, as its account site publishes them for the other
 * apps to show: whether Sync+ can be bought now, the lowest price as a monthly figure, whether that
 * price is charged yearly, whether other prices are on offer, and how long the trial is. The
 * account site answers them at `SYNC_PLUS_OFFER_PATH`, and a Client reads them from there on its
 * server, so no app but the account site holds a figure.
 *
 * The answer crosses a network, so it is checked strictly here and anything unexpected reads as
 * "not known": the page that wanted it then says what it would say without it.
 */
import { z } from 'zod'
import { parseNavigationOrigin } from '../deployment-navigation'

/** Where the account site answers the terms, with no sign-in. */
export const SYNC_PLUS_OFFER_PATH = '/api/v1/sync-plus-offer'

const termsSchema = z.strictObject({
    /** Sync+ can be bought now. */
    billingEnabled: z.boolean(),
    /**
     * The lowest price on offer, per month, as the account site writes it with its currency. A
     * yearly price is given as a twelfth of the year. Shown as text, never parsed.
     */
    monthlyPriceDisplay: z
        .string()
        .min(1)
        .max(32)
        // Printable characters only, and none that could open markup wherever it is shown.
        .regex(/^[^\p{Cc}\p{Cf}<>]+$/u),
    /** That price is charged once a year, so it reads "a month, billed yearly". */
    billedYearly: z.boolean(),
    /** Other tiers or billing periods cost more, so the price reads as "from". */
    priceIsLowest: z.boolean(),
    /** Days of trial a first subscription starts with; 0 for none. */
    trialDays: z.number().int().min(0).max(366),
})

export type SyncPlusOfferTerms = z.infer<typeof termsSchema>

/** The terms in `value`, or null when it is not exactly their shape. */
export function parseSyncPlusOfferTerms(value: unknown): SyncPlusOfferTerms | null {
    const parsed = termsSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

/**
 * The price as a phrase: "from US$4.00 a month, billed yearly". The same words on the Client's
 * Graphs page and anywhere else the terms are quoted.
 */
export function syncPlusPricePhrase(terms: Pick<SyncPlusOfferTerms, 'monthlyPriceDisplay' | 'billedYearly' | 'priceIsLowest'>): string {
    const from = terms.priceIsLowest ? 'from ' : ''
    const billed = terms.billedYearly ? ', billed yearly' : ''
    return `${from}${terms.monthlyPriceDisplay} a month${billed}`
}

export function buildSyncPlusOfferUrl(corporateOrigin: string): string {
    return new URL(SYNC_PLUS_OFFER_PATH, `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}
