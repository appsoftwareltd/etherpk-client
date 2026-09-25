import { describe, expect, it } from 'vitest'

import { ancestorChain, deriveDoc, deriveTitleLinks } from './index-derive'
import { isScopedBy } from './wikilink/rename'

describe('deriveDoc', () => {
    it('flattens the block tree into rows with parentage and order', () => {
        const { blocks } = deriveDoc('# A\n- one\n  - two')
        expect(blocks.map((b) => [b.kind, b.parentId, b.ord])).toEqual([
            ['heading', null, 0],
            ['bullet', 0, 0],
            ['bullet', 1, 0],
        ])
    })

    it('strips markers for the breadcrumb label', () => {
        const { blocks } = deriveDoc('# Heading\n- [ ] a task\n- plain')
        expect(blocks.map((b) => b.label)).toEqual(['Heading', 'a task', 'plain'])
    })

    it('tags each wikilink with its containing block', () => {
        const { blocks, links } = deriveDoc('## Tasks\n- see [[Project]]\n  - and [[Detail]]')
        const project = links.find((l) => l.concept === 'Project')!
        const detail = links.find((l) => l.concept === 'Detail')!
        expect(ancestorChain(blocks, project.blockLocalId)).toEqual(['Tasks', 'see [[Project]]'])
        expect(ancestorChain(blocks, detail.blockLocalId)).toEqual([
            'Tasks',
            'see [[Project]]',
            'and [[Detail]]',
        ])
    })

    it('derives tasks with completion state', () => {
        const { tasks } = deriveDoc('- [ ] todo\n- [x] done\n- not a task')
        expect(tasks).toMatchObject([
            { blockLocalId: 0, done: false, text: 'todo', line: 0 },
            { blockLocalId: 1, done: true, text: 'done', line: 1 },
        ])
    })

    it('parses the Task Tag run into columns, keeping the authored text intact', () => {
        const { tasks } = deriveDoc('- [ ] #P1 #W #D-2026-09-15 Fix the login redirect')
        expect(tasks[0]).toEqual({
            blockLocalId: 0,
            done: false,
            // The stored text keeps its tags: the Tasks View strips them for display, and the
            // write-back's stale-line guard needs the line as authored.
            text: '#P1 #W #D-2026-09-15 Fix the login redirect',
            line: 0,
            priority: 1,
            waiting: true,
            doing: false,
            cancelled: false,
            due: '2026-09-15',
            completion: null,
            scheduled: null,
        })
    })

    it('chains both outliner-block AND heading ancestors (user test case)', () => {
        const md = [
            '# [[Header 1]]',
            '',
            'Test',
            '',
            '## [[Header 2]]',
            '',
            'Test',
            '',
            '### [[Header 3]]',
            '',
            '[[Concern 2]]',
            '',
            '- Test',
            '  - Test yjis **out**',
            '    - [[Concern 1]]',
            '      - [[Concern 2]]',
        ].join('\n')
        const { blocks, links } = deriveDoc(md)
        const concern2 = links.filter((l) => l.concept === 'Concern 2')
        expect(concern2).toHaveLength(2)

        // The standalone [[Concern 2]] right under ### Header 3: heading ancestry only.
        expect(ancestorChain(blocks, concern2[0].blockLocalId)).toEqual([
            '[[Header 1]]',
            '[[Header 2]]',
            '[[Header 3]]',
            '[[Concern 2]]',
        ])

        // The deeply-nested [[Concern 2]]: outliner parents + the heading spine above.
        expect(ancestorChain(blocks, concern2[1].blockLocalId)).toEqual([
            '[[Header 1]]',
            '[[Header 2]]',
            '[[Header 3]]',
            'Test',
            'Test yjis **out**',
            '[[Concern 1]]',
            '[[Concern 2]]',
        ])
    })

    it('does not index a wikilink inside a code fence', () => {
        const { links } = deriveDoc('- real [[Yes]]\n\n```\n[[No]]\n```')
        expect(links.map((l) => l.concept)).toEqual(['Yes'])
    })
})

describe('fenced code blocks', () => {
    it('does not lift phantom tasks out of a code fence', () => {
        const md = ['- [ ] a real task', '```markdown', '- [ ] documenting the syntax', '```'].join('\n')
        expect(deriveDoc(md).tasks.map((t) => t.text)).toEqual(['a real task'])
    })

    it('never contributes a task from an encrypted block, whatever it holds', () => {
        const md = ['```etherpk-cipher', '- [ ] leaked', '```', '- [ ] visible'].join('\n')
        expect(deriveDoc(md).tasks.map((t) => t.text)).toEqual(['visible'])
    })

    it('is not closed early by a shorter run of the other fence character', () => {
        const md = ['````', '~~~', '- [ ] still inside', '````', '- [ ] outside'].join('\n')
        expect(deriveDoc(md).tasks.map((t) => t.text)).toEqual(['outside'])
    })

    it('reads an unterminated fence as plain text, exactly as the editor shows it', () => {
        // Editor Content Rules → "Inside a block": an unterminated opener yields no block, so
        // the author sees a task below it, and the index must agree.
        expect(deriveDoc('```\n- [ ] never closed').tasks.map((t) => t.text)).toEqual(['never closed'])
    })

    it('still runs an unterminated protected fence to the end of the document', () => {
        expect(deriveDoc('```etherpk-cipher\n- [ ] never closed').tasks).toEqual([])
    })

    it('abandons a stray fence that a dedent leaves behind, so the task below it stays visible', () => {
        // Live, 2026-09-11 (second report): an unbalanced fence inside a nested block. The
        // editor abandons the stray opener at the first dedented line and shows a task;
        // running it on to the next top-level fence instead hid that task.
        const md = [
            '- ', '- ', '- ', '- TEst', '  - Test',
            '    - ```', '      ```', '      Test content', '      ', '      ```',
            '- ', '', '- ', '  - [ ] #P1 Tes ttyhsd asdhk jashdk ashlkdlhaskd hkaj ', '', 'Tets', '',
            '```', 'Test', '```', '', '````', 'Test', '````',
        ].join('\n')
        expect(deriveDoc(md).tasks.map((t) => t.text)).toEqual(['#P1 Tes ttyhsd asdhk jashdk ashlkdlhaskd hkaj '])
    })

    it('reads a fence opened on a bullet line, so a task after that block is not swallowed', () => {
        // Live, 2026-09-11: a task written after a nested `- ``` ` block vanished from the Tasks
        // View. The opener sat on the bullet line, which the scanner did not read as a fence, so
        // the block's CLOSER opened a phantom fence that ran on to the next top-level block.
        const md = [
            '- TEst',
            '  - Test',
            '    - ```',
            '      Test content',
            '      ```',
            '- ',
            '  - [ ] #P1 after a nested fence',
            '',
            'Tets',
            '',
            '```',
            '- [ ] Test',
            '```',
        ].join('\n')
        expect(deriveDoc(md).tasks.map((t) => t.text)).toEqual(['#P1 after a nested fence'])
    })

    it('drops the Task Concepts of a task it excludes', () => {
        const md = ['- [[Acme]] work', '  ```', '  - [ ] fenced', '  ```'].join('\n')
        expect(deriveDoc(md).taskConcepts).toEqual([])
    })
})

describe('protected content contributes nothing to the index', () => {
    // The [[Derived Index]] is plaintext at rest in OPFS and outlives the session, so a
    // [[Protected Document]] must give it nothing at all — not its text, and not the references it
    // makes. A link escaping would be the quieter leak of the two: it would reveal, from a page
    // anyone can read, that a protected block points at something.
    it('extracts no wikilink from inside a protected fence', () => {
        const md = ['- see [[Visible]]', '```etherpk-cipher', 'AQQAAAGZaLmAAG5vdGUgWyxbU2VjcmV0XV0', '```'].join('\n')

        const { links } = deriveDoc(md)

        expect(links.map((l) => l.concept)).toEqual(['Visible'])
    })

    it('extracts no wikilink even when the fence body is plaintext that looks like a link', () => {
        const md = ['```etherpk-cipher', 'see [[Secret Target]]', '```'].join('\n')

        expect(deriveDoc(md).links).toEqual([])
    })

    it('extracts no task from inside a protected fence', () => {
        const md = ['- [ ] visible', '```etherpk-cipher', '- [ ] hidden', '```'].join('\n')

        expect(deriveDoc(md).tasks.map((t) => t.line)).toEqual([0])
    })
})

describe('deriveTitleLinks', () => {
    it('yields nothing for a plain title', () => {
        expect(deriveTitleLinks('Physics')).toEqual([])
    })

    it('reads the scope out of a scoped concept, with its columns in the title', () => {
        // The [[Scope]] of a [[Scoped Concept]] is a wikilink like any other: the page named
        // `[[Physics]] Quantum` references Physics by its name alone (ADR 0083).
        expect(deriveTitleLinks('[[Physics]] Quantum')).toEqual([
            { concept: 'Physics', matchStart: 0, matchEnd: 11 },
        ])
    })

    it('yields every nesting level, outermost first', () => {
        expect(deriveTitleLinks('[[[[Physics]] Quantum]] Field Theory')).toEqual([
            { concept: '[[Physics]] Quantum', matchStart: 0, matchEnd: 23 },
            { concept: 'Physics', matchStart: 2, matchEnd: 13 },
        ])
    })

    it('counts a scope exactly when a rename of it would carry the page (the cascade rule)', () => {
        // One scan, not two: a page references its scope precisely when `isScopedBy` says a
        // rename of that scope drags the page along. A link inside a code span is neither.
        for (const title of ['[[Physics]] Quantum', '`[[Physics]]` notes', 'Physics', '[[[[Physics]] Q]] F']) {
            const derived = deriveTitleLinks(title).some((l) => l.concept === 'Physics')
            expect(derived, title).toBe(isScopedBy(title, 'Physics'))
        }
        expect(deriveTitleLinks('`[[Physics]]` notes')).toEqual([])
    })
})
