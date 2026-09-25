/**
 * The Registration Policy: who may create an account on this deployment.
 *
 * Two allowlists, both read from the environment and both of which a registration must pass:
 * `REGISTRATION_ALLOWED_EMAIL_ADDRESSES` and `REGISTRATION_ALLOWED_IPS`. Each is three-state -
 * `*` opens it, a list restricts it, empty closes it - and a deployment that leaves one unset does
 * not start, so a forgotten line fails the rollout instead of quietly closing (or, under the old
 * convention, opening) registration. The Sync Server enforces it in standalone mode and Corporate
 * enforces it for managed sign-up; the rules live here so the two cannot drift on what `*`,
 * trimming and case-folding mean (ADR 0081).
 *
 * The policy gates creation and nothing after it. An address removed from the list neither ends a
 * session nor demotes anyone - that is what distinguishes it from `ADMINISTRATOR_EMAIL_ADDRESS`,
 * which is reconciled on every sign-in.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { BlockList, isIP } from 'node:net'
import { REGISTRATION_REFUSAL_CODES, registrationRefusalMessage, type RegistrationRefusal } from './messages'

export const REGISTRATION_ALLOWED_EMAIL_ADDRESSES = 'REGISTRATION_ALLOWED_EMAIL_ADDRESSES'
export const REGISTRATION_ALLOWED_IPS = 'REGISTRATION_ALLOWED_IPS'

export type Allowlist<Entry> =
    | { kind: 'open' }
    | { kind: 'closed' }
    | { kind: 'list'; entries: Entry[] }

/** `alice@example.com` admits one person; `*@example.com` admits anyone at exactly that domain. */
export type EmailRule =
    | { kind: 'address'; address: string }
    | { kind: 'domain'; domain: string }

export interface RegistrationPolicy {
    emails: Allowlist<EmailRule>
    ips: Allowlist<string>
}

export type RegistrationDecision =
    | { allowed: true }
    | { allowed: false; reason: RegistrationRefusal }

export interface RegistrationRequest {
    /** The adapter-resolved client address; `undefined` when it could not be resolved. */
    clientAddress?: string
    /** The address the account would be created under, once the request has said. */
    email?: string
    /**
     * Judge the email even when it is absent. A pre-check (page load, a social sign-up before
     * the provider has said who it is for) has no address yet and must not be refused for it; the
     * creation hook does have one, or should, and an absent address there is a refusal.
     */
    judgeEmail?: boolean
}

/**
 * Read both lists from the environment, refusing to start on a missing one. An empty string is
 * a decision (closed); `undefined` is a line nobody wrote.
 */
export function parseRegistrationPolicy(environment: Record<string, string | undefined>): RegistrationPolicy {
    const emails = environment[REGISTRATION_ALLOWED_EMAIL_ADDRESSES]
    if (emails === undefined) {
        throw new Error(`${REGISTRATION_ALLOWED_EMAIL_ADDRESSES} must be set: * to open registration, a comma-separated list of addresses or *@domain entries to restrict it, or empty to close it`)
    }
    const ips = environment[REGISTRATION_ALLOWED_IPS]
    if (ips === undefined) {
        throw new Error(`${REGISTRATION_ALLOWED_IPS} must be set: * to open registration, a comma-separated list of IP addresses to restrict it, or empty to close it`)
    }
    return {
        emails: parseAllowedEmailAddresses(emails),
        ips: parseAllowedIps(ips),
    }
}

/** Case-folded, because every provider anyone uses treats the local part that way too. */
export function parseAllowedEmailAddresses(value: string): Allowlist<EmailRule> {
    return parseAllowlist(value, REGISTRATION_ALLOWED_EMAIL_ADDRESSES, (entry) => {
        const lowered = entry.toLowerCase()
        const at = lowered.indexOf('@')
        const local = lowered.slice(0, at)
        const domain = lowered.slice(at + 1)
        if (at < 0 || !local || !isPlainDomain(domain)) {
            throw new Error(`${REGISTRATION_ALLOWED_EMAIL_ADDRESSES} contains an invalid entry: ${entry}`)
        }
        if (local === '*') return { kind: 'domain', domain }
        if (/[\s*@]/.test(local)) {
            throw new Error(`${REGISTRATION_ALLOWED_EMAIL_ADDRESSES} contains an invalid entry: ${entry}`)
        }
        return { kind: 'address', address: lowered }
    })
}

/** Exact IP addresses only. Hostnames and CIDR ranges are deliberate errors. */
export function parseAllowedIps(value: string): Allowlist<string> {
    return parseAllowlist(value, REGISTRATION_ALLOWED_IPS, (entry) => {
        if (isIP(entry) === 0) {
            throw new Error(`${REGISTRATION_ALLOWED_IPS} contains an invalid IP address: ${entry}`)
        }
        return entry
    })
}

function parseAllowlist<Entry>(value: string, name: string, parseEntry: (entry: string) => Entry): Allowlist<Entry> {
    const raw = value.split(',').map((entry) => entry.trim()).filter(Boolean)
    if (raw.length === 0) return { kind: 'closed' }
    if (raw.includes('*')) {
        if (raw.length > 1) throw new Error(`${name} cannot mix * with other entries`)
        return { kind: 'open' }
    }
    const entries: Entry[] = []
    const seen = new Set<string>()
    for (const entry of raw) {
        const parsed = parseEntry(entry)
        const key = JSON.stringify(parsed)
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(parsed)
    }
    return { kind: 'list', entries }
}

/** A domain as it appears after the `@`: no wildcard, no whitespace, no second `@`. */
function isPlainDomain(domain: string): boolean {
    return domain.length > 0 && !/[\s*@]/.test(domain)
}

/**
 * Closed beats everything; then the IP, which the request cannot choose; then the email, which
 * it can. A restricted IP list fails closed when no valid client address is available.
 */
export function evaluateRegistration(policy: RegistrationPolicy, request: RegistrationRequest): RegistrationDecision {
    if (policy.emails.kind === 'closed' || policy.ips.kind === 'closed') {
        return { allowed: false, reason: 'closed' }
    }
    if (policy.ips.kind === 'list' && !ipAllowed(policy.ips.entries, request.clientAddress)) {
        return { allowed: false, reason: 'ip' }
    }
    if (policy.emails.kind === 'list' && (request.email !== undefined || request.judgeEmail)) {
        if (!emailAllowed(policy.emails.entries, request.email)) return { allowed: false, reason: 'email' }
    }
    return { allowed: true }
}

function ipAllowed(entries: readonly string[], clientAddress: string | undefined): boolean {
    const clientVersion = clientAddress ? isIP(clientAddress) : 0
    if (clientVersion === 0) return false

    const allowed = new BlockList()
    for (const address of entries) {
        allowed.addAddress(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
    }
    return allowed.check(clientAddress!, clientVersion === 4 ? 'ipv4' : 'ipv6')
}

function emailAllowed(entries: readonly EmailRule[], email: string | undefined): boolean {
    const lowered = email?.trim().toLowerCase()
    if (!lowered) return false
    const at = lowered.lastIndexOf('@')
    const domain = at >= 0 ? lowered.slice(at + 1) : ''
    return entries.some((rule) =>
        rule.kind === 'address' ? rule.address === lowered : rule.domain === domain,
    )
}

export type RegistrationAttempt =
    | { kind: 'email'; email: string | undefined }
    | { kind: 'social' }

/**
 * Which public Better Auth requests explicitly ask to create an account, and for whom. The
 * email form says its address up front; a social sign-up only learns it at the provider
 * callback, which is why `user.create.before` judges the email a second time.
 */
export async function identifyRegistrationAttempt(request: Request): Promise<RegistrationAttempt | null> {
    if (request.method !== 'POST') return null

    const pathname = new URL(request.url).pathname
    if (pathname === '/api/auth/sign-up/email') {
        const body = await readJsonBody(request)
        const email = body?.email
        return { kind: 'email', email: typeof email === 'string' ? email : undefined }
    }
    if (pathname === '/api/auth/sign-in/social') {
        const body = await readJsonBody(request)
        return body?.requestSignUp === true ? { kind: 'social' } : null
    }
    return null
}

/**
 * Better Auth creates social users at the provider callback, after the initial sign-up request,
 * and creates users on other paths too (an administrator adding one). Only the self-service
 * paths are the policy's business.
 */
export function isSelfServiceUserCreation(path: string | undefined): boolean {
    return path === '/sign-up/email' || path === '/callback/:id'
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const body: unknown = await request.clone().json()
        return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null
    } catch {
        return null
    }
}

/** The auth API's answer to a refused registration: 403 with the reason's code and copy. */
export function registrationRefusedResponse(reason: RegistrationRefusal): Response {
    return new Response(JSON.stringify({
        code: REGISTRATION_REFUSAL_CODES[reason],
        message: registrationRefusalMessage(reason),
    }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
    })
}

/**
 * The gate each app's `handle` puts in front of Better Auth. The email form is judged in full
 * here, where its address is in the body; a social sign-up is only pre-checked (closed, IP)
 * because the provider has not yet said who it is for - the `user.create.before` hook judges
 * that at the callback, against the same adapter-resolved address this carries in.
 */
export async function gateRegistrationRequest(
    policy: RegistrationPolicy,
    request: Request,
    clientAddress: string | undefined,
    next: () => Promise<Response>,
): Promise<Response> {
    const attempt = await identifyRegistrationAttempt(request)
    if (attempt) {
        const decision = evaluateRegistration(policy, {
            clientAddress,
            ...(attempt.kind === 'email' ? { email: attempt.email, judgeEmail: true } : {}),
        })
        if (!decision.allowed) return registrationRefusedResponse(decision.reason)
    }
    return withRegistrationClientAddress(clientAddress, next)
}

const registrationRequestContext = new AsyncLocalStorage<{ clientAddress: string | undefined }>()

/**
 * Keep SvelteKit's adapter-resolved address with one Better Auth request across its async
 * callbacks, so the `user.create.before` hook judges the same address `handle` did rather than
 * a browser-supplied forwarding header.
 */
export function withRegistrationClientAddress<Result>(
    clientAddress: string | undefined,
    operation: () => Result,
): Result {
    return registrationRequestContext.run({ clientAddress }, operation)
}

export function getRegistrationClientAddress(): string | undefined {
    return registrationRequestContext.getStore()?.clientAddress
}
