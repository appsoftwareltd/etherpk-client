import { describe, expect, it, vi } from 'vitest'

import { AgentTokenError, exchangeForAgentToken, redeemSetupCode, revokeHeldToken } from './agent-token'

const SERVER = 'https://sync.example.com'
const AGENT = `epk_agt_${'B'.repeat(43)}`
const STANDARD = `epk_pat_${'C'.repeat(43)}`
const CODE = `epk_setup_${'D'.repeat(43)}`

function answering(status: number, body: unknown) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

describe('a setup code', () => {
    it('is traded for an agent token, named for this computer, with no other credential', async () => {
        const fetch = answering(201, { token: AGENT, expiresAt: '2026-11-06T00:00:00.000Z' })

        await expect(redeemSetupCode({ syncServer: SERVER, code: CODE, name: 'Agent on desk', fetch })).resolves.toBe(AGENT)

        const [url, init] = fetch.mock.calls[0]
        expect(String(url)).toBe(`${SERVER}/api/v1/sync/agent-tokens`)
        expect(JSON.parse(String(init?.body))).toEqual({ setupCode: CODE, name: 'Agent on desk' })
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
    })

    it('that is used or expired says so in the server\'s words', async () => {
        const fetch = answering(400, { error: { code: 'agent_setup_code_invalid', message: 'This setup code was already used.' } })

        await expect(redeemSetupCode({ syncServer: SERVER, code: CODE, name: 'Agent on desk', fetch })).rejects.toThrow('This setup code was already used.')
    })

    it('on a server from before setup codes says the server needs updating', async () => {
        const fetch = vi.fn(async () => new Response('Not Found', { status: 404 }))

        await expect(redeemSetupCode({ syncServer: SERVER, code: CODE, name: 'Agent on desk', fetch })).rejects.toThrow(/older version/)
    })
})

describe('exchanging a standard token', () => {
    it('sends the standard token as the bearer and answers the agent token', async () => {
        const fetch = answering(201, { token: AGENT, expiresAt: '2026-11-06T00:00:00.000Z' })

        await expect(exchangeForAgentToken({ syncServer: SERVER, token: STANDARD, name: 'Agent on desk', fetch })).resolves.toBe(AGENT)

        const [, init] = fetch.mock.calls[0]
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${STANDARD}`)
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'Agent on desk' })
    })

    it('answers null on a server from before agent tokens, so the standard token goes on working', async () => {
        const fetch = vi.fn(async () => new Response('Not Found', { status: 404 }))

        await expect(exchangeForAgentToken({ syncServer: SERVER, token: STANDARD, name: 'Agent on desk', fetch })).resolves.toBeNull()
    })

    it('rejects with the status when the server refuses the token', async () => {
        const fetch = answering(401, { error: { message: 'Unauthorized' } })

        const refused = exchangeForAgentToken({ syncServer: SERVER, token: STANDARD, name: 'Agent on desk', fetch })
        await expect(refused).rejects.toBeInstanceOf(AgentTokenError)
        await expect(refused).rejects.toMatchObject({ status: 401 })
    })
})

describe('revoking the token this computer holds', () => {
    it('asks the server to revoke the token the request came with', async () => {
        const fetch = answering(200, { ok: true })

        await expect(revokeHeldToken({ syncServer: SERVER, token: AGENT, fetch })).resolves.toBe(true)

        const [url, init] = fetch.mock.calls[0]
        expect(String(url)).toBe(`${SERVER}/api/v1/sync/tokens/current`)
        expect(init?.method).toBe('DELETE')
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${AGENT}`)
    })

    it('answers false, and does not throw, when the server cannot be reached or refuses', async () => {
        const unreachable = vi.fn(async () => {
            throw new TypeError('fetch failed')
        })
        await expect(revokeHeldToken({ syncServer: SERVER, token: AGENT, fetch: unreachable })).resolves.toBe(false)
        await expect(revokeHeldToken({ syncServer: SERVER, token: AGENT, fetch: answering(401, {}) })).resolves.toBe(false)
    })
})
