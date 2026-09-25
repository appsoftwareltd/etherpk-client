/**
 * A small knowledge graph the Theme editor previews a theme over when no publication of the
 * user's graph uses it yet (ADR 0082): every construct the renderer handles, so a theme author
 * sees tasks, maths, a diagram, code, a scoped concept, a journal entry and linked references
 * without first writing any. Shipped, not a test fixture, so its text reads like a real site.
 */

import type { Publication, PublishDocument, PublishSource } from './types'

function page(concept: string, text: string, aliases: string[] = []): PublishDocument {
    return { concept, kind: 'page', text, aliases }
}

export const SAMPLE_PUBLICATION: Publication = {
    id: 'sample',
    name: 'Sample Site',
    concept: 'Sample Site',
    kind: 'docs',
    selection: 'all-public',
    home: 'Welcome',
    url: 'https://example.com',
    theme: 'etherpk-docs',
    recent: 10,
    includes: {},
    outline: '- [[Welcome]]\n- [[Getting Started]]\n  - [[[[Getting Started]] Installing]]\n- Reference\n  - [[Wikilinks]]\n- [Source](https://github.com/appsoftwareltd/etherpk)\n',
}

export const SAMPLE_DOCUMENTS: PublishDocument[] = [
    page('Sample Site', SAMPLE_PUBLICATION.outline),
    page(
        'Welcome',
        [
            '---',
            'public: true',
            '---',
            '- This is a sample site, rendered so you can see the theme with real content.',
            '- Every published page can link to another: [[Getting Started]], or to a concept that is not on the site, like [[Private Notes]].',
            '- A journal entry looks like [[2026-06-02]].',
            '',
        ].join('\n'),
    ),
    page(
        'Getting Started',
        [
            '---',
            'public: true',
            'date: 2026-06-01',
            '---',
            '## Setting up',
            '',
            '- [ ] #P1 #D-2026-07-01 Install EtherPK and read [[[[Getting Started]] Installing]]',
            '- [x] #C-2026-05-30 Decide what to publish',
            '- Inline maths $E = mc^2$, a ==highlight==, and `inline code`.',
            '',
            '```mermaid',
            'graph TD; Notes-->Publish; Publish-->Site;',
            '```',
            '',
            '```js',
            'const site = publish(graph) // highlighted with the editor\'s grammars',
            '```',
            '',
            '## A table',
            '',
            '| Key | Meaning |',
            '| --- | --- |',
            '| `public` | may be published |',
            '| `publications` | which sites |',
            '',
        ].join('\n'),
    ),
    page('[[Getting Started]] Installing', '---\npublic: true\n---\n- A scoped concept: its heading links to its scope. Back to [[Getting Started]].\n'),
    page('Wikilinks', '---\npublic: true\naliases: [Links]\n---\n- `[[Concept]]` links to a page; an alias like [[Links]] resolves to this one.\n', ['Links']),
    page('Private Notes', '- Not public, so never on the site; links to it are styled as missing.\n'),
    { concept: '2026-06-02', kind: 'journal', text: '---\npublic: true\n---\n- Wrote the [[Getting Started]] guide.\n', aliases: [] },
]

export const SAMPLE_SOURCE: PublishSource = {
    documents: SAMPLE_DOCUMENTS,
    readAsset: async () => null,
}
