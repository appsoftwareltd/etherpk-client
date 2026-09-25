import { describe, expect, it } from 'vitest'

import { createPublicationResolver, titleText } from './resolve'
import type { PublishDocument } from './types'

function page(concept: string, text: string, aliases: string[] = []): PublishDocument {
    return { concept, kind: 'page', text, aliases }
}

const physics = page('Physics', '---\npublic: true\naliases: [Phys]\n---\n- see [[[[Physics]] Waves]]\n', ['Phys'])
const waves = page('[[Physics]] Waves', '---\npublic: true\n---\n- waves\n')
const secret = page('Secret', '- private\n')
const elsewhere = page('Release Notes', '---\npublic: true\npublications: [blog]\n---\n- notes\n')

const resolver = createPublicationResolver({
    included: [physics, waves],
    allDocuments: [physics, waves, secret, elsewhere],
    slugs: new Map([
        ['physics', 'physics'],
        ['[[physics]] waves', 'physics-waves'],
    ]),
    publishedElsewhere: new Map([['release notes', ['blog']]]),
})

describe('createPublicationResolver', () => {
    it('resolves a concept in the publication to its slug, case-insensitively', () => {
        expect(resolver.resolve('physics')).toEqual({ href: 'physics.html', missing: false, canonical: 'Physics', status: 'published' })
    })

    it('folds an alias into its page', () => {
        expect(resolver.resolve('Phys').href).toBe('physics.html')
    })

    it('a document public in another publication is missing here, and says so', () => {
        expect(resolver.resolve('Release Notes')).toMatchObject({ href: '404.html', missing: true, status: 'elsewhere', publishedIn: ['blog'] })
    })

    it('a private document and a concept with no page are both missing, distinguishably', () => {
        expect(resolver.resolve('Secret')).toMatchObject({ href: '404.html', missing: true, status: 'private' })
        expect(resolver.resolve('Nowhere')).toMatchObject({ href: '404.html', missing: true, status: 'missing' })
    })

    it('renders a scoped concept name as chained anchors, each segment resolving on its own', () => {
        expect(resolver.titleHtml('[[Physics]] Waves')).toBe(
            '<a href="physics.html" class="wikilink">Physics</a><a href="physics-waves.html" class="wikilink"> Waves</a>',
        )
        expect(resolver.titleHtml('Physics')).toBe('Physics')
    })

    it('a missing scope is marked missing inside the chain', () => {
        expect(resolver.titleHtml('[[Secret]] Plans')).toBe(
            '<a href="404.html" class="wikilink-missing">Secret</a><a href="404.html" class="wikilink-missing"> Plans</a>',
        )
    })

    it('escapes a plain name it hands back as HTML', () => {
        expect(resolver.titleHtml('A <b> & B')).toBe('A &lt;b&gt; &amp; B')
    })
})

describe('titleText', () => {
    it('strips the brackets and keeps the words, as as-notes does', () => {
        expect(titleText('[[Physics]] Quantum Mechanics')).toBe('Physics Quantum Mechanics')
        expect(titleText('[[[[Physics]] Quantum Mechanics]] Entanglement')).toBe('Physics Quantum Mechanics Entanglement')
        expect(titleText('Plain')).toBe('Plain')
    })
})
