import { describe, expect, it } from 'vitest'
import {
    evaluateRegistration,
    gateRegistrationRequest,
    getRegistrationClientAddress,
    identifyRegistrationAttempt,
    isSelfServiceUserCreation,
    parseAllowedEmailAddresses,
    parseAllowedIps,
    parseRegistrationPolicy,
    registrationRefusedResponse,
    withRegistrationClientAddress,
    type RegistrationPolicy,
} from './policy'

const open: RegistrationPolicy = { emails: { kind: 'open' }, ips: { kind: 'open' } }

describe('parseAllowedEmailAddresses', () => {
    it('reads * alone as open', () => {
        expect(parseAllowedEmailAddresses('*')).toEqual({ kind: 'open' })
        expect(parseAllowedEmailAddresses(' * ')).toEqual({ kind: 'open' })
    })

    it('reads an empty value as closed', () => {
        expect(parseAllowedEmailAddresses('')).toEqual({ kind: 'closed' })
        expect(parseAllowedEmailAddresses('   ')).toEqual({ kind: 'closed' })
        expect(parseAllowedEmailAddresses(' , ')).toEqual({ kind: 'closed' })
    })

    it('parses, trims, case-folds and de-duplicates addresses and domain wildcards', () => {
        expect(parseAllowedEmailAddresses(' Alice@Example.com, *@Team.example.org ,alice@example.com')).toEqual({
            kind: 'list',
            entries: [
                { kind: 'address', address: 'alice@example.com' },
                { kind: 'domain', domain: 'team.example.org' },
            ],
        })
    })

    it.each([
        'example.com',
        'alice',
        '@example.com',
        'alice@',
        '*@',
        'alice@example.com@twice',
        'al ice@example.com',
        '*alice@example.com',
        'alice@*.example.com',
    ])('rejects malformed entry %s', (value) => {
        expect(() => parseAllowedEmailAddresses(value))
            .toThrow(`REGISTRATION_ALLOWED_EMAIL_ADDRESSES contains an invalid entry: ${value.trim()}`)
    })

    it('rejects * mixed into a list, which can only be a mistake', () => {
        expect(() => parseAllowedEmailAddresses('*, alice@example.com'))
            .toThrow('REGISTRATION_ALLOWED_EMAIL_ADDRESSES cannot mix * with other entries')
    })
})

describe('parseAllowedIps', () => {
    it('reads * as open and an empty value as closed', () => {
        expect(parseAllowedIps('*')).toEqual({ kind: 'open' })
        expect(parseAllowedIps('')).toEqual({ kind: 'closed' })
    })

    it('parses, trims and de-duplicates exact IPv4 and IPv6 addresses', () => {
        expect(parseAllowedIps('203.0.113.8, 2001:db8::8,203.0.113.8')).toEqual({
            kind: 'list',
            entries: ['203.0.113.8', '2001:db8::8'],
        })
    })

    it.each(['sync.example.com', '203.0.113.0/24', '203.0.113.999'])('rejects non-IP entry %s', (value) => {
        expect(() => parseAllowedIps(value))
            .toThrow(`REGISTRATION_ALLOWED_IPS contains an invalid IP address: ${value}`)
    })

    it('rejects * mixed into a list', () => {
        expect(() => parseAllowedIps('*,203.0.113.8'))
            .toThrow('REGISTRATION_ALLOWED_IPS cannot mix * with other entries')
    })
})

describe('parseRegistrationPolicy', () => {
    it('requires both variables to be present, so a forgotten line fails the rollout', () => {
        expect(() => parseRegistrationPolicy({ REGISTRATION_ALLOWED_IPS: '*' }))
            .toThrow('REGISTRATION_ALLOWED_EMAIL_ADDRESSES must be set: * to open registration, a comma-separated list of addresses or *@domain entries to restrict it, or empty to close it')
        expect(() => parseRegistrationPolicy({ REGISTRATION_ALLOWED_EMAIL_ADDRESSES: '*' }))
            .toThrow('REGISTRATION_ALLOWED_IPS must be set: * to open registration, a comma-separated list of IP addresses to restrict it, or empty to close it')
    })

    it('reads an empty value as closed rather than missing', () => {
        expect(parseRegistrationPolicy({
            REGISTRATION_ALLOWED_EMAIL_ADDRESSES: '',
            REGISTRATION_ALLOWED_IPS: '*',
        })).toEqual({ emails: { kind: 'closed' }, ips: { kind: 'open' } })
    })
})

describe('evaluateRegistration', () => {
    it('allows everything when both lists are open', () => {
        expect(evaluateRegistration(open, { clientAddress: undefined, email: 'anyone@example.com' }))
            .toEqual({ allowed: true })
    })

    it('is closed when either list is empty, before anything else is considered', () => {
        expect(evaluateRegistration(
            { emails: { kind: 'closed' }, ips: { kind: 'open' } },
            { clientAddress: '203.0.113.8', email: 'alice@example.com' },
        )).toEqual({ allowed: false, reason: 'closed' })
        expect(evaluateRegistration(
            { emails: { kind: 'open' }, ips: { kind: 'closed' } },
            { clientAddress: '203.0.113.8', email: 'alice@example.com' },
        )).toEqual({ allowed: false, reason: 'closed' })
    })

    describe('the IP list', () => {
        const policy: RegistrationPolicy = { emails: { kind: 'open' }, ips: { kind: 'list', entries: ['203.0.113.8', '2001:0db8:0:0:0:0:0:8'] } }

        it.each(['203.0.113.8', '2001:db8::8'])('allows exact address %s', (clientAddress) => {
            expect(evaluateRegistration(policy, { clientAddress })).toEqual({ allowed: true })
        })

        it.each([undefined, '203.0.113.9', 'not-an-ip'])('fails closed for client address %s', (clientAddress) => {
            expect(evaluateRegistration(policy, { clientAddress })).toEqual({ allowed: false, reason: 'ip' })
        })
    })

    describe('the email list', () => {
        const policy: RegistrationPolicy = {
            emails: { kind: 'list', entries: [{ kind: 'address', address: 'alice@example.com' }, { kind: 'domain', domain: 'team.example.org' }] },
            ips: { kind: 'open' },
        }

        it.each([' Alice@Example.COM ', 'bob@team.example.org', 'BOB@TEAM.EXAMPLE.ORG'])('allows %s', (email) => {
            expect(evaluateRegistration(policy, { email })).toEqual({ allowed: true })
        })

        it.each(['alice@example.org', 'bob@sub.team.example.org', 'bob@team.example.org.evil', '', undefined])('refuses %s', (email) => {
            // An absent address is a refusal only when it is being judged: `email: undefined` on
            // a restricted list means the request could not say who it is for.
            expect(evaluateRegistration(policy, { email, judgeEmail: true })).toEqual({ allowed: false, reason: 'email' })
        })

        it('does not judge the address on a pre-check, where none is known yet', () => {
            expect(evaluateRegistration(policy, { clientAddress: '203.0.113.8' })).toEqual({ allowed: true })
        })
    })

    it('reports the IP refusal before the email one when both apply', () => {
        expect(evaluateRegistration(
            { emails: { kind: 'list', entries: [] }, ips: { kind: 'list', entries: ['203.0.113.8'] } },
            { clientAddress: '203.0.113.9', email: 'nobody@example.com' },
        )).toEqual({ allowed: false, reason: 'ip' })
    })
})

describe('identifyRegistrationAttempt', () => {
    it('identifies email sign-up and carries the address it is for', async () => {
        const request = new Request('https://sync.example.com/api/auth/sign-up/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'user@example.com' }),
        })

        await expect(identifyRegistrationAttempt(request)).resolves.toEqual({ kind: 'email', email: 'user@example.com' })
    })

    it('identifies an email sign-up whose body is unreadable, with no address', async () => {
        const request = new Request('https://sync.example.com/api/auth/sign-up/email', { method: 'POST', body: 'not json' })
        await expect(identifyRegistrationAttempt(request)).resolves.toEqual({ kind: 'email', email: undefined })
    })

    it('identifies only an explicit social sign-up request', async () => {
        const registration = new Request('https://sync.example.com/api/auth/sign-in/social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'github', requestSignUp: true }),
        })
        const signIn = new Request('https://sync.example.com/api/auth/sign-in/social', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'github' }),
        })

        await expect(identifyRegistrationAttempt(registration)).resolves.toEqual({ kind: 'social' })
        await expect(identifyRegistrationAttempt(signIn)).resolves.toBeNull()
    })

    it('ignores every other auth request', async () => {
        await expect(identifyRegistrationAttempt(new Request('https://sync.example.com/api/auth/sign-up/email', { method: 'GET' })))
            .resolves.toBeNull()
        await expect(identifyRegistrationAttempt(new Request('https://sync.example.com/api/auth/sign-in/email', { method: 'POST', body: '{}' })))
            .resolves.toBeNull()
    })
})

describe('isSelfServiceUserCreation', () => {
    it('recognises the email form and the social callback, and nothing an administrator does', () => {
        expect(isSelfServiceUserCreation('/sign-up/email')).toBe(true)
        expect(isSelfServiceUserCreation('/callback/:id')).toBe(true)
        expect(isSelfServiceUserCreation('/admin/create-user')).toBe(false)
        expect(isSelfServiceUserCreation(undefined)).toBe(false)
    })
})

describe('withRegistrationClientAddress', () => {
    it('keeps the address available across async callbacks of one request only', async () => {
        const seen = await withRegistrationClientAddress('203.0.113.8', async () => {
            await Promise.resolve()
            return getRegistrationClientAddress()
        })
        expect(seen).toBe('203.0.113.8')
        expect(getRegistrationClientAddress()).toBeUndefined()
    })
})

describe('registrationRefusedResponse', () => {
    it.each([
        ['closed', 'REGISTRATION_CLOSED'],
        ['ip', 'REGISTRATION_RESTRICTED_IP'],
        ['email', 'REGISTRATION_RESTRICTED_EMAIL'],
    ] as const)('answers a %s refusal with 403 and the %s code', async (reason, code) => {
        const response = registrationRefusedResponse(reason)
        expect(response.status).toBe(403)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toMatchObject({ code, message: expect.stringMatching(/maintainer/) })
    })
})

describe('gateRegistrationRequest', () => {
    const restricted: RegistrationPolicy = {
        emails: { kind: 'list', entries: [{ kind: 'address', address: 'alice@example.com' }] },
        ips: { kind: 'list', entries: ['203.0.113.8'] },
    }
    const signUp = (email: string) => new Request('https://sync.example.com/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    })
    const socialSignUp = () => new Request('https://sync.example.com/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'github', requestSignUp: true }),
    })
    const passed = () => Promise.resolve(new Response('passed', { status: 200 }))

    it('refuses the email form before Better Auth sees it, naming the reason', async () => {
        const response = await gateRegistrationRequest(restricted, signUp('bob@example.com'), '203.0.113.8', passed)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toMatchObject({ code: 'REGISTRATION_RESTRICTED_EMAIL' })

        const fromElsewhere = await gateRegistrationRequest(restricted, signUp('alice@example.com'), '203.0.113.9', passed)
        await expect(fromElsewhere.json()).resolves.toMatchObject({ code: 'REGISTRATION_RESTRICTED_IP' })
    })

    it('lets an allowed email form through with the client address available to the hook', async () => {
        let seen: string | undefined
        const response = await gateRegistrationRequest(restricted, signUp('Alice@Example.com'), '203.0.113.8', async () => {
            seen = getRegistrationClientAddress()
            return passed()
        })
        expect(response.status).toBe(200)
        expect(seen).toBe('203.0.113.8')
    })

    it('pre-checks a social sign-up on closed and IP only, leaving the email to the callback', async () => {
        const open = await gateRegistrationRequest(restricted, socialSignUp(), '203.0.113.8', passed)
        expect(open.status).toBe(200)

        const blocked = await gateRegistrationRequest(restricted, socialSignUp(), '203.0.113.9', passed)
        await expect(blocked.json()).resolves.toMatchObject({ code: 'REGISTRATION_RESTRICTED_IP' })

        const closed = await gateRegistrationRequest({ ...restricted, emails: { kind: 'closed' } }, socialSignUp(), '203.0.113.8', passed)
        await expect(closed.json()).resolves.toMatchObject({ code: 'REGISTRATION_CLOSED' })
    })

    it('does not judge requests that create nothing', async () => {
        const signIn = new Request('https://sync.example.com/api/auth/sign-in/email', { method: 'POST', body: '{}' })
        const response = await gateRegistrationRequest({ ...restricted, emails: { kind: 'closed' } }, signIn, undefined, passed)
        expect(response.status).toBe(200)
    })
})
