import { describe, expect, it } from 'vitest'
import {
    DEFAULT_VERSION_RETENTION_DAYS,
    IDLE_VERSION_GAP_MS,
    deletedItemsSchema,
    isBeforeOperation,
    versionEnvelopeSchema,
    versionListSchema,
    versionPolicySchema,
    versionUploadResultSchema,
    versionUploadSchema,
} from './version-history'

const VERSION_ID = '019c9e42-0b89-7000-8000-000000000001'

describe('version upload body', () => {
    it('accepts a client-chosen id, the epoch, a reason and a base64url envelope', () => {
        const body = { versionId: VERSION_ID, epochId: 1, reason: 'idle', envelope: 'AQEBAAAA' }
        expect(versionUploadSchema.parse(body)).toEqual(body)
    })

    it('refuses an unknown reason, a bad id, a negative epoch and extra fields', () => {
        const body = { versionId: VERSION_ID, epochId: 1, reason: 'idle', envelope: 'AQEBAAAA' }
        expect(() => versionUploadSchema.parse({ ...body, reason: 'manual' })).toThrow()
        expect(() => versionUploadSchema.parse({ ...body, versionId: 'not-a-uuid' })).toThrow()
        expect(() => versionUploadSchema.parse({ ...body, epochId: -1 })).toThrow()
        expect(() => versionUploadSchema.parse({ ...body, envelope: 'not base64url!' })).toThrow()
        expect(() => versionUploadSchema.parse({ ...body, author: 'someone' })).toThrow()
    })
})

// An installed app may be older than the server it uses, so what a newer one adds is left out.
describe('an answer from a newer Sync Server', () => {
    const AT = '2026-12-11T00:00:00.000Z'
    const policy = { retentionDays: 30, reduction: null, removalPaused: false }
    const entry = { versionId: VERSION_ID, createdAt: AT, reason: 'before_delete', bytes: 9, epochId: 1 }

    it('is read without the fields it adds', () => {
        const list = { versions: [entry], policy }
        expect(versionListSchema.parse({ versions: [{ ...entry, device: 'x' }], policy: { ...policy, plan: 'x' }, next: 'x' })).toEqual(list)
        expect(versionUploadResultSchema.parse({ status: 'stored', at: AT })).toEqual({ status: 'stored' })
        const sealed = { versionId: VERSION_ID, createdAt: AT, reason: 'idle', epochId: 1, envelope: 'AQEBAAAA' }
        expect(versionEnvelopeSchema.parse({ ...sealed, device: 'x' })).toEqual(sealed)
        const deleted = {
            documents: [{ docId: VERSION_ID, deletedAt: AT, newestVersionId: VERSION_ID, newestVersionAt: AT, removeAt: null }],
            assets: [{ assetId: VERSION_ID, size: 1, deletedAt: AT, removeAt: null }],
            policy,
        }
        expect(deletedItemsSchema.parse({
            documents: [{ ...deleted.documents[0], by: 'x' }],
            assets: [{ ...deleted.assets[0], by: 'x' }],
            policy,
            more: true,
        })).toEqual(deleted)
        expect(versionPolicySchema.parse({ ...policy, reduction: { toDays: 7, from: AT, note: 'x' } }).reduction).toEqual({ toDays: 7, from: AT })
    })

    it('lists a version made for a reason that is not known here as an ordinary one', () => {
        const read = versionListSchema.parse({ versions: [entry, { ...entry, reason: 'before_merge' }], policy })
        expect(read.versions.map(({ reason }) => reason)).toEqual(['before_delete', 'idle'])
    })

    it('is still refused when a field it has always had is wrong', () => {
        expect(() => versionListSchema.parse({ versions: [{ ...entry, versionId: 'x' }], policy })).toThrow()
        expect(() => versionEnvelopeSchema.parse({ versionId: VERSION_ID, createdAt: AT, reason: 'idle', epochId: 1, envelope: 'not base64url!' })).toThrow()
    })
})

describe('version reasons', () => {
    it('tells a version made before a destructive operation from an idle one', () => {
        expect(isBeforeOperation('idle')).toBe(false)
        expect(isBeforeOperation('before_delete')).toBe(true)
        expect(isBeforeOperation('before_agent_write')).toBe(true)
    })
})

describe('version policy', () => {
    it('says how long a graph keeps versions and whether a reduction is waiting', () => {
        const policy = {
            retentionDays: 365,
            reduction: { toDays: 30, from: '2026-12-11T00:00:00.000Z' },
            removalPaused: false,
        }
        expect(versionPolicySchema.parse(policy)).toEqual(policy)
        expect(versionPolicySchema.parse({ retentionDays: 0, reduction: null, removalPaused: true }).retentionDays).toBe(0)
    })
})

describe('defaults', () => {
    it('makes an idle version at most every ten minutes and keeps them 30 days by default', () => {
        expect(IDLE_VERSION_GAP_MS).toBe(600_000)
        expect(DEFAULT_VERSION_RETENTION_DAYS).toBe(30)
    })
})
