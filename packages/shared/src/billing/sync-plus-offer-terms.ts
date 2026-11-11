/**
 * The terms the managed service offers Sync+ on, as its account site publishes them for the other
 * apps to show: whether Sync+ can be bought now, the price as it is displayed, how often it is
 * charged and how long the trial is. The account site answers them at `SYNC_PLUS_OFFER_PATH`, and
 * a Client reads them from there on its server, so no app but the account site holds a figure.
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
    /** The price as the account site writes it, currency included. Shown as text, never parsed. */
    priceDisplay: z
        .string()
        .min(1)
        .max(32)
        // Printable characters only, and none that could open markup wherever it is shown.
        .regex(/^[^\p{Cc}\p{Cf}<>]+$/u),
    billingInterval: z.enum(['month', 'year']),
    /** Days of trial a first subscription starts with; 0 for none. */
    trialDays: z.number().int().min(0).max(366),
})

export type SyncPlusOfferTerms = z.infer<typeof termsSchema>

/** The terms in `value`, or null when it is not exactly their shape. */
export function parseSyncPlusOfferTerms(value: unknown): SyncPlusOfferTerms | null {
    const parsed = termsSchema.safeParse(value)
    return parsed.success ? parsed.data : null
}

export function buildSyncPlusOfferUrl(corporateOrigin: string): string {
    return new URL(SYNC_PLUS_OFFER_PATH, `${parseNavigationOrigin(corporateOrigin, 'Corporate origin')}/`).href
}
