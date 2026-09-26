import { describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

function visit(query: string) {
    const setHeaders = vi.fn()
    const data = load({
        url: new URL(`https://app.example.com/auth/sign-in-failed${query}`),
        setHeaders,
    } as unknown as Parameters<typeof load>[0]) as { title: string; detail: string; signInHref: string }
    return { data, setHeaders }
}

describe('/auth/sign-in-failed', () => {
    it('says why sign-in stopped and offers to sign in again, back to where the user was going', () => {
        const { data } = visit('?reason=busy&redirect=%2Fg%2Fabc%2Fd%2FJournal')

        expect(data.title).toBe('Sign-in did not finish')
        expect(data.detail).toMatch(/busy/)
        expect(data.signInHref).toBe('/auth/login?redirect=%2Fg%2Fabc%2Fd%2FJournal')
    })

    // Where a reloaded or replayed callback lands.
    it('explains a callback that no longer belongs to a sign-in in progress', () => {
        const { data } = visit('?reason=stale&redirect=%2Fg%2Fdemo-graph')

        expect(data.detail).toBe(
            'This sign-in link was already used or has expired, so it could not finish. Nothing was lost. Sign in again to carry on.',
        )
        expect(data.signInHref).toBe('/auth/login?redirect=%2Fg%2Fdemo-graph')
    })

    it('never sends the user off the Client, whatever the link carries', () => {
        expect(visit('?reason=busy&redirect=%2F%2Fevil.example%2F').data.signInHref)
            .toBe('/auth/login?redirect=%2Fgraphs%3Fmanaged%3Dconnected')
        expect(visit('?reason=busy&redirect=https%3A%2F%2Fevil.example').data.signInHref)
            .toBe('/auth/login?redirect=%2Fgraphs%3Fmanaged%3Dconnected')
    })

    it('still helps for a reason it does not know, and is never cached', () => {
        const { data, setHeaders } = visit('?reason=something-new')

        expect(data.title).toBe('Sign-in did not finish')
        expect(data.detail).toMatch(/sign in again/i)
        expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' })
    })
})
