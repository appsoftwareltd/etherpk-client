import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { sha1 } from './sha1'

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('SHA-1 for an EBook\'s obfuscated fonts', () => {
    it.each(['', 'abc', 'urn:uuid:garden-notes', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'tomatoes in the rain, ünïcödé'])('matches the platform on %j', (text) => {
        expect(hex(sha1(text))).toBe(createHash('sha1').update(text).digest('hex'))
    })
})
