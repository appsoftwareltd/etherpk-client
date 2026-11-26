import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareVersions, FeedError, newerRelease, publicKeyFromSeed, readFeed, signFeed } from './feed.ts'
import { feedVectors } from './feed.vectors.ts'

const FILE = fileURLToPath(new URL('../../../../packages/native-bridge/test-vectors/update-feed.json', import.meta.url))
const vectors = feedVectors()
const runs = { seed: 20261125, numRuns: Number(process.env.FEED_FUZZ_RUNS ?? 400) }

function outcomeOf(feed: string, highestSequence: number, now: string): string {
    try {
        readFeed(feed, { keys: vectors.keys, highestSequence, now: Date.parse(now) })
        return 'ok'
    } catch (error) {
        if (error instanceof FeedError) return error.problem
        throw error
    }
}

describe('the test vectors', () => {
    it('are the file every shell reads', () => {
        const text = `${JSON.stringify(vectors, null, 4)}\n`
        if (process.env.UPDATE_VECTORS) {
            mkdirSync(dirname(FILE), { recursive: true })
            writeFileSync(FILE, text)
        }
        expect(existsSync(FILE) && readFileSync(FILE, 'utf8'), 'Run this test with UPDATE_VECTORS=1, and tell whoever keeps the Android reader.').toBe(text)
    })
    for (const { name, feed, highestSequence, now, outcome } of vectors.cases) {
        it(`${name}: ${outcome}`, () => expect(outcomeOf(feed, highestSequence, now)).toBe(outcome))
    }
})

describe('properties', () => {
    const seed = Buffer.alloc(32, 7)
    const keys = [{ id: 'k', publicKey: publicKeyFromSeed(seed) }]
    const read = { keys, highestSequence: 1, now: 0 }
    const feed = signFeed(Buffer.from(JSON.stringify(vectors.payload)), [{ id: 'k', seed }])

    it('any altered byte of the payload or the signature is refused', () => {
        const envelope = JSON.parse(feed) as { payload: string; signatures: { key: string; signature: string }[] }
        fc.assert(fc.property(fc.boolean(), fc.nat(), fc.integer({ min: 1, max: 255 }), (inPayload, at, change) => {
            const bytes = Buffer.from(inPayload ? envelope.payload : envelope.signatures[0].signature, 'base64')
            bytes[at % bytes.length] ^= change
            const altered = inPayload
                ? { ...envelope, payload: bytes.toString('base64') }
                : { ...envelope, signatures: [{ key: 'k', signature: bytes.toString('base64') }] }
            expect(() => readFeed(JSON.stringify(altered), read)).toThrow(FeedError)
        }), runs)
    })
    it('any altered byte of the file is refused, or changes nothing that is read', () => {
        fc.assert(fc.property(fc.nat(), fc.integer({ min: 1, max: 255 }), (at, change) => {
            const bytes = Buffer.from(feed)
            bytes[at % bytes.length] ^= change
            let payload
            try {
                payload = readFeed(bytes.toString('utf8'), read)
            } catch (error) {
                expect(error).toBeInstanceOf(FeedError)
                return
            }
            expect(payload).toEqual(vectors.payload)
        }), runs)
    })
    it('bytes added to or taken from the payload are refused', () => {
        const envelope = JSON.parse(feed) as { payload: string }
        fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 8 }), fc.boolean(), (bytes, add) => {
            const payload = Buffer.from(envelope.payload, 'base64')
            const changed = add ? Buffer.concat([payload, bytes]) : payload.subarray(bytes.length)
            expect(() => readFeed(JSON.stringify({ ...envelope, payload: changed.toString('base64') }), read)).toThrow(FeedError)
        }), runs)
    })
    it('a feed is taken exactly when its sequence is not lower and it has not expired', () => {
        fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.nat(1000), fc.integer({ min: -5, max: 5 }), (sequence, highestSequence, minutes) => {
            const expires = new Date(1_900_000_000_000).toISOString()
            const text = signFeed(Buffer.from(JSON.stringify({ ...vectors.payload, sequence, expires })), [{ id: 'k', seed }])
            const now = Date.parse(expires) + minutes * 60_000
            const taken = () => readFeed(text, { keys, highestSequence, now })
            if (sequence >= highestSequence && now < Date.parse(expires)) expect(taken().sequence).toBe(sequence)
            else expect(taken).toThrow(FeedError)
        }), runs)
    })
    it('versions are ordered as numbers', () => {
        const version = fc.tuple(fc.nat(30), fc.nat(30), fc.nat(30))
        fc.assert(fc.property(version, version, (a, b) => {
            const expected = a[0] * 10_000 + a[1] * 100 + a[2] - (b[0] * 10_000 + b[1] * 100 + b[2])
            expect(Math.sign(compareVersions(a.join('.'), b.join('.')))).toBe(Math.sign(expected))
        }), runs)
    })
    it('nothing but a newer version is ever offered', () => {
        expect(newerRelease(vectors.payload, 'stable', 'windows-x64', '1.1.9')?.version).toBe('1.2.0')
        for (const current of ['1.2.0', '1.10.0', '2.0.0']) expect(newerRelease(vectors.payload, 'stable', 'windows-x64', current)).toBe(null)
        for (const key of ['__proto__', 'constructor', 'toString', 'none']) {
            expect(newerRelease(vectors.payload, key, 'windows-x64', '0.0.1')).toBe(null)
            expect(newerRelease(vectors.payload, 'stable', key, '0.0.1')).toBe(null)
        }
    })
    it('an app with no keys takes no feed', () => {
        expect(() => readFeed(feed, { ...read, keys: [] })).toThrow('No key')
    })
})
