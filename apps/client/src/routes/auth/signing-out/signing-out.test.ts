import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
    env: {
        CLIENT_PUBLIC_URL: 'https://app.example.com',
        CORPORATE_ISSUER: 'https://accounts.example.com',
        MANAGED_OAUTH_CLIENT_ID: 'etherpk-client',
        MANAGED_SYNC_URL: 'https://sync.example.com',
        CLIENT_SESSION_SECRET: 'a-client-session-secret-with-32-bytes',
    },
}))

const { load } = await import('./+page.server')

const loadFrom = (from: string | null) =>
    load({
        url: new URL(`https://app.example.com/auth/signing-out${from === null ? '' : `?from=${from}`}`),
    } as unknown as Parameters<typeof load>[0])

describe('the Client step of a sign-out started elsewhere', () => {
    // The next hop comes from configuration and the source alone, never from the address, so the
    // page can never be used to send a browser somewhere else.
    it('goes on to the Sync portal, which finishes where the sign-out started', async () => {
        expect(await loadFrom('sync')).toEqual({ next: 'https://sync.example.com/?managed=signed-out' })
        expect(await loadFrom('corporate')).toEqual({
            next: 'https://sync.example.com/auth/portal/logout/managed?finish=corporate',
        })
    })

    it('refuses any other source', async () => {
        for (const from of [null, 'client', 'https://evil.example.com']) {
            await expect(loadFrom(from)).rejects.toMatchObject({ status: 400 })
        }
    })
})
