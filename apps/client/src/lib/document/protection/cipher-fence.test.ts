import { describe, expect, it } from 'vitest'

import { armourProtected, keyFingerprint, sealProtected, toBase64Url } from '$lib/crypto'

import { CIPHER_FENCE_INFO, cipherFences, documentProtection, protectDocumentText, replaceCipherFenceBody, unprotectDocumentText } from './cipher-fence'

const KEY = new Uint8Array(32).fill(7)

async function armour(text: string, writtenAt = 1_757_000_000_000): Promise<string> {
    return armourProtected(
        await sealProtected({ key: KEY, fingerprint: await keyFingerprint(KEY), plaintext: text, writtenAt }),
    )
}

function fence(body: string, indent = ''): string {
    return [`${indent}\`\`\`${CIPHER_FENCE_INFO}`, `${indent}${body}`, `${indent}\`\`\``].join('\n')
}

describe('finding cipher fences', () => {
    it('finds a fence and reads its envelope without the key', async () => {
        const lines = fence(await armour('router password')).split('\n')

        const [found] = cipherFences(lines)

        expect(found.start).toBe(0)
        expect(found.end).toBe(2)
        expect(found.envelopes).toHaveLength(1)
        expect(toBase64Url(found.fingerprint!)).toBe(toBase64Url(await keyFingerprint(KEY)))
        expect(found.writtenAt).toBe(1_757_000_000_000)
    })

    it('ignores ordinary fences', () => {
        expect(cipherFences(['```typescript', 'const a = 1', '```'])).toHaveLength(0)
    })

    it('ignores an unterminated cipher fence, exactly as every other fence rule does', async () => {
        expect(cipherFences([`\`\`\`${CIPHER_FENCE_INFO}`, await armour('secret')])).toHaveLength(0)
    })

    it('finds a fence nested inside an outliner block at its content column', async () => {
        const lines = ['- a bullet', ...fence(await armour('secret'), '  ').split('\n')]

        const [found] = cipherFences(lines)

        expect(found.start).toBe(1)
        expect(found.fenceColumn).toBe(2)
    })

    it('reports a body it cannot read at all rather than pretending the fence is absent', () => {
        const [found] = cipherFences(fence('not an envelope').split('\n'))

        expect(found.envelopes).toHaveLength(0)
        expect(found.winner).toBeNull()
        expect(found.fingerprint).toBeNull()
    })
})

describe('last-write-wins inside one fence (ADR 0028)', () => {
    it('picks the newest of two envelopes a merge left side by side', async () => {
        const body = [await armour('older', 100), await armour('newer', 200)].join('\n')

        const [found] = cipherFences(fence(body).split('\n'))

        expect(found.envelopes).toHaveLength(2)
        expect(found.writtenAt).toBe(200)
        expect(found.needsCollapse).toBe(true)
    })

    it('does not ask for a collapse when the fence already holds one envelope', async () => {
        const [found] = cipherFences(fence(await armour('only')).split('\n'))

        expect(found.needsCollapse).toBe(false)
    })
})

describe('classifying a document', () => {
    it('calls a document protected when its whole body is one cipher fence', async () => {
        const text = fence(await armour('secret'))

        expect(documentProtection(text).kind).toBe('document')
    })

    it('keeps frontmatter cleartext above the fence, so the concept stays resolvable', async () => {
        const text = ['---', 'title: Bank', 'aliases: [Money]', '---', fence(await armour('secret'))].join('\n')

        const protection = documentProtection(text)

        expect(protection.kind).toBe('document')
        expect(text).toContain('title: Bank')
    })

    it('calls a document with a fence among prose block-protected, not document-protected', async () => {
        const text = ['# Notes', '', fence(await armour('secret')), '', 'more prose'].join('\n')

        expect(documentProtection(text).kind).toBe('none')
    })

    it('calls a document with no cipher fence unprotected', () => {
        expect(documentProtection('# Just notes').kind).toBe('none')
    })

    // One index base everywhere. cipherFences and protectedRanges both measure from the whole
    // document, so documentProtection must too — otherwise a caller matching a fence up with an
    // editor offset silently lands on the wrong lines whenever the document has Frontmatter.
    it('reports line indices measured from the whole document, not from below the frontmatter', async () => {
        const text = ['---', 'title: Bank', '---', fence(await armour('secret'))].join('\n')

        const [found] = documentProtection(text).fences

        expect(text.split('\n')[found.start]).toBe(`\`\`\`${CIPHER_FENCE_INFO}`)
        expect(text.split('\n')[found.end]).toBe('```')
    })

    it('exposes the fingerprint so a caller can tell whose key this needs', async () => {
        const protection = documentProtection(fence(await armour('secret')))

        expect(toBase64Url(protection.fingerprints[0])).toBe(toBase64Url(await keyFingerprint(KEY)))
    })
})

describe('writing a protected document', () => {
    it('replaces the whole body with one fence and leaves frontmatter alone', async () => {
        const original = ['---', 'title: Bank', '---', '# Secrets', 'sort code 00-00-00'].join('\n')

        const text = protectDocumentText(original, await armour('# Secrets\nsort code 00-00-00'))

        expect(text.startsWith('---\ntitle: Bank\n---\n')).toBe(true)
        expect(text).not.toContain('sort code')
        expect(documentProtection(text).kind).toBe('document')
    })

    it('round-trips: unprotecting restores the plaintext body under the same frontmatter', async () => {
        const original = ['---', 'title: Bank', '---', '# Secrets', 'sort code 00-00-00'].join('\n')

        const protectedText = protectDocumentText(original, await armour('# Secrets\nsort code 00-00-00'))
        const restored = unprotectDocumentText(protectedText, '# Secrets\nsort code 00-00-00')

        expect(restored).toBe(original)
    })

    it('protects a document that has no frontmatter', async () => {
        const text = protectDocumentText('# Secrets', await armour('# Secrets'))

        expect(documentProtection(text).kind).toBe('document')
        expect(text.startsWith('```')).toBe(true)
    })
})

describe('rewriting a fence body as one delete plus one insert (ADR 0028)', () => {
    it('replaces only the body lines, leaving the fence lines untouched', async () => {
        const lines = fence(await armour('old')).split('\n')
        const [found] = cipherFences(lines)

        const edit = replaceCipherFenceBody(found, await armour('new', 200))

        expect(edit.fromLine).toBe(1)
        expect(edit.toLine).toBe(1)
        expect(edit.text.split('\n')).toHaveLength(1)
    })

    it('collapses a merged fence back to one envelope, discarding the loser', async () => {
        const body = [await armour('older', 100), await armour('newer', 200)].join('\n')
        const lines = fence(body).split('\n')
        const [found] = cipherFences(lines)

        const edit = replaceCipherFenceBody(found, armourProtected(found.winner!))
        const collapsed = [...lines.slice(0, edit.fromLine), edit.text, ...lines.slice(edit.toLine + 1)]

        expect(cipherFences(collapsed)[0].envelopes).toHaveLength(1)
        expect(cipherFences(collapsed)[0].writtenAt).toBe(200)
    })

    it('clamps the replacement to the fence column, so a nested fence stays valid markdown', async () => {
        const lines = ['- a bullet', ...fence(await armour('old'), '  ').split('\n')]
        const [found] = cipherFences(lines)

        const edit = replaceCipherFenceBody(found, await armour('new', 200))

        expect(edit.text.startsWith('  ')).toBe(true)
    })
})


