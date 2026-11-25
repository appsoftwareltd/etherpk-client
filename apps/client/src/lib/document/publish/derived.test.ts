import { describe, expect, it } from 'vitest'

import { llmsTxt } from './derived'

describe('llmsTxt', () => {
    it('writes the site name, then each section as a heading over one link a line', () => {
        const text = llmsTxt('https://garden.example.com', 'Garden Notes', [
            { title: 'Pages', entries: [{ title: 'Welcome', url: 'index.html', description: 'Where to start.' }] },
            {
                title: 'Beds',
                entries: [
                    { title: 'Beans', url: 'beans.html', description: 'Sow in May.' },
                    { title: 'Carrots', url: 'carrots.html', description: '' },
                ],
            },
        ])
        expect(text).toBe(
            [
                '# Garden Notes',
                '',
                '## Pages',
                '',
                '- [Welcome](https://garden.example.com/index.html): Where to start.',
                '',
                '## Beds',
                '',
                '- [Beans](https://garden.example.com/beans.html): Sow in May.',
                '- [Carrots](https://garden.example.com/carrots.html)',
                '',
            ].join('\n'),
        )
    })

    it('leaves out a section with nothing in it', () => {
        const text = llmsTxt('https://garden.example.com', 'Garden Notes', [
            { title: 'Pages', entries: [] },
            { title: 'Posts', entries: [{ title: 'Spring', url: 'spring.html', description: '' }] },
        ])
        expect(text).not.toContain('## Pages')
        expect(text).toContain('## Posts')
    })

    // A title is link text and a heading is one line: a bracket or a line break in either would
    // end the link or the heading early for whatever reads the file.
    it('keeps a title with brackets and a description with line breaks on one line', () => {
        const text = llmsTxt('https://garden.example.com', 'Garden\nNotes', [
            { title: 'Beds\n#1', entries: [{ title: 'Beans [early]', url: 'beans.html', description: 'Sow in May.\nWater  well.' }] },
        ])
        expect(text).toContain('# Garden Notes\n')
        expect(text).toContain('## Beds #1\n')
        expect(text).toContain('- [Beans \\[early\\]](https://garden.example.com/beans.html): Sow in May. Water well.\n')
    })
})
