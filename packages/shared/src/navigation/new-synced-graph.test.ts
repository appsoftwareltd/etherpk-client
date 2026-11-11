import { describe, expect, it } from 'vitest'
import { safeReturnPath } from './safe-return-path'
import { buildClientNewSyncedGraphUrl, buildSyncPlusSignUpUrl, NEW_GRAPH_PARAM, NEW_GRAPH_SYNCED } from './new-synced-graph'

describe('the addresses between the Synced Graph panel and the naming dialog', () => {
    it("opens the naming dialog on the Client's Graphs page", () => {
        expect(buildClientNewSyncedGraphUrl('https://app.example.com')).toBe('https://app.example.com/graphs?new=synced')
        expect([NEW_GRAPH_PARAM, NEW_GRAPH_SYNCED]).toEqual(['new', 'synced'])
    })

    it('registers on Corporate and goes on to Billing', () => {
        expect(buildSyncPlusSignUpUrl('https://www.example.com')).toBe('https://www.example.com/register?redirect=%2Fbilling')
    })

    // Corporate keeps a `redirect` only when `safeReturnPath` accepts it.
    it('names a return path Corporate accepts unchanged', () => {
        const redirect = new URL(buildSyncPlusSignUpUrl('https://www.example.com')).searchParams.get('redirect')
        expect(safeReturnPath(redirect, '/fallback')).toBe('/billing')
    })

    it('refuses an origin that is not one', () => {
        expect(() => buildSyncPlusSignUpUrl('https://www.example.com/path')).toThrow()
        expect(() => buildClientNewSyncedGraphUrl('javascript:alert(1)')).toThrow()
    })
})
