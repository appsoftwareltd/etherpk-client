import { describe, expect, it } from 'vitest'

import { ebookHostPolicy, ebookReaderPolicy } from './ebook-frame-policy'

function directives(policy: string) {
    return new Map(
        policy.split('; ').map((directive) => {
            const [name, ...values] = directive.split(' ')
            return [name, values] as const
        }),
    )
}

describe.each([
    ['the host', ebookHostPolicy('abc=')],
    ['the reader', ebookReaderPolicy('abc=')],
])('the policy of %s', (_name, policy) => {
    const parsed = directives(policy)

    it('allows the bundle alone to run, so no script in an EBook can', () => {
        expect(parsed.get('script-src')).toEqual(["'sha256-abc='"])
    })

    it('reaches no network from anything in the page', () => {
        expect(parsed.get('default-src')).toEqual(["'none'"])
        for (const [name, values] of parsed) {
            if (name !== 'frame-ancestors') expect(values.join(' ')).not.toMatch(/https?:|\*|'self'/)
        }
    })

    it('has no sandbox, which would pass down and split the origin of every frame inside', () => {
        expect(parsed.has('sandbox')).toBe(false)
    })
})

describe('the host page', () => {
    it('can be framed by the app alone', () => {
        expect(directives(ebookHostPolicy('abc=')).get('frame-ancestors')).toEqual(["'self'"])
    })
})
