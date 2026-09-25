import { describe, expect, it } from 'vitest'
import { bytesEqual, concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8 } from './bytes'

describe('bytes', () => {
    it('utf8 encodes', () => {
        expect([...utf8('ab')]).toEqual([97, 98])
    })
    it('concat + equal', () => {
        const joined = concatBytes(new Uint8Array([1]), new Uint8Array([]), new Uint8Array([2, 3]))
        expect([...joined]).toEqual([1, 2, 3])
        expect(bytesEqual(joined, new Uint8Array([1, 2, 3]))).toBe(true)
        expect(bytesEqual(joined, new Uint8Array([1, 2, 4]))).toBe(false)
        expect(bytesEqual(joined, new Uint8Array([1, 2]))).toBe(false)
    })
    it('base64url round-trips, unpadded, url-safe', () => {
        const bytes = new Uint8Array([251, 239, 190, 0, 1, 62]) // encodes to chars incl. - and _
        const text = toBase64Url(bytes)
        expect(text).not.toMatch(/[+/=]/)
        expect([...fromBase64Url(text)]).toEqual([...bytes])
    })
    it('randomBytes returns n distinct-enough bytes', () => {
        const a = randomBytes(32)
        expect(a).toHaveLength(32)
        expect(bytesEqual(a, randomBytes(32))).toBe(false)
    })
})
