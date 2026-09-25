import { describe, expect, it } from 'vitest'

import { randomBytes, toBase64Url } from './bytes'
import {
    PROTECTION_HEADER_LENGTH,
    ProtectionError,
    armourProtected,
    keyFingerprint,
    openProtected,
    protectedEnvelopeFingerprint,
    protectedEnvelopeWrittenAt,
    resolveLastWriteWins,
    sealProtected,
    splitProtectedEnvelopes,
    unarmourProtected,
} from './protection'

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

async function seal(text: string, opts: { key?: Uint8Array; writtenAt?: number } = {}): Promise<Uint8Array> {
    const key = opts.key ?? KEY
    return sealProtected({
        key,
        fingerprint: await keyFingerprint(key),
        plaintext: text,
        writtenAt: opts.writtenAt ?? 1_757_000_000_000,
    })
}

describe('key fingerprint', () => {
    it('is stable for one key and differs between keys', async () => {
        const a = await keyFingerprint(KEY)
        const b = await keyFingerprint(OTHER_KEY)

        expect(toBase64Url(a)).toBe(toBase64Url(await keyFingerprint(KEY)))
        expect(toBase64Url(a)).not.toBe(toBase64Url(b))
    })

    it('is short enough to sit in a header and long enough not to collide', async () => {
        expect((await keyFingerprint(KEY)).length).toBe(8)
    })
})

describe('sealing and opening', () => {
    it('round-trips plaintext', async () => {
        const opened = await openProtected({ key: KEY, envelope: await seal('hunter2') })

        expect(opened.plaintext).toBe('hunter2')
        expect(opened.writtenAt).toBe(1_757_000_000_000)
    })

    it('round-trips content far larger than a u16 length prefix could hold', async () => {
        const big = 'x'.repeat(100_000)

        expect((await openProtected({ key: KEY, envelope: await seal(big) })).plaintext).toBe(big)
    })

    it('refuses a different key', async () => {
        await expect(openProtected({ key: OTHER_KEY, envelope: await seal('hunter2') })).rejects.toThrow(ProtectionError)
    })
})

describe('reading a sealed envelope without the key', () => {
    it('exposes the fingerprint, so a client can tell whose content this is', async () => {
        const envelope = await seal('hunter2')

        expect(toBase64Url(protectedEnvelopeFingerprint(envelope))).toBe(toBase64Url(await keyFingerprint(KEY)))
    })

    it('exposes the write timestamp, so last-write-wins needs no key', async () => {
        expect(protectedEnvelopeWrittenAt(await seal('hunter2', { writtenAt: 42 }))).toBe(42)
    })

    it('rejects a truncated envelope rather than reading past the end', () => {
        expect(() => protectedEnvelopeFingerprint(new Uint8Array(PROTECTION_HEADER_LENGTH - 1))).toThrow(ProtectionError)
    })
})

describe('tamper resistance', () => {
    // A Player cannot read a protected fence but CAN write to the Y.Text holding it. Binding the
    // header into the AAD stops them bumping a stale envelope's timestamp to win last-write-wins.
    it('fails to open when the timestamp is edited', async () => {
        const envelope = await seal('hunter2')
        new DataView(envelope.buffer, envelope.byteOffset).setBigUint64(2, 9_999_999_999_999n, false)

        await expect(openProtected({ key: KEY, envelope })).rejects.toThrow(ProtectionError)
    })

    it('fails to open when the fingerprint is edited', async () => {
        const envelope = await seal('hunter2')
        envelope[10] ^= 0xff

        await expect(openProtected({ key: KEY, envelope })).rejects.toThrow(ProtectionError)
    })
})

describe('self-delimiting concatenation', () => {
    it('splits two envelopes that merged into one fence body', async () => {
        const first = await seal('one', { writtenAt: 100 })
        const second = await seal('two', { writtenAt: 200 })
        const joined = new Uint8Array(first.length + second.length)
        joined.set(first)
        joined.set(second, first.length)

        const parts = splitProtectedEnvelopes(joined)

        expect(parts).toHaveLength(2)
        expect(protectedEnvelopeWrittenAt(parts[0])).toBe(100)
        expect(protectedEnvelopeWrittenAt(parts[1])).toBe(200)
    })

    it('ignores trailing bytes that are not a whole envelope', async () => {
        const one = await seal('one')
        const joined = new Uint8Array(one.length + 3)
        joined.set(one)

        expect(splitProtectedEnvelopes(joined)).toHaveLength(1)
    })
})

describe('last-write-wins resolution (ADR 0028)', () => {
    it('keeps the newest envelope and discards the losers', async () => {
        const older = await seal('old', { writtenAt: 100 })
        const newer = await seal('new', { writtenAt: 200 })

        const winner = resolveLastWriteWins([older, newer])

        expect(protectedEnvelopeWrittenAt(winner!)).toBe(200)
    })

    it('is order-independent, so every client converges on the same envelope', async () => {
        const older = await seal('old', { writtenAt: 100 })
        const newer = await seal('new', { writtenAt: 200 })

        expect(resolveLastWriteWins([newer, older])).toBe(newer)
        expect(resolveLastWriteWins([older, newer])).toBe(newer)
    })

    it('breaks a timestamp tie by bytes, so two clients never disagree', async () => {
        const a = await seal('a', { writtenAt: 100 })
        const b = await seal('b', { writtenAt: 100 })

        expect(resolveLastWriteWins([a, b])).toBe(resolveLastWriteWins([b, a]))
    })

    it('returns null for an empty set', () => {
        expect(resolveLastWriteWins([])).toBeNull()
    })
})

describe('armouring for the fence body', () => {
    it('round-trips through base64url with no characters a fence could mistake for a closer', async () => {
        const envelope = await seal('hunter2')
        const armoured = armourProtected(envelope)

        expect(armoured).not.toContain('`')
        expect(armoured).not.toContain('\n')
        expect(toBase64Url(unarmourProtected(armoured)[0])).toBe(toBase64Url(envelope))
    })

    it('reads one envelope per line, which is how a merged fence body arrives', async () => {
        const first = armourProtected(await seal('one', { writtenAt: 100 }))
        const second = armourProtected(await seal('two', { writtenAt: 200 }))

        expect(unarmourProtected(`${first}\n${second}`)).toHaveLength(2)
    })

    it('skips blank and unreadable lines rather than throwing on a hand-mangled fence', async () => {
        const good = armourProtected(await seal('one'))

        expect(unarmourProtected(`\n${good}\n!!!not base64!!!\n`)).toHaveLength(1)
    })

    it('recovers envelopes that a merge concatenated onto one line', async () => {
        const first = await seal('one', { writtenAt: 100 })
        const second = await seal('two', { writtenAt: 200 })
        const joined = new Uint8Array(first.length + second.length)
        joined.set(first)
        joined.set(second, first.length)

        expect(unarmourProtected(armourProtected(joined))).toHaveLength(2)
    })
})

describe('a fresh key', () => {
    it('is 32 random bytes, so two graphs never share one', () => {
        expect(toBase64Url(randomBytes(32))).not.toBe(toBase64Url(randomBytes(32)))
    })
})
