import { describe, expect, it } from 'vitest'

import type { Exchange } from '../chat/model'
import { answerOutline, chatOutline, type KeptTurns } from './outline'

/** Both turns of an exchange kept. */
const both = (kept: Exchange): KeptTurns => ({ exchange: kept, question: true, answer: true })

const exchange = (over: Partial<Exchange>): Exchange => ({
    id: 't1',
    question: 'What should I plant beside the beans?',
    images: [],
    answer: 'Marigolds, as your [[Garden]] notes suggest.',
    connectionId: 'c1',
    modelId: 'fake-model',
    modelLabel: 'Fake Model',
    grant: 'document',
    webSearch: false,
    tools: [],
    sources: [],
    status: 'done',
    askedAt: 0,
    questionSaved: false,
    answerSaved: false,
    ...over,
})

/** Answer shapes models write, with the blank lines, headings and fences that once broke a Save. */
const TRICKY_ANSWERS = [
    '1. Dig\n\n2. Sow\n\n3. Water',
    '1. Dig\n   - deep\n\n   ```sh\n   dig --deep\n\n   ```\n\n2. Sow',
    '- Steps\n\n  ## Sowing\n\n  Rows apart.\n\n  - beans',
    'Run:\n\n    water\n\n    # mulch',
    '~~~\n# water\n\n- beans\n~~~',
    '```js title="x"\n# comment\n\n```',
    '   ```\n   - code\n   ````',
    'Here:\n\n```sh\n# water\n\n- beans',
    '> quote\n>\n> # heading in quote',
    'Garden\n---\n\n***\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    '* one\n\n  two\n\n      code\n\n* three',
]

/**
 * What would end a branch in the editor (outliner.ts): a bare blank line outside a fence, a heading
 * that is not on a bullet's own line, and a fence opener without a closer of its run at its column.
 */
function outlineFaults(lines: readonly string[]): string[] {
    const faults: string[] = []
    let fence: { column: number; ticks: string } | null = null
    lines.forEach((line, i) => {
        const opener = /^(\s*(?:-\s)?)(`{3,})(\S*)\s*$/.exec(line)
        if (fence) {
            if (opener && opener[1].length === fence.column && opener[2] === fence.ticks && opener[3] === '') fence = null
            return
        }
        if (opener) {
            fence = { column: opener[1].length, ticks: opener[2] }
            return
        }
        if (line === '') faults.push(`bare blank line ${i}`)
        if (/^\s*#{1,6}\s/.test(line)) faults.push(`heading below a bullet ${i}: ${line}`)
        if (/^\s*[~]{3,}/.test(line)) faults.push(`tilde fence ${i}`)
    })
    if (fence) faults.push('unclosed fence')
    return faults
}

describe('an answer as outline blocks', () => {
    it('makes each paragraph a bullet, with a long one kept on its lines', () => {
        expect(answerOutline('Water them daily.\nEarly is best.\n\nMulch helps.')).toEqual(['- Water them daily.', '  Early is best.', '- Mulch helps.'])
    })

    it("keeps a bulleted list's items as bullets, nested ones too, written with the outliner's dash", () => {
        expect(answerOutline('Plant:\n\n* beans\n  * runner beans\n+ peas')).toEqual(['- Plant:', '- beans', '  - runner beans', '- peas'])
    })

    it('keeps a heading, a table and a code block whole, each under a bullet of its own, and each numbered item a bullet keeping its number', () => {
        const answer = ['## Steps', '', '1. Dig', '2. Sow', '', '| Bed | Crop |', '| --- | --- |', '| A | beans |', '', '```sh', 'water --daily', '', 'mulch', '```'].join('\n')
        expect(answerOutline(answer)).toEqual([
            '- ## Steps',
            '- 1. Dig',
            '- 2. Sow',
            '- | Bed | Crop |',
            '  | --- | --- |',
            '  | A | beans |',
            '- ```sh',
            '  water --daily',
            '',
            '  mulch',
            '  ```',
        ])
    })

    // A bare blank line, a heading below a bullet's first line, or a fence the editor does not pair
    // ends every branch it sits in, so a Save from a nested bullet orphaned the document's later
    // bullets (Editor Content Rules → Inline panels). Each row is an answer shape that did.
    it('drops the blank lines between the items of a loose numbered list', () => {
        expect(answerOutline('1. Dig the bed.\n\n2. Sow the beans.')).toEqual(['- 1. Dig the bed.', '- 2. Sow the beans.'])
    })

    it("keeps an item's second paragraph as its own lines, after a blank line at its content column", () => {
        expect(answerOutline('1. Dig the bed.\n\n   Then rake it.\n2. Sow the beans.')).toEqual(['- 1. Dig the bed.', '  ', '  Then rake it.', '- 2. Sow the beans.'])
    })

    it("nests an item's list under it, however the blank lines fall", () => {
        expect(answerOutline('1. Dig\n\n   - deep\n   - wide\n\n2. Sow\n\n   * thin')).toEqual(['- 1. Dig', '  - deep', '  - wide', '- 2. Sow', '  - thin'])
    })

    it('makes a heading inside a list item a bullet of its own under the item', () => {
        expect(answerOutline('- Steps\n\n  ## Sowing\n\n  Rows apart.')).toEqual(['- Steps', '  - ## Sowing', '  - Rows apart.'])
        expect(answerOutline('1. Plan\n   1. Dig\n      # Sow')).toEqual(['- 1. Plan', '  - 1. Dig', '    - # Sow'])
    })

    it('writes every heading as a bullet, a setext one too', () => {
        expect(answerOutline('Garden\n======\n\nBeds\n----')).toEqual(['- # Garden', '- ## Beds'])
    })

    it('writes an indented code block, a tilde fence and a fence with a long info string as fences the editor pairs', () => {
        expect(answerOutline('Run:\n\n    water\n\n    mulch')).toEqual(['- Run:', '- ```', '  water', '', '  mulch', '  ```'])
        expect(answerOutline('~~~sh\n# water first\n~~~')).toEqual(['- ```sh', '  # water first', '  ```'])
        expect(answerOutline('```js title="beans.js" {1,3}\nwater()\n```')).toEqual(['- ```js', '  water()', '  ```'])
        expect(answerOutline('  ```sh\n  water\n  `````')).toEqual(['- ```sh', '  water', '  ```'])
    })

    it('closes a code block the answer stopped inside, so the code never reads as outline', () => {
        expect(answerOutline('Here:\n\n```sh\n# water\n- beans')).toEqual(['- Here:', '- ```sh', '  # water', '  - beans', '  ```'])
    })

    it('outruns any backtick run inside the code', () => {
        expect(answerOutline('````md\n```sh\nwater\n```\n````')).toEqual(['- ````md', '  ```sh', '  water', '  ```', '  ````'])
    })

    it("gives a numbered item that opens on code or a heading a line of its own for its number, and keeps a bulleted one's on its bullet", () => {
        expect(answerOutline('1. ```sh\n   water\n   ```')).toEqual(['- 1.', '  - ```sh', '    water', '    ```'])
        expect(answerOutline('- ```sh\n  water\n  ```')).toEqual(['- ```sh', '  water', '  ```'])
    })

    it('keeps a quote and a table in a list item, without the item marker', () => {
        expect(answerOutline('- > Water daily.\n  > Early.\n- | Bed |\n  | --- |\n  | A |')).toEqual(['- > Water daily.', '  > Early.', '- | Bed |', '  | --- |', '  | A |'])
    })

    it("keeps tasks as tasks and link definitions as a last bullet, since a link needs its definition", () => {
        expect(answerOutline('- [ ] water\n- [x] sow')).toEqual(['- [ ] water', '- [x] sow'])
        expect(answerOutline('See [the notes][g].\n\n[g]: https://example.com/garden')).toEqual(['- See [the notes][g].', '- [G]: https://example.com/garden'])
    })

    it('writes no bare blank line outside a fence, no heading below a bullet, and only fences the editor pairs, for any answer', () => {
        for (const answer of TRICKY_ANSWERS) {
            const lines = answerOutline(answer)
            expect(outlineFaults(lines), JSON.stringify(answer)).toEqual([])
        }
    })

    it('gives nothing for an empty answer', () => {
        expect(answerOutline('  \n')).toEqual([])
    })
})

describe('the blocks a Save writes (ADR 0147)', () => {
    it('heads the kept exchanges with the models and the day, each question a bullet with its answer beneath', () => {
        const text = chatOutline([exchange({}), exchange({ id: 't2', question: 'And in shade?', answer: 'Lettuce.', modelLabel: 'Other Model' })].map(both), { date: '2026-10-15' })
        expect(text.split('\n')).toEqual([
            '- **Agent Chat with Fake Model and Other Model on 2026-10-15**',
            '  - What should I plant beside the beans?',
            '    - Marigolds, as your [[Garden]] notes suggest.',
            '  - And in shade?',
            '    - Lettuce.',
        ])
    })

    it('writes an exchange sent with no prompt as what was sent', () => {
        const text = chatOutline([both(exchange({ question: '', grant: 'block' }))], { date: '2026-10-16' })
        expect(text.split('\n').slice(1, 3)).toEqual(['  - Sent block siblings and ancestors', '    - Marigolds, as your [[Garden]] notes suggest.'])
    })

    it("keeps a question's own lines, its images and the answer's sources", () => {
        const text = chatOutline(
            [
                both(exchange({
                    question: 'What is this?\nIt grew overnight.',
                    images: [{ id: 'i1', name: 'leaf.png', blob: new Blob() }],
                    answer: 'A bean sprout.',
                    sources: [{ url: 'https://example.com/beans', title: 'Beans' }],
                })),
            ],
            { date: '2026-10-15', imageMarkdown: new Map([['i1', '![leaf](assets/leaf.webp)']]) },
        )
        expect(text.split('\n')).toEqual([
            '- **Agent Chat with Fake Model on 2026-10-15**',
            '  - What is this?',
            '    It grew overnight.',
            '    ![leaf](assets/leaf.webp)',
            '    - A bean sprout.',
            '    - Sources: [Beans](https://example.com/beans)',
        ])
    })

    it('keeps a question with an empty line or a heading in it to the outline, as an answer is kept', () => {
        expect(chatOutline([both(exchange({ question: 'Look:\n\nWhat grows?', answer: 'Beans.' }))], { date: '2026-10-19' }).split('\n')).toEqual([
            '- **Agent Chat with Fake Model on 2026-10-19**',
            '  - Look:',
            '    ',
            '    What grows?',
            '    - Beans.',
        ])
        expect(chatOutline([both(exchange({ question: 'What grows?\n# Garden', answer: 'Beans.' }))], { date: '2026-10-19' }).split('\n')).toEqual([
            '- **Agent Chat with Fake Model on 2026-10-19**',
            '  - What grows?',
            '    - # Garden',
            '    - Beans.',
        ])
    })

    it('puts an answer kept without its question straight under the header, and a question kept alone on its own', () => {
        const first = exchange({})
        const second = exchange({ id: 't2', question: 'And in shade?', answer: 'Lettuce.\n\nOr chard.', modelLabel: 'Other Model', sources: [{ url: 'https://example.com/shade', title: 'Shade' }] })
        expect(chatOutline([{ exchange: first, question: true, answer: false }, { exchange: second, question: false, answer: true }], { date: '2026-10-20' }).split('\n')).toEqual([
            '- **Agent Chat with Other Model on 2026-10-20**',
            '  - What should I plant beside the beans?',
            '  - Lettuce.',
            '  - Or chard.',
            '  - Sources: [Shade](https://example.com/shade)',
        ])
    })

    it('makes the header bold, so the saved chat stands out in the outline', () => {
        expect(chatOutline([both(exchange({ modelLabel: 'DeepSeek: DeepSeek V4.1 Flash' }))], { date: '2026-10-20' }).split('\n')[0]).toBe('- **Agent Chat with DeepSeek: DeepSeek V4.1 Flash on 2026-10-20**')
    })

    it('names no model when only questions are kept', () => {
        expect(chatOutline([{ exchange: exchange({}), question: true, answer: false }], { date: '2026-10-20' }).split('\n')).toEqual(['- **Agent Chat on 2026-10-20**', '  - What should I plant beside the beans?'])
    })

    it('keeps a question whose answer never came', () => {
        expect(chatOutline([both(exchange({ answer: '', status: 'stopped' }))], { date: '2026-10-15' }).split('\n')).toEqual([
            '- **Agent Chat with Fake Model on 2026-10-15**',
            '  - What should I plant beside the beans?',
        ])
    })
})
