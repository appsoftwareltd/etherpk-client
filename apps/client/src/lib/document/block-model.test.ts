import { describe, expect, it } from 'vitest'

import { type Block, parseBlocks } from './block-model'

describe('parseBlocks', () => {
    it('returns an empty array for empty input', () => {
        expect(parseBlocks('')).toEqual([])
    })

    it('treats a heading as a depth-0 block carrying its level', () => {
        const blocks = parseBlocks('# Title')
        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({ type: 'heading', depth: 0, level: 1, text: '# Title' })
    })

    it('separates paragraphs by blank lines', () => {
        const blocks = parseBlocks('one\n\ntwo')
        expect(blocks.map((b) => b.text)).toEqual(['one', 'two'])
    })

    it('nests a more-indented block under its predecessor', () => {
        const blocks = parseBlocks('- parent\n  - child')
        expect(blocks).toHaveLength(1)
        expect(blocks[0].text).toBe('- parent')
        expect(blocks[0].children).toHaveLength(1)
        expect(blocks[0].children[0].text).toBe('- child')
    })

    it('computes indent depth from leading spaces (2 spaces per level)', () => {
        const blocks = parseBlocks('a\n  b\n    c')
        expect(blocks[0].children[0].text).toBe('b')
        expect(blocks[0].children[0].children[0].text).toBe('c')
    })

    describe('depth is structural, whatever grid the text is on (ADR 0067)', () => {
        it('a four-space tree and a tab-indented tree derive the same depths as a two-space one', () => {
            for (const text of ['- a\n  - b\n    - c\n  - d', '- a\n    - b\n        - c\n    - d', '- a\n\t- b\n\t\t- c\n\t- d']) {
                const blocks = parseBlocks(text)
                expect(blocks).toHaveLength(1)
                expect(blocks[0].children.map((c) => c.depth)).toEqual([1, 1])
                expect(blocks[0].children[0].children.map((c) => c.depth)).toEqual([2])
            }
        })

        it('over-nesting is still a single level: a six-space child of a top bullet is depth 1', () => {
            const blocks = parseBlocks('- a\n      - b\n    - c')
            expect(blocks[0].children.map((c) => [c.text, c.depth])).toEqual([
                ['- b', 1],
                ['- c', 1],
            ])
        })

        it('a bare empty line closes every open branch: a bullet indented after one is a root, not a child', () => {
            // The editor's rule (ADR 0021: a flush-left empty line bounds the group) is the index's too.
            const blocks = parseBlocks('- a\n\n  - b')
            expect(blocks.map((b) => [b.text, b.depth, b.children.length])).toEqual([
                ['- a', 0, 0],
                ['- b', 0, 0],
            ])
        })

        it('a continuation line under a four-space bullet still joins its block', () => {
            const blocks = parseBlocks('- a\n    - b\n      more')
            expect(blocks[0].children[0].text).toBe('- b\nmore')
        })
    })

    it('records the source line range of each block', () => {
        const [first, second] = parseBlocks('one\n\ntwo')
        expect(first).toMatchObject({ startLine: 0, endLine: 0 })
        expect(second).toMatchObject({ startLine: 2, endLine: 2 })
    })

    // --- The unified model (ADR 0016) ---

    describe('heading-level spine', () => {
        it('nests headings by # level, not indentation', () => {
            const [h1] = parseBlocks('# A\n## B\n### C')
            expect(h1).toMatchObject({ level: 1 })
            expect(h1.children).toHaveLength(1)
            const h2 = h1.children[0]
            expect(h2).toMatchObject({ level: 2 })
            expect(h2.children[0]).toMatchObject({ level: 3 })
        })

        it('a same-or-higher heading closes the previous section', () => {
            const roots = parseBlocks('# A\n## B\n# C')
            expect(roots).toHaveLength(2)
            expect(roots[0]).toMatchObject({ level: 1, text: '# A' })
            expect(roots[1]).toMatchObject({ level: 1, text: '# C' })
            expect(roots[0].children[0]).toMatchObject({ level: 2, text: '## B' })
        })

        it('nests section content (paragraphs, bullets) under its heading', () => {
            const [h1] = parseBlocks('# A\nintro prose\n## Tasks\n- do thing')
            expect(h1.children.map((c) => c.type)).toEqual(['paragraph', 'heading'])
            const tasks = h1.children[1]
            expect(tasks.children[0]).toMatchObject({ type: 'bullet', text: '- do thing' })
        })

        it('a deeper-indented block following a heading still nests under it', () => {
            const [h1] = parseBlocks('# A\npara0\n  para1')
            expect(h1.children).toHaveLength(1)
            expect(h1.children[0].text).toBe('para0')
            expect(h1.children[0].children[0].text).toBe('para1')
        })
    })

    describe('bullet and task kinds', () => {
        it('classifies a plain bullet', () => {
            const [b] = parseBlocks('- a bullet')
            expect(b).toMatchObject({ type: 'bullet' })
            expect(b.done).toBeUndefined()
        })

        it('classifies an unchecked task', () => {
            const [b] = parseBlocks('- [ ] todo')
            expect(b).toMatchObject({ type: 'task', done: false })
        })

        it('classifies a checked task (case-insensitive)', () => {
            expect(parseBlocks('- [x] done')[0]).toMatchObject({ type: 'task', done: true })
            expect(parseBlocks('- [X] done')[0]).toMatchObject({ type: 'task', done: true })
        })

        it('a hyphen without a following space is prose, not a bullet', () => {
            expect(parseBlocks('-notabullet')[0].type).toBe('paragraph')
        })

        it('interlocks bullets and indentation within a section', () => {
            const [h] = parseBlocks('## Tasks\n- [ ] do thing\n  - sub item\n- [ ] other thing')
            const [doThing, other] = h.children
            expect(doThing).toMatchObject({ type: 'task', text: '- [ ] do thing' })
            expect(doThing.children[0]).toMatchObject({ type: 'bullet', text: '- sub item' })
            expect(other).toMatchObject({ type: 'task', text: '- [ ] other thing' })
            expect(other.children).toHaveLength(0)
        })
    })

    describe('continuation lines (soft newline within a block)', () => {
        it('absorbs a content-column continuation line into the same bullet', () => {
            const [b] = parseBlocks('- first line\n  second line')
            expect(b.type).toBe('bullet')
            expect(b.text).toBe('- first line\nsecond line')
            expect(b).toMatchObject({ startLine: 0, endLine: 1 })
            expect(b.children).toHaveLength(0)
        })

        it('does not absorb a nested bullet as a continuation', () => {
            const [b] = parseBlocks('- first\n  continued\n  - child')
            expect(b.text).toBe('- first\ncontinued')
            expect(b.endLine).toBe(1)
            expect(b.children).toHaveLength(1)
            expect(b.children[0].text).toBe('- child')
        })

        it('a line indented less than the content column ends the bullet', () => {
            const blocks = parseBlocks('  - bullet\nback to prose')
            expect(blocks).toHaveLength(2)
            expect(blocks[0].text).toBe('- bullet')
            expect(blocks[1].text).toBe('back to prose')
        })
    })

    // Code is opaque to the walk: a complete fenced block (the editor's pairing, fenced-code.ts)
    // belongs whole to the block its opener sits in, whatever its lines look like.
    describe('fenced code blocks', () => {
        it('keeps a blank line inside a bullet’s fence in the bullet, with the code’s own indentation', () => {
            const blocks = parseBlocks(['- a', '  ```py', '  def f():', '', '      return 1', '  ```', '- b'].join('\n'))
            expect(blocks.map((b) => b.text)).toEqual(['- a\n```py\ndef f():\n\n    return 1\n```', '- b'])
            expect(blocks[0]).toMatchObject({ startLine: 0, endLine: 5 })
            expect(blocks[0].children).toHaveLength(0)
        })

        it('reads a `#` line inside a fence as code, not a heading', () => {
            const blocks = parseBlocks(['- a', '  ```bash', '  # install', '  npm i', '  ```', '- b'].join('\n'))
            expect(blocks.map((b) => [b.type, b.text])).toEqual([
                ['bullet', '- a\n```bash\n# install\nnpm i\n```'],
                ['bullet', '- b'],
            ])
        })

        it('reads a bullet inside a fence as code, not a child', () => {
            const [a] = parseBlocks(['- a', '  ```md', '  - not a child', '  - [ ] not a task', '  ```'].join('\n'))
            expect(a.text).toBe('- a\n```md\n- not a child\n- [ ] not a task\n```')
            expect(a.children).toHaveLength(0)
        })

        it('takes a fence opened on the bullet line (`- ``` `) whole', () => {
            const blocks = parseBlocks(['- ```ts', '  const x = 1', '', '  x++', '  ```', '- b'].join('\n'))
            expect(blocks.map((b) => b.text)).toEqual(['- ```ts\nconst x = 1\n\nx++\n```', '- b'])
        })

        it('keeps code indentation relative to a fence deeper than the content column', () => {
            const [a] = parseBlocks(['- a', '    ```', '      x', '    ```'].join('\n'))
            expect(a.text).toBe('- a\n```\n  x\n```')
        })

        it('takes a fence nested inside a longer one as part of the outer, and reads neither as structure', () => {
            const [a] = parseBlocks(['- a', '  ````md', '  ```sh', '  # x', '  ```', '', '  - y', '  ````'].join('\n'))
            expect(a.text).toBe('- a\n````md\n```sh\n# x\n```\n\n- y\n````')
            expect(a.children).toHaveLength(0)
        })

        it('reads a tab-indented bullet’s fence by characters, as the editor does', () => {
            const blocks = parseBlocks(['\t- a', '\t  ```', '\t  \tx', '', '\t  ```', '\t- b'].join('\n'))
            expect(blocks.map((b) => b.text)).toEqual(['- a\n```\n\tx\n\n```', '- b'])
        })

        it('reads a top-level fence as one paragraph, blank lines and all', () => {
            const blocks = parseBlocks(['```', 'a', '', '# b', '```', 'after'].join('\n'))
            expect(blocks.map((b) => [b.type, b.text])).toEqual([['paragraph', '```\na\n\n# b\n```\nafter']])
        })

        it('lets a paragraph take the fence that follows it at its indent', () => {
            const [p] = parseBlocks(['see [[X]]:', '```ts', 'let a', '', 'let b', '```'].join('\n'))
            expect(p).toMatchObject({ type: 'paragraph', text: 'see [[X]]:\n```ts\nlet a\n\nlet b\n```', endLine: 5 })
        })

        it('leaves an unterminated opener as plain lines, as the editor does', () => {
            const blocks = parseBlocks(['- a', '  ```', '  # h'].join('\n'))
            expect(blocks.map((b) => b.type)).toEqual(['bullet', 'heading'])
        })
    })

    it('models a full dual-mode document', () => {
        const tree = parseBlocks(
            ['# Project', 'Some intro prose.', '## Tasks', '- [ ] do thing', '  - sub item', '- [ ] other thing'].join(
                '\n',
            ),
        )
        expect(tree).toHaveLength(1)
        const project = tree[0]
        expect(project.children.map((c: Block) => c.type)).toEqual(['paragraph', 'heading'])
        const tasks = project.children[1]
        expect(tasks.children.map((c: Block) => c.type)).toEqual(['task', 'task'])
        expect(tasks.children[0].children[0]).toMatchObject({ type: 'bullet', text: '- sub item' })
    })
})
