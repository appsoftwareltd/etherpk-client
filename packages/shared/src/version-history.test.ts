import { describe, expect, it } from 'vitest'
import {
    DEFAULT_VERSION_RETENTION_DAYS,
    IDLE_VERSION_GAP_MS,
    isBeforeOperation,
    versionPolicySchema,
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
