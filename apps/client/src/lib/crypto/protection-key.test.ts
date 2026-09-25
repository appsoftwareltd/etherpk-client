import { describe, expect, it } from 'vitest'

import { toBase64Url } from './bytes'
import { keyFingerprint, openProtected, sealProtected } from './protection'
import {
    DEFAULT_KDF_PARAMS,
    ProtectionPassphraseError,
    type ProtectionRecord,
    ProtectionRecordFormatError,
    type ProtectionRecordProblem,
    changeProtectionPassphrase,
    createProtectionKey,
    createProtectionRecord,
    deviceWrapFromPrf,
    newKdfParams,
    parseProtectionRecord,
    serialiseProtectionRecord,
    unlockProtectionRecord,
    unlockWithDeviceWrap,
    validateProtectionRecord,
} from './protection-key'

/** Cheap parameters so the suite stays fast; production defaults are asserted separately. A
 *  factory, not a constant - each record needs its own salt, which is what several of these
 *  tests check. */
const fast = () => ({ ...newKdfParams(), t: 1, m: 8 })

describe('the Protection Key', () => {
    it('is fresh random bytes for every graph', () => {
        expect(toBase64Url(createProtectionKey())).not.toBe(toBase64Url(createProtectionKey()))
    })
})

describe('creating a protection record', () => {
    it('yields a key that opens content, and a record that never holds the key in the clear', async () => {
        const { record, key } = await createProtectionRecord('correct horse battery staple', fast())
        const envelope = await sealProtected({
            key,
            fingerprint: await keyFingerprint(key),
            plaintext: 'router password',
            writtenAt: 1,
        })

        expect((await openProtected({ key, envelope })).plaintext).toBe('router password')
        expect(JSON.stringify(record)).not.toContain(toBase64Url(key))
    })

    it('publishes the fingerprint, so a fence can be matched to it without unlocking', async () => {
        const { record, key } = await createProtectionRecord('correct horse battery staple', fast())

        expect(record.fingerprint).toBe(toBase64Url(await keyFingerprint(key)))
    })

    it('salts every record separately, so two graphs with one passphrase get different keys', async () => {
        const a = await createProtectionRecord('same passphrase', fast())
        const b = await createProtectionRecord('same passphrase', fast())

        expect(a.record.kdf.salt).not.toBe(b.record.kdf.salt)
        expect(toBase64Url(a.key)).not.toBe(toBase64Url(b.key))
    })
})

describe('unlocking with a passphrase', () => {
    it('returns the same key the record was created with', async () => {
        const { record, key } = await createProtectionRecord('correct horse battery staple', fast())

        expect(toBase64Url(await unlockProtectionRecord(record, 'correct horse battery staple'))).toBe(toBase64Url(key))
    })

    it('refuses the wrong passphrase', async () => {
        const { record } = await createProtectionRecord('correct horse battery staple', fast())

        await expect(unlockProtectionRecord(record, 'incorrect horse')).rejects.toThrow(ProtectionPassphraseError)
    })

    it('refuses a passphrase that differs only in trailing whitespace', async () => {
        const { record } = await createProtectionRecord('correct horse', fast())

        await expect(unlockProtectionRecord(record, 'correct horse ')).rejects.toThrow(ProtectionPassphraseError)
    })
})

describe('changing the passphrase', () => {
    it('is a re-wrap: the key survives, so protected content is not re-encrypted', async () => {
        const { record, key } = await createProtectionRecord('old passphrase', fast())

        const rewrapped = await changeProtectionPassphrase(record, 'old passphrase', 'new passphrase', fast())

        expect(toBase64Url(await unlockProtectionRecord(rewrapped, 'new passphrase'))).toBe(toBase64Url(key))
        expect(rewrapped.fingerprint).toBe(record.fingerprint)
    })

    it('re-salts, so the old wrapped blob is not a crib for the new one', async () => {
        const { record } = await createProtectionRecord('old passphrase', fast())

        const rewrapped = await changeProtectionPassphrase(record, 'old passphrase', 'new passphrase', fast())

        expect(rewrapped.kdf.salt).not.toBe(record.kdf.salt)
        expect(rewrapped.wrapped).not.toBe(record.wrapped)
    })

    it('refuses when the current passphrase is wrong', async () => {
        const { record } = await createProtectionRecord('old passphrase', fast())

        await expect(changeProtectionPassphrase(record, 'guess', 'new passphrase', fast())).rejects.toThrow(
            ProtectionPassphraseError,
        )
    })

    it('leaves the old passphrase unable to unlock', async () => {
        const { record } = await createProtectionRecord('old passphrase', fast())

        const rewrapped = await changeProtectionPassphrase(record, 'old passphrase', 'new passphrase', fast())

        await expect(unlockProtectionRecord(rewrapped, 'old passphrase')).rejects.toThrow(ProtectionPassphraseError)
    })
})

describe('the per-device passkey wrap', () => {
    const PRF = new Uint8Array(32).fill(3)

    it('opens the same key without the passphrase', async () => {
        const { record, key } = await createProtectionRecord('correct horse', fast())

        const wrap = await deviceWrapFromPrf(key, PRF, 'credential-1')

        expect(toBase64Url(await unlockWithDeviceWrap(wrap, PRF))).toBe(toBase64Url(key))
        expect(wrap.fingerprint).toBe(record.fingerprint)
    })

    it('refuses a PRF secret from a different passkey', async () => {
        const { key } = await createProtectionRecord('correct horse', fast())

        const wrap = await deviceWrapFromPrf(key, PRF, 'credential-1')

        await expect(unlockWithDeviceWrap(wrap, new Uint8Array(32).fill(4))).rejects.toThrow(ProtectionPassphraseError)
    })

    // ADR 0057: a device wrap is what makes a forgotten passphrase survivable, because the device
    // still holds the key and can re-wrap it under a new one.
    it('lets a device with no passphrase re-wrap the record under a new passphrase', async () => {
        const { record, key } = await createProtectionRecord('forgotten', fast())
        const wrap = await deviceWrapFromPrf(key, PRF, 'credential-1')

        const recovered = await unlockWithDeviceWrap(wrap, PRF)
        const { record: reset } = await createProtectionRecord('a new passphrase', fast(), recovered)

        expect(toBase64Url(await unlockProtectionRecord(reset, 'a new passphrase'))).toBe(toBase64Url(key))
        expect(reset.fingerprint).toBe(record.fingerprint)
    })
})

describe('record serialisation', () => {
    it('round-trips through the string a graph actually stores', async () => {
        // Parsing bounds the parameters, so this one record is made at the smallest real cost.
        const { record } = await createProtectionRecord('correct horse', { ...fast(), m: 8 * 1024 })

        expect(parseProtectionRecord(serialiseProtectionRecord(record))).toEqual(record)
    })

    // "Not a record" must never read as "no record": a store that passed that on would let a
    // mangled or newer `protection.json` look unprotected, and enabling protection would write a
    // fresh key over it, orphaning every fence sealed under the old one. So the parser throws.
    // What "absent" means is the store's call: it is the only layer that knows whether any bytes
    // existed.
    it('refuses text that is not a record, rather than reading it as absent', () => {
        expect(() => parseProtectionRecord('not json')).toThrow(ProtectionRecordFormatError)
        expect(() => parseProtectionRecord('')).toThrow(ProtectionRecordFormatError)
        expect(() => parseProtectionRecord('null')).toThrow(ProtectionRecordFormatError)
        expect(() => parseProtectionRecord('[]')).toThrow(ProtectionRecordFormatError)
        expect(problemOf('{"v":1}')).toBe('damaged')
        expect(problemOf('{"v":99}')).toBe('newer-version')
    })

    // The two problems get different advice: a damaged file wants a backup, a record from a
    // newer build wants this build updated. Telling someone to restore a backup over a perfectly
    // good record would be the very mistake this guards against.
    it('tells a record from a newer build apart from a damaged one', async () => {
        const { record } = await createProtectionRecord('correct horse', { ...fast(), m: 8 * 1024 })
        const withVersion = (v: unknown) => serialiseProtectionRecord({ ...record, v } as ProtectionRecord)

        expect(problemOf(withVersion(2))).toBe('newer-version')
        // A version nothing ever wrote is not "newer".
        expect(problemOf(withVersion(0))).toBe('damaged')
        expect(problemOf(withVersion('2'))).toBe('damaged')
        expect(problemOf(withVersion(1.5))).toBe('damaged')
    })

    it('validates an already-parsed value the same way, which is what a vault entry is', async () => {
        const { record } = await createProtectionRecord('correct horse', { ...fast(), m: 8 * 1024 })

        expect(validateProtectionRecord(JSON.parse(serialiseProtectionRecord(record)))).toEqual(record)
        expect(() => validateProtectionRecord({ ...record, v: 2 })).toThrow(ProtectionRecordFormatError)
        expect(() => validateProtectionRecord({ ...record, wrapped: 7 })).toThrow(ProtectionRecordFormatError)
        expect(() => validateProtectionRecord(undefined)).toThrow(ProtectionRecordFormatError)
    })
})

/** Which problem the parser found, or null when the text is a usable record. */
function problemOf(text: string): ProtectionRecordProblem | null {
    try {
        parseProtectionRecord(text)
        return null
    } catch (error) {
        if (error instanceof ProtectionRecordFormatError) return error.problem
        throw error
    }
}

describe('default cost parameters', () => {
    // Pure-JS Argon2id makes RFC 9106's 64 MiB / t=3 a multi-second unlock on a phone. These are
    // OWASP's Argon2id minimum, and they are stored per record so they can be raised later
    // without breaking graphs already written.
    it('are OWASP’s Argon2id minimum', () => {
        expect(DEFAULT_KDF_PARAMS).toMatchObject({ m: 19456, t: 2, p: 1 })
    })

    it('mint a fresh salt each time', () => {
        expect(newKdfParams().salt).not.toBe(newKdfParams().salt)
    })
})

describe('bounding a record\'s KDF parameters', () => {
    // Refused as a damaged record - present, and not to be replaced - never as an absent one:
    // a record whose parameters this build will not run is still the record.
    it('refuses degenerate or absurd parameters, so a hostile file cannot pick them', async () => {
        const { record } = await createProtectionRecord('pw', { m: 8 * 1024, t: 1, p: 1, salt: toBase64Url(new Uint8Array(16)) })
        const withKdf = (kdf: Partial<typeof record.kdf>) =>
            problemOf(serialiseProtectionRecord({ ...record, kdf: { ...record.kdf, ...kdf } }))
        expect(withKdf({})).toBeNull()
        expect(withKdf({ m: 64 })).toBe('damaged') // 64 KiB: a passphrase wrap anyone can brute-force
        expect(withKdf({ m: 4 * 1024 * 1024 })).toBe('damaged') // 4 GiB: pins the tab
        expect(withKdf({ t: 0 })).toBe('damaged')
        expect(withKdf({ p: 0 })).toBe('damaged')
        expect(withKdf({ p: 1.5 })).toBe('damaged')
        expect(withKdf({ salt: toBase64Url(new Uint8Array(4)) })).toBe('damaged')
        expect(withKdf({ salt: '***' })).toBe('damaged')
    })
})
