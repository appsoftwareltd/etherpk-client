/**
 * The addresses on the way from "I want a synced graph" to naming one, across the managed
 * service's two origins. Every address here is built from an origin the deployment configures;
 * nothing a request carries goes into one.
 *
 * - The Client's Synced Graph panel sends someone with no account to Corporate's registration,
 *   which goes on to Billing (`redirect=/billing`, a path Corporate checks with `safeReturnPath`).
 * - Billing starts Checkout, and once Sync+ is active links back to the Client's Graphs page with
 *   `new=synced`, which opens the dialog that names a new synced graph.
 */
import { buildBillingUrl, buildClientGraphsUrl, parseNavigationOrigin } from '../deployment-navigation'

/** The Graphs page parameter that asks for a new graph, and its one value. */
export const NEW_GRAPH_PARAM = 'new'
export const NEW_GRAPH_SYNCED = 'synced'

/** The Client's Graphs page, opening the dialog that names a new synced graph. */
export function buildClientNewSyncedGraphUrl(clientOrigin: string): string {
    const url = new URL(buildClientGraphsUrl(clientOrigin))
    url.searchParams.set(NEW_GRAPH_PARAM, NEW_GRAPH_SYNCED)
    return url.href
}

/** Corporate's registration page, going on to Billing, where the Sync+ Trial starts (ADR 0068). */
export function buildSyncPlusSignUpUrl(corporateOrigin: string): string {
    const origin = parseNavigationOrigin(corporateOrigin, 'Corporate origin')
    const url = new URL('/register', `${origin}/`)
    url.searchParams.set('redirect', new URL(buildBillingUrl(origin)).pathname)
    return url.href
}
