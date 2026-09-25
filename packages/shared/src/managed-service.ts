import { z } from 'zod'

export const MANAGED_SYNC_AUDIENCE = 'urn:etherpk:managed-sync'
export const MANAGED_SYNC_SCOPE = 'sync'
export const ENTITLEMENT_AUDIENCE = 'urn:etherpk:sync-entitlements'
export const ENTITLEMENT_SERVICE = 'managed-sync'
export const ENTITLEMENT_READ_SCOPE = 'entitlements:read'
export const MANAGED_USAGE_SCOPE = 'managed-usage:read'
export const ENTITLEMENT_SUBJECT_CLAIM = 'https://etherpk.com/claims/entitlement-subject'

/** The `billing-account:<id>` prefix every entitlement subject carries. */
export const ENTITLEMENT_SUBJECT_PREFIX = 'billing-account:'

/**
 * Version-agnostic, like `isUuid` on the Server: any UUID version matches, so an id minted as a
 * uuidv7 is recognised as readily as a v4. One pattern, here, next to the claim it belongs to.
 */
export const ENTITLEMENT_SUBJECT_PATTERN =
    /^billing-account:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Is this a well-formed `billing-account:<uuid>` subject? */
export function isEntitlementSubject(value: unknown): value is string {
    return typeof value === 'string' && ENTITLEMENT_SUBJECT_PATTERN.test(value)
}

const httpsUrl = z.url().refine((value) => {
    const url = new URL(value)
    // RFC 6761 reserves localhost and every name beneath it for loopback use, matching the
    // server-side config parsers.
    return url.protocol === 'https:'
        || url.hostname === 'localhost'
        || url.hostname.endsWith('.localhost')
        || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]'
}, 'URL must use HTTPS except on localhost')

const authCapabilitySchema = z.discriminatedUnion('mode', [
    z.strictObject({
        mode: z.literal('standalone'),
        portalUrl: httpsUrl,
        pat: z.boolean(),
    }),
    z.strictObject({
        mode: z.literal('oidc'),
        portalUrl: httpsUrl,
        issuer: httpsUrl,
        pat: z.boolean(),
    }),
])

export const syncServerCapabilitiesSchema = z.strictObject({
    syncApiVersion: z.literal(1),
    auth: authCapabilitySchema,
})

export type SyncServerCapabilities = z.infer<typeof syncServerCapabilitiesSchema>

export const entitlementLimitsSchema = z.strictObject({
    ownedGraphs: z.int().nonnegative(),
    ownedStorageBytes: z.int().nonnegative(),
    playersPerGraph: z.int().nonnegative(),
    assetBytes: z.int().nonnegative(),
    assetChunks: z.int().nonnegative(),
})

export type EntitlementLimits = z.infer<typeof entitlementLimitsSchema>

export const serviceEntitlementSchema = z.strictObject({
    eventId: z.uuid(),
    issuer: httpsUrl,
    audience: z.literal(ENTITLEMENT_AUDIENCE),
    subject: z.string().regex(ENTITLEMENT_SUBJECT_PATTERN),
    service: z.literal(ENTITLEMENT_SERVICE),
    revision: z.int().positive(),
    status: z.enum(['active', 'grace', 'read_only', 'suspended', 'identity_disabled']),
    plan: z.string().min(1).max(64),
    limits: entitlementLimitsSchema,
    effectiveAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
}).refine(
    ({ effectiveAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(effectiveAt),
    { message: 'expiresAt must be later than effectiveAt', path: ['expiresAt'] },
)

export type ServiceEntitlement = z.infer<typeof serviceEntitlementSchema>

/** Content-free aggregate usage which the Sync data plane may expose to Corporate. */
export const managedUsageSchema = z.strictObject({
    subject: z.string().regex(ENTITLEMENT_SUBJECT_PATTERN),
    service: z.literal(ENTITLEMENT_SERVICE),
    measuredAt: z.iso.datetime({ offset: true }),
    ownedGraphs: z.int().nonnegative(),
    ownedStorageBytes: z.int().nonnegative(),
})

export type ManagedUsage = z.infer<typeof managedUsageSchema>

const syncAuthenticationSchema = z.discriminatedUnion('mode', [
    z.strictObject({
        mode: z.literal('standalone'),
        method: z.enum(['session', 'pat']),
    }),
    z.strictObject({
        mode: z.literal('managed'),
        method: z.enum(['oidc', 'pat']),
    }),
])

/**
 * The authenticated, provider-neutral account view exposed by a Sync Server.
 * Provider subjects and entitlement subjects stay server-side because callers only
 * need the stable service-local Principal, display profile, limits, and usage.
 */
export const syncAccountSummarySchema = z.strictObject({
    principal: z.strictObject({
        id: z.uuid(),
        email: z.email().nullable(),
        name: z.string().min(1).nullable(),
        image: httpsUrl.nullable(),
    }),
    authentication: syncAuthenticationSchema,
    /**
     * Where the EtherPK Client for this deployment lives (`CLIENT_PUBLIC_URL`), so a device that
     * knows only the Sync Server - the Headless Client asking to be approved - can name the app
     * the user must open. Optional: an older Server does not send it.
     */
    clientUrl: httpsUrl.optional(),
    entitlement: z.strictObject({
        plan: z.string().min(1).max(64),
        status: serviceEntitlementSchema.shape.status,
        limits: entitlementLimitsSchema,
        usage: z.strictObject({
            ownedGraphs: z.int().nonnegative(),
            ownedStorageBytes: z.int().nonnegative(),
        }),
    }),
})

export type SyncAccountSummary = z.infer<typeof syncAccountSummarySchema>

export const quotaErrorCodeSchema = z.enum([
    'entitlement_inactive',
    'owned_graph_limit',
    'owned_storage_limit',
    'players_per_graph_limit',
    'asset_size_limit',
    'asset_chunk_limit',
    'ownership_transfer_limit',
])

export type QuotaErrorCode = z.infer<typeof quotaErrorCodeSchema>

export const quotaErrorResponseSchema = z.strictObject({
    error: z.literal('quota_denied'),
    code: quotaErrorCodeSchema,
    ownerPrincipalId: z.uuid().optional(),
    retryable: z.literal(true),
})

export type QuotaErrorResponse = z.infer<typeof quotaErrorResponseSchema>
