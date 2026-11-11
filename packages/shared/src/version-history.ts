/**
 * The Version History contract (ADR 0184), shared by the Client that makes and restores
 * Document Versions and the Sync Server that keeps and removes them.
 *
 * The server never reads a version: it stores an envelope the Client sealed, and acts only on the
 * timestamps it records and the reason the Client gives. The reason is the one thing the server
 * reads, because a version made before a destructive operation is kept for the whole retention
 * period while idle versions are thinned by age.
 */
import { z } from 'zod'
import { decodedBase64UrlBytes, SYNC_PROTOCOL_LIMITS } from './sync-protocol'

/** What made a Document Version. Every reason but `idle` is a version made before an operation. */
export const VERSION_REASONS = [
    'idle',
    'before_delete',
    'before_rename',
    'before_replace_all',
    'before_unprotect',
    'before_restore',
    'before_agent_write',
] as const

export type VersionReason = (typeof VERSION_REASONS)[number]

export const versionReasonSchema = z.enum(VERSION_REASONS)

/** A version made before an operation is exempt from thinning (ADR 0184). */
export function isBeforeOperation(reason: VersionReason): boolean {
    return reason !== 'idle'
}

/**
 * The least time between two idle versions of one document made on one device. Closing the
 * document or leaving the page keeps waiting edits sooner; the Sync Server does not check it.
 */
export const IDLE_VERSION_GAP_MS = 10 * 60 * 1000

/** The retention period a Sync Server uses when the Owner's Entitlement names none. */
export const DEFAULT_VERSION_RETENTION_DAYS = 30

/** How long a shorter retention period waits before it removes anything (ADR 0184). */
export const RETENTION_REDUCTION_NOTICE_DAYS = 30

/** A version is one document's text, so it is bounded as a sync envelope is. */
export const MAX_VERSION_ENVELOPE_BYTES = SYNC_PROTOCOL_LIMITS.maxEnvelopeBytes

const isoTime = z.iso.datetime({ offset: true })

const envelope = z
    .string()
    .min(1)
    .refine((value) => decodedBase64UrlBytes(value) !== null, 'Envelope is not valid base64url')
    .refine(
        (value) => (decodedBase64UrlBytes(value) ?? 0) <= MAX_VERSION_ENVELOPE_BYTES,
        'Envelope exceeds the version size limit',
    )

/** `POST /api/v1/sync/graphs/:graphId/docs/:docId/versions`. The id makes a retried upload idempotent. */
export const versionUploadSchema = z.strictObject({
    versionId: z.uuid(),
    epochId: z.int().nonnegative(),
    reason: versionReasonSchema,
    envelope,
})

export type VersionUpload = z.infer<typeof versionUploadSchema>

/**
 * The upload's outcome. `skipped`: the server keeps no versions (a retention period of zero); the
 * Client treats it as done.
 */
export const versionUploadResultSchema = z.strictObject({
    status: z.enum(['stored', 'exists', 'skipped']),
})

export type VersionUploadResult = z.infer<typeof versionUploadResultSchema>

/**
 * How long a graph keeps what Version History holds. `reduction` is set while a shorter period
 * waits out its notice: until `from`, `retentionDays` (the longer period) still applies.
 * `removalPaused` is set while the Owner's plan has lapsed: nothing is removed by age.
 */
export const versionPolicySchema = z.strictObject({
    retentionDays: z.int().nonnegative(),
    reduction: z.strictObject({ toDays: z.int().nonnegative(), from: isoTime }).nullable(),
    removalPaused: z.boolean(),
})

export type VersionPolicy = z.infer<typeof versionPolicySchema>

export const versionListEntrySchema = z.strictObject({
    versionId: z.uuid(),
    createdAt: isoTime,
    reason: versionReasonSchema,
    bytes: z.int().nonnegative(),
    epochId: z.int().nonnegative(),
})

export type VersionListEntry = z.infer<typeof versionListEntrySchema>

/** `GET …/docs/:docId/versions`: verified versions, newest first. */
export const versionListSchema = z.strictObject({
    versions: z.array(versionListEntrySchema),
    policy: versionPolicySchema,
})

export type VersionList = z.infer<typeof versionListSchema>

/** `GET …/docs/:docId/versions/:versionId`: one sealed version. */
export const versionEnvelopeSchema = z.strictObject({
    versionId: z.uuid(),
    createdAt: isoTime,
    reason: versionReasonSchema,
    epochId: z.int().nonnegative(),
    envelope,
})

export type VersionEnvelope = z.infer<typeof versionEnvelopeSchema>

/**
 * `GET …/graphs/:graphId/deleted`. A Deleted Document is listed by its newest version, whose
 * sealed identity gives the Client its name. `removeAt` is when the last thing keeping it goes,
 * unless a Member removes it first; null while removal is paused.
 */
export const deletedItemsSchema = z.strictObject({
    documents: z.array(
        z.strictObject({
            docId: z.uuid(),
            deletedAt: isoTime.nullable(),
            newestVersionId: z.uuid(),
            newestVersionAt: isoTime,
            removeAt: isoTime.nullable(),
        }),
    ),
    assets: z.array(
        z.strictObject({
            assetId: z.uuid(),
            size: z.int().nonnegative(),
            deletedAt: isoTime,
            removeAt: isoTime.nullable(),
        }),
    ),
    policy: versionPolicySchema,
})

export type DeletedItems = z.infer<typeof deletedItemsSchema>
