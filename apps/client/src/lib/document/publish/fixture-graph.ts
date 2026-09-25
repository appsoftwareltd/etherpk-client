/**
 * A fixture knowledge graph for the publisher's tests: every construct the renderer handles,
 * a private document, a protected document, a document public elsewhere, includes, an asset
 * that exists and one that does not. Shared by the orchestrator test and the per-theme check
 * so both render the same graph.
 */

import type { PublishDocument, PublishSource } from './types'

function page(concept: string, text: string, aliases: string[] = []): PublishDocument {
    return { concept, kind: 'page', text, aliases }
}
function journal(day: string, text: string): PublishDocument {
    return { concept: day, kind: 'journal', text, aliases: [] }
}

export const SECRET_BODY = 'private-body-marker-7f3a'
export const CIPHER_TEXT = 'AQQAAAGYcipher-marker-9b2c'

export const documents: PublishDocument[] = [
    page(
        'Docs Site',
        [
            '---',
            'publication:',
            '  id: docs',
            '  home: Welcome',
            '  url: https://docs.example.com/',
            '  includes:',
            '    footer: Site Footer',
            '    styles: Site Styles',
            '    head: Private Head',
            '    banner: Site Footer',
            '---',
            '- [[Welcome]]',
            '- [[Guide]]',
            '  - [[[[Guide]] Advanced]]',
            '- Reference',
            '  - [[Physics]]',
            '- [Source](https://example.com/src)',
            '',
        ].join('\n'),
    ),
    page('Blog', '---\npublication:\n  id: blog\n  kind: blog\n---\n- [[Release Notes]]\n'),
    page('Welcome', '---\npublic: true\npublications: [docs]\n---\n- Welcome to the docs. See [[Guide]].\n'),
    page(
        'Guide',
        [
            '---',
            'public: true',
            'publications: [docs]',
            'date: 2026-06-01',
            '---',
            '## Setup',
            '',
            '- [ ] #P1 #D-2026-07-01 Install [[Phys]] and read [[[[Guide]] Advanced]]',
            '- Links: [[Secret]], [[Release Notes]], [[Nowhere]]',
            '- Maths $E = mc^2$ and ==marked==',
            '',
            '![Chart|300](../assets/chart.png)',
            '',
            '![Gone](../assets/gone.png)',
            '',
            '```mermaid',
            'graph TD; A-->B;',
            '```',
            '',
            '```js',
            'const x = 1',
            '```',
            '',
        ].join('\n'),
    ),
    page('[[Guide]] Advanced', '---\npublic: true\npublications: [docs]\n---\n- advanced, back to [[Guide]]\n'),
    page('Physics', '---\npublic: true\npublications: [docs]\naliases: [Phys]\n---\n- physics\n', ['Phys']),
    page('Secret', `- ${SECRET_BODY} [[Guide]]\n`),
    page('Protected Doc', `---\npublic: true\npublications: [docs]\n---\n\`\`\`etherpk-cipher\n${CIPHER_TEXT}\n\`\`\`\n`),
    page('Release Notes', '---\npublic: true\npublications: [blog]\n---\n- notes\n'),
    page('Site Footer', '---\npublic: true\npublications: [docs]\n---\n© {{site.year}} [[Welcome]] · [[Secret]] · <script src="https://plausible.io/js/script.js"></script>\n'),
    page('Site Styles', '---\npublic: true\npublications: [docs]\n---\n```css\nbody { color: red }\n```\n'),
    // Named as the docs head include but never marked public: the theme's own head stands in.
    page('Private Head', '<meta name="robots" content="noindex">\n'),
    journal('2026-06-02', '---\npublic: true\npublications: [docs]\n---\n- day one, see [[Guide]]\n'),
]

export const source: PublishSource = {
    documents,
    async readAsset(ref) {
        if (ref === '../assets/chart.png') return { bytes: new Uint8Array([1, 2, 3]), name: 'chart.png', type: 'image/png' }
        return null
    },
}
