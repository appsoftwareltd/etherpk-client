import { describe, expect, it } from 'vitest'

import type { Turn } from '../chat/model'
import { answerOutline, chatOutline } from './outline'

const turn = (over: Partial<Turn>): Turn => ({
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
    saved: false,
    ...over,
})

describe('an answer as outline blocks', () => {
    it('makes each paragraph a bullet, with a long one kept on its lines', () => {
        expect(answerOutline('Water them daily.\nEarly is best.\n\nMulch helps.')).toEqual(['- Water them daily.', '  Early is best.', '- Mulch helps.'])
    })

    it("keeps a bulleted list's items as bullets, nested ones too, written with the outliner's dash", () => {
        expect(answerOutline('Plant:\n\n* beans\n  * runner beans\n+ peas')).toEqual(['- Plant:', '- beans', '  - runner beans', '- peas'])
    })

    it('keeps a numbered list, a heading, a table and a code block whole, each under a bullet of its own', () => {
        const answer = ['## Steps', '', '1. Dig', '2. Sow', '', '| Bed | Crop |', '| --- | --- |', '| A | beans |', '', '```sh', 'water --daily', '', 'mulch', '```'].join('\n')
        expect(answerOutline(answer)).toEqual([
            '- ## Steps',
            '- 1. Dig',
            '  2. Sow',
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

    it('gives nothing for an empty answer', () => {
        expect(answerOutline('  \n')).toEqual([])
    })
})

describe('the blocks a Save writes (ADR 0147)', () => {
    it('heads the kept turns with the models and the day, each question a bullet with its answer beneath', () => {
        const text = chatOutline([turn({}), turn({ id: 't2', question: 'And in shade?', answer: 'Lettuce.', modelLabel: 'Other Model' })], { date: '2026-10-15' })
        expect(text.split('\n')).toEqual([
            '- Agent Chat with Fake Model and Other Model on 2026-10-15',
            '  - What should I plant beside the beans?',
            '    - Marigolds, as your [[Garden]] notes suggest.',
            '  - And in shade?',
            '    - Lettuce.',
        ])
    })

    it("keeps a question's own lines, its images and the answer's sources", () => {
        const text = chatOutline(
            [
                turn({
                    question: 'What is this?\nIt grew overnight.',
                    images: [{ id: 'i1', name: 'leaf.png', blob: new Blob() }],
                    answer: 'A bean sprout.',
                    sources: [{ url: 'https://example.com/beans', title: 'Beans' }],
                }),
            ],
            { date: '2026-10-15', imageMarkdown: new Map([['i1', '![leaf](assets/leaf.webp)']]) },
        )
        expect(text.split('\n')).toEqual([
            '- Agent Chat with Fake Model on 2026-10-15',
            '  - What is this?',
            '    It grew overnight.',
            '    ![leaf](assets/leaf.webp)',
            '    - A bean sprout.',
            '    - Sources: [Beans](https://example.com/beans)',
        ])
    })

    it('keeps a question whose answer never came', () => {
        expect(chatOutline([turn({ answer: '', status: 'stopped' })], { date: '2026-10-15' }).split('\n')).toEqual([
            '- Agent Chat with Fake Model on 2026-10-15',
            '  - What should I plant beside the beans?',
        ])
    })
})
