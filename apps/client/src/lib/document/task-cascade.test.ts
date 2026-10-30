import { describe, expect, it } from 'vitest'

import { lineWriteChanges, type LineWrite, nestedTaskWrites } from './task-cascade'

/** `text` with `writes` made through the changes {@link lineWriteChanges} returns, applied in order. */
function write(text: string, writes: LineWrite[]): string {
    let out = text
    for (const { from, to, insert } of lineWriteChanges(text.split('\n'), writes)) out = out.slice(0, from) + insert + out.slice(to)
    return out
}

/** The document after writing `next` over line `index` and every nested write it brings. */
function cascade(text: string, index: number, next: string): string {
    const lines = text.split('\n')
    return write(text, [{ index, before: lines[index], after: next }, ...nestedTaskWrites(lines, index, next)])
}

describe('the tasks a write to a task brings with it', () => {
    it('ticking a task ticks every task nested under it, at any depth', () => {
        const text = '- [ ] Garden\n  - [ ] water the beans\n    - [ ] fill the can\n- [ ] Kitchen'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  - [x] water the beans\n    - [x] fill the can\n- [ ] Kitchen')
    })

    it('reaches tasks under a plain bullet, and leaves the plain bullet a plain bullet', () => {
        const text = '- [ ] Garden\n  - Beds\n    - [ ] water the beans\n  - buy compost'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  - Beds\n    - [x] water the beans\n  - buy compost')
    })

    it('unticking a task unticks every ticked task nested under it', () => {
        const text = '- [x] Garden\n  - [x] water the beans\n  - [ ] weed'
        expect(cascade(text, 0, '- [ ] Garden')).toBe('- [ ] Garden\n  - [ ] water the beans\n  - [ ] weed')
    })

    it('unticking leaves a Cancelled task ticked', () => {
        const text = '- [x] Garden\n  - [x] #C plant the leeks\n  - [x] water the beans'
        expect(cascade(text, 0, '- [ ] Garden')).toBe('- [ ] Garden\n  - [x] #C plant the leeks\n  - [ ] water the beans')
    })

    it('writes only the checkbox of a nested task, its tags and spacing untouched', () => {
        const text = '- [ ] Garden\n  -  [ ] #P1 #W water   the beans'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  -  [x] #P1 #W water   the beans')
    })

    it('reports only the lines it changes', () => {
        const lines = '- [ ] Garden\n  - [x] water the beans\n  - [ ] weed\n  - note'.split('\n')
        expect(nestedTaskWrites(lines, 0, '- [x] Garden')).toEqual([{ index: 2, before: '  - [ ] weed', after: '  - [x] weed' }])
    })

    it('never passes upward or sideways', () => {
        const text = '- [ ] Garden\n  - [ ] water the beans\n  - [ ] weed\n- [ ] Kitchen'
        expect(cascade(text, 1, '  - [x] water the beans')).toBe('- [ ] Garden\n  - [x] water the beans\n  - [ ] weed\n- [ ] Kitchen')
    })

    it('stops at a heading and at a blank line that ends the tree', () => {
        const text = '- [ ] Garden\n  - [ ] weed\n# Kitchen\n  - [ ] wash up'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  - [x] weed\n# Kitchen\n  - [ ] wash up')
        const blank = '- [ ] Garden\n  - [ ] weed\n\n- [ ] Kitchen'
        expect(cascade(blank, 0, '- [x] Garden')).toBe('- [x] Garden\n  - [x] weed\n\n- [ ] Kitchen')
    })

    it('leaves a task-shaped line in a fenced code block alone', () => {
        const text = '- [ ] Garden\n  ```md\n  - [ ] sample\n  ```\n  - [ ] weed'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  ```md\n  - [ ] sample\n  ```\n  - [x] weed')
    })

    it('cancelling a task brings nothing with it', () => {
        const lines = '- [ ] Garden\n  - [ ] weed'.split('\n')
        expect(nestedTaskWrites(lines, 0, '- [x] #C Garden')).toEqual([])
    })

    it('a Cancelled task made Done ticks its nested tasks', () => {
        const text = '- [x] #C Garden\n  - [ ] weed'
        expect(cascade(text, 0, '- [x] Garden')).toBe('- [x] Garden\n  - [x] weed')
    })

    it('a Done task made Cancelled leaves its nested tasks as they are', () => {
        const lines = '- [x] Garden\n  - [x] weed'.split('\n')
        expect(nestedTaskWrites(lines, 0, '- [x] #C Garden')).toEqual([])
    })

    it('a change that does not move the checkbox brings nothing with it', () => {
        const lines = '- [ ] Garden\n  - [ ] weed'.split('\n')
        expect(nestedTaskWrites(lines, 0, '- [ ] #W Garden')).toEqual([])
        expect(nestedTaskWrites(lines, 0, '- [ ] #P1 Garden')).toEqual([])
    })

    it('making a bullet a task, or a task a bullet, brings nothing with it', () => {
        expect(nestedTaskWrites('- Garden\n  - [x] weed'.split('\n'), 0, '- [ ] Garden')).toEqual([])
        expect(nestedTaskWrites('- [x] Garden\n  - [x] weed'.split('\n'), 0, '- Garden')).toEqual([])
    })

    it('reads the outline the same way under frontmatter', () => {
        const text = '---\ntitle: Garden\n---\n- [ ] Garden\n  - [ ] weed'
        expect(cascade(text, 3, '- [x] Garden')).toBe('---\ntitle: Garden\n---\n- [x] Garden\n  - [x] weed')
    })
})

describe('the changes for line writes', () => {
    it('are the smallest edits, last line first, so each applies to the text the one before left', () => {
        const lines = ['- [ ] Garden', '  - [ ] weed']
        expect(lineWriteChanges(lines, [{ index: 0, before: lines[0], after: '- [x] #P1 Garden' }, { index: 1, before: lines[1], after: '  - [x] weed' }])).toEqual([
            { from: 18, to: 19, insert: 'x' },
            { from: 3, to: 5, insert: 'x] #P1' },
        ])
    })

    it('make the write whole across lines whose lengths change', () => {
        const text = '- [ ] Garden\n  - [ ] weed\n  - [ ] dig'
        const lines = text.split('\n')
        expect(
            write(text, [
                { index: 0, before: lines[0], after: '- [x] #P1 Garden' },
                { index: 2, before: lines[2], after: '  - [x] dig' },
            ]),
        ).toBe('- [x] #P1 Garden\n  - [ ] weed\n  - [x] dig')
    })
})
