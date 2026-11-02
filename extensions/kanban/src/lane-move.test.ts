import { describe, expect, it } from 'vitest'

import { DocumentNotFoundError, type DocumentStore, type EditorDocument } from '#lib/document/types.js'
import { moveTasks, revertMoves } from './lane-move'

// "Move all to lane" (ADR 0167): every task in a lane written into another status, one task at a
// time, and the whole move taken back as one.

/** Documents held as strings, enough of a store for the task writer. */
function createInMemoryDocumentStore(texts: Record<string, string>): DocumentStore {
    return {
        open(id): EditorDocument {
            if (!(id in texts)) throw new DocumentNotFoundError(id)
            return {
                id,
                getText: () => texts[id],
                applyChange: ({ from, to, insert }) => void (texts[id] = texts[id].slice(0, from) + insert + texts[id].slice(to)),
                subscribe: () => () => {},
            }
        },
    }
}

const text = (store: DocumentStore, concept: string) => store.open(concept).getText()

describe('moving every task in a lane', () => {
    it('writes each task into the new status, across documents, and counts them', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- [x] #P1 Water the beans\n- [ ] Weed', Kitchen: '- [x] Wash up' })
        const result = await moveTasks(
            store,
            [
                { concept: 'Garden', line: 0, text: '#P1 Water the beans' },
                { concept: 'Kitchen', line: 0, text: 'Wash up' },
            ],
            'archived',
        )
        expect(result).toMatchObject({ moved: 2, refused: 0 })
        expect(text(store, 'Garden')).toBe('- [x] #P1 #A Water the beans\n- [ ] Weed')
        expect(text(store, 'Kitchen')).toBe('- [x] #A Wash up')
    })

    it('counts a task the move already reached through its parent once, and writes it once', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- [x] Beds\n  - [x] Water the beans' })
        const result = await moveTasks(
            store,
            [
                { concept: 'Garden', line: 0, text: 'Beds' },
                { concept: 'Garden', line: 1, text: 'Water the beans' },
            ],
            'archived',
        )
        expect(result).toMatchObject({ moved: 2, refused: 0 })
        expect(text(store, 'Garden')).toBe('- [x] #A Beds\n  - [x] #A Water the beans')
    })

    it('counts a task it cannot find, and goes on with the rest', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- [x] Water the beans' })
        const result = await moveTasks(
            store,
            [
                { concept: 'Garden', line: 0, text: 'Plant the leeks' },
                { concept: 'Shed', line: 0, text: 'Oil the hinge' },
                { concept: 'Garden', line: 0, text: 'Water the beans' },
            ],
            'open',
        )
        expect(result).toMatchObject({ moved: 1, refused: 2 })
        expect(text(store, 'Garden')).toBe('- [ ] Water the beans')
    })
})

describe('taking a lane move back', () => {
    it('puts every line back as it was, and can do it again the other way', async () => {
        const before = '- [x] #C Beds\n  - [x] Water the beans\n- [x] Weed'
        const store = createInMemoryDocumentStore({ Garden: before })
        const moved = await moveTasks(
            store,
            [
                { concept: 'Garden', line: 0, text: '#C Beds' },
                { concept: 'Garden', line: 2, text: 'Weed' },
            ],
            'archived',
        )
        const after = text(store, 'Garden')
        const undone = await revertMoves(store, moved.writes)
        expect(undone.skipped).toBe(0)
        expect(text(store, 'Garden')).toBe(before)
        await revertMoves(store, undone.writes)
        expect(text(store, 'Garden')).toBe(after)
    })

    it('leaves a task edited since, and counts it', async () => {
        const store = createInMemoryDocumentStore({ Garden: '- [x] Water the beans\n- [x] Weed' })
        const moved = await moveTasks(
            store,
            [
                { concept: 'Garden', line: 0, text: 'Water the beans' },
                { concept: 'Garden', line: 1, text: 'Weed' },
            ],
            'test',
        )
        const document = store.open('Garden')
        document.applyChange({ from: 0, to: document.getText().indexOf('\n'), insert: '- [ ] #P1 #T Water the beans' }, 'external')
        const undone = await revertMoves(store, moved.writes)
        expect(undone.skipped).toBe(1)
        expect(text(store, 'Garden')).toBe('- [ ] #P1 #T Water the beans\n- [x] Weed')
    })
})
