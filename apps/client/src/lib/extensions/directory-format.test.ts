import { describe, expect, it } from 'vitest'

import { isHttpsAddress, parseDirectoryListing } from './directory-format'

// The Extension Directory's list as the Client reads it. Every name here is invented.

const integrity = `sha512-${'A'.repeat(86)}==`

function entry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'garden',
        displayName: 'Garden',
        publisher: 'example',
        description: 'Beds and paths.',
        repository: 'https://example.com/source/garden',
        license: 'MIT',
        package: '@example/etherpk-extension-garden',
        releases: [{ version: '1.0.0', integrity, minClientVersion: '0.9.0' }],
        ...overrides,
    }
}

describe('the Extension Directory list', () => {
    it('reads a list of extensions and their releases', () => {
        const parsed = parseDirectoryListing({ version: 1, extensions: [entry()] })
        expect(parsed).toMatchObject({ ok: true, listing: { extensions: [{ id: 'garden' }] } })
    })

    it.each(['http://example.com/source/garden', 'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.com/garden'])('takes a source address only over https, not %s', (repository) => {
        expect(parseDirectoryListing({ version: 1, extensions: [entry({ repository })] })).toMatchObject({ ok: false, error: expect.stringMatching(/repository/) })
    })

    it('refuses a list that names one extension twice', () => {
        const parsed = parseDirectoryListing({ version: 1, extensions: [entry(), entry({ displayName: 'Garden again' })] })
        expect(parsed).toEqual({ ok: false, error: 'not an Extension Directory list (the extension "garden" is listed twice)' })
    })
})

describe('a source address Settings links to', () => {
    it('is an https address', () => {
        expect(isHttpsAddress('https://example.com/source/garden')).toBe(true)
    })

    it.each(['http://example.com/source/garden', 'javascript:alert(1)', 'data:text/html,hello', 'garden', ''])('is not %s', (address) => {
        expect(isHttpsAddress(address)).toBe(false)
    })
})
