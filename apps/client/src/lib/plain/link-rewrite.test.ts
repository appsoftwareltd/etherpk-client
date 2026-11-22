import { describe, expect, it } from 'vitest'

import { applyRewrites, describeRewrite, linkDestinations, pathAfter, planRewrites, rewriteLinks, rewriteQuestion } from './link-rewrite'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainFolderStore } from './plain-folder-store'

const utf8 = (text: string) => new TextEncoder().encode(text)

describe('the link destinations of a markdown text', () => {
    it('finds inline links, pictures and definitions, with where each is', () => {
        const text = 'See [soil](soil.md "Clay") and ![bed](<images/bed layout.png>).\n\n[pump]: ../manuals/pump.pdf\n'
        const found = linkDestinations(text)
        expect(found.map((span) => [span.href, span.angled])).toEqual([
            ['soil.md', false],
            ['images/bed layout.png', true],
            ['../manuals/pump.pdf', false],
        ])
        expect(text.slice(found[0].from, found[0].to)).toBe('soil.md')
        expect(text.slice(found[1].from, found[1].to)).toBe('<images/bed layout.png>')
    })

    it('leaves out code and the frontmatter', () => {
        const text = ['---', 'see: [x](front.md)', '---', 'Text `[a](code.md)` then [b](real.md).', '```', '[c](fenced.md)', '```'].join('\n')
        expect(linkDestinations(text).map((span) => span.href)).toEqual(['real.md'])
    })
})

describe('rewriting links after a move', () => {
    it('follows a file that moved, and a directory with what it holds', () => {
        expect(pathAfter('guide/soil.md', { from: 'guide/soil.md', to: 'notes/clay.md' })).toBe('notes/clay.md')
        expect(pathAfter('guide/images/bed.png', { from: 'guide', to: 'handbook' })).toBe('handbook/images/bed.png')
        expect(pathAfter('guidebook/a.md', { from: 'guide', to: 'handbook' })).toBe('guidebook/a.md')
    })

    it('points a link at the file’s new place, keeping its heading, title and form', () => {
        const move = { from: 'guide/soil.md', to: 'notes/clay soil.md' }
        const text = 'See [soil](soil.md#clay "Clay"), [again](<soil.md>) and [other](watering.md).'
        expect(rewriteLinks(text, 'guide/README.md', 'guide/README.md', move)).toEqual({
            text: 'See [soil](../notes/clay%20soil.md#clay "Clay"), [again](<../notes/clay soil.md>) and [other](watering.md).',
            changed: 2,
        })
    })

    it('mends the moved file’s own links, and leaves the ones that still work', () => {
        const move = { from: 'guide/soil.md', to: 'notes/soil.md' }
        const text = '[w](watering.md) [top](#clay) [web](https://example.com/a.md) ![bed](images/bed.png)'
        expect(rewriteLinks(text, 'guide/soil.md', 'notes/soil.md', move).text).toBe('[w](../guide/watering.md) [top](#clay) [web](https://example.com/a.md) ![bed](../guide/images/bed.png)')
        // Two files moved together keep the links between them as written.
        const together = { from: 'guide', to: 'handbook' }
        expect(rewriteLinks('[w](watering.md) [r](../README.md)', 'guide/soil.md', 'handbook/soil.md', together)).toEqual({ text: '[w](watering.md) [r](../README.md)', changed: 0 })
    })
})

describe('planning and applying a rewrite across the folder', () => {
    async function moved() {
        let t = 0
        const tree = createMemoryTreeAdapter({
            now: () => (t += 1000),
            seed: {
                'README.md': 'Start with [soil](guide/soil.md).\r\nThen [water](guide/watering.md).\r\n',
                'guide/watering.md': 'See [soil](soil.md).\n',
                'guide/soil.md': 'Back to [water](watering.md).\n',
                'notes/plain.md': 'No links here.\n',
            },
        })
        const store = createPlainFolderStore(tree, { autosaveMs: 400 })
        await tree.move('guide/soil.md', 'notes/clay.md')
        const move = { from: 'guide/soil.md', to: 'notes/clay.md' }
        const files = ['README.md', 'guide/watering.md', 'notes/clay.md', 'notes/plain.md']
        const text = async (path: string) => new TextDecoder().decode((await tree.read(path)).bytes)
        return { tree, store, move, files, text }
    }

    it('finds every file with a link the move broke, and no other', async () => {
        const { tree, files, move } = await moved()
        const plans = await planRewrites(tree, files, move)
        expect(plans?.map((plan) => [plan.path, plan.changed])).toEqual([
            ['README.md', 1],
            ['guide/watering.md', 1],
            ['notes/clay.md', 1],
        ])
    })

    it('writes the links, keeping each file’s line endings', async () => {
        const { tree, store, files, move, text } = await moved()
        const outcome = await applyRewrites(tree, store, (await planRewrites(tree, files, move))!)
        expect(outcome).toEqual({ written: ['README.md', 'guide/watering.md', 'notes/clay.md'], skipped: [] })
        expect(await text('README.md')).toBe('Start with [soil](notes/clay.md).\r\nThen [water](guide/watering.md).\r\n')
        expect(await text('guide/watering.md')).toBe('See [soil](../notes/clay.md).\n')
        expect(await text('notes/clay.md')).toBe('Back to [water](../guide/watering.md).\n')
    })

    it('leaves a file another program changed after the plan, and names it', async () => {
        const { tree, store, files, move, text } = await moved()
        const plans = (await planRewrites(tree, files, move))!
        await tree.write('README.md', utf8('Rewritten elsewhere, see [soil](guide/soil.md).\n'))
        const outcome = await applyRewrites(tree, store, plans)
        expect(outcome.skipped).toEqual(['README.md'])
        expect(await text('README.md')).toBe('Rewritten elsewhere, see [soil](guide/soil.md).\n')
        expect(outcome.written).toEqual(['guide/watering.md', 'notes/clay.md'])
    })

    it('changes a file open in a tab through its buffer, and leaves one with unsaved typing', async () => {
        const { tree, store, files, move, text } = await moved()
        const watering = store.open('guide/watering.md')
        const readme = store.open('README.md')
        await store.whenReady('guide/watering.md')
        await store.whenReady('README.md')
        const plans = (await planRewrites(tree, files, move))!
        readme.applyChange({ from: 0, to: 0, insert: 'Typing. ' })

        const outcome = await applyRewrites(tree, store, plans)
        expect(outcome.skipped).toEqual(['README.md'])
        expect(watering.getText()).toBe('See [soil](../notes/clay.md).\n')
        expect(await text('guide/watering.md')).toBe('See [soil](../notes/clay.md).\n')
        expect(readme.getText()).toContain('Typing. Start with [soil](guide/soil.md)')
    })
})

describe('what the person is told about a rewrite', () => {
    const plan = (path: string, changed: number) => ({ path, before: '', after: '', changed })

    it('asks with the number of links and files, in the singular for one', () => {
        expect(rewriteQuestion([plan('README.md', 1)])).toBe('1 link in 1 file no longer leads where it did. Update it to follow the move?')
        expect(rewriteQuestion([plan('README.md', 2), plan('guide/watering.md', 1)])).toBe('3 links in 2 files no longer lead where they did. Update them to follow the move?')
    })

    it('says what was written, and names each file left as it is', () => {
        const plans = [plan('README.md', 2), plan('guide/watering.md', 1)]
        expect(describeRewrite(plans, { written: ['README.md', 'guide/watering.md'], skipped: [] })).toBe('Updated 3 links in 2 files.')
        expect(describeRewrite(plans, { written: ['guide/watering.md'], skipped: ['README.md'] })).toBe('Updated 1 link in 1 file. Left as it is, because it changed meanwhile: README.md.')
        expect(describeRewrite(plans, { written: [], skipped: ['README.md', 'guide/watering.md'] })).toBe('No links were updated. Left as they are, because they changed meanwhile: README.md, guide/watering.md.')
    })
})
