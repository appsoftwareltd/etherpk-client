/**
 * The open boards' registry (board-actions.ts): card actions reach the board that raised the menu,
 * and a rename or a removal reaches every board, whatever its own concept.
 */

import { describe, expect, it } from 'vitest'

import { boardActions, type BoardActions, conceptRenamed, documentRemoved, registerBoard, takeBoardHandover } from './board-actions'
import { type BoardState, defaultBoardState } from './board-state'

const actions: BoardActions = { open: () => {}, openInTab: () => {}, copyReference: () => {}, move: () => {} }

/**
 * A board over `concept`, registered as KanbanView registers one: its Task Detail shows
 * `detailDocument` and follows a rename of it, as KanbanView's does.
 */
function boardOver(concept: string, detailDocument = 'Old') {
    const board = { detailDocument, asked: [] as string[] }
    const unregister = registerBoard(`board-${concept}`, actions, {
        concept,
        documentRenamed: (from, to) => {
            board.asked.push(`renamed ${from}`)
            if (board.detailDocument.toLowerCase() === from.toLowerCase()) board.detailDocument = to
        },
        documentRemoved: () => {},
        state: (): BoardState => {
            board.asked.push('state')
            return { collapsed: ['done'], detail: { document: board.detailDocument, line: 3, label: 'Send the quote' }, detailHeight: 0.4 }
        },
    })
    return { board, unregister }
}

describe('open boards', () => {
    it('finds a board by the id it registered under, until it goes', () => {
        const unregister = registerBoard('board-a', actions)
        expect(boardActions('board-a')).toBe(actions)
        unregister()
        expect(boardActions('board-a')).toBeUndefined()
    })

    it('tells every board that follows documents of a rename and of a removal', () => {
        const heard: string[] = []
        const follow = (name: string) => ({
            concept: name,
            documentRenamed: (from: string, to: string) => void heard.push(`${name} renamed ${from} to ${to}`),
            documentRemoved: (document: string) => void heard.push(`${name} removed ${document}`),
            state: () => defaultBoardState(),
        })
        const unregisterA = registerBoard('board-a', actions, follow('Acme'))
        const unregisterB = registerBoard('board-b', actions, follow('Beta'))
        const unregisterC = registerBoard('board-c', actions) // a board that follows nothing
        try {
            conceptRenamed('Old', 'New')
            documentRemoved('Notes')
            expect(heard).toEqual(['Acme renamed Old to New', 'Beta renamed Old to New', 'Acme removed Notes', 'Beta removed Notes'])
        } finally {
            unregisterA()
            unregisterB()
            unregisterC()
        }
    })
})

// A board re-keyed by a rename is a new View, and carries on where the old one was (ADR 0113).
describe('a board re-keyed by a rename', () => {
    it('takes the state of the board it replaces, once, whatever the case of its name', () => {
        const { unregister } = boardOver('Old')
        try {
            conceptRenamed('Old', 'New')
            expect(takeBoardHandover('new')).toEqual({
                collapsed: ['done'],
                detail: { document: 'New', line: 3, label: 'Send the quote' },
                detailHeight: 0.4,
            })
            expect(takeBoardHandover('New')).toBeUndefined()
        } finally {
            unregister()
        }
    })

    it('hands nothing over for a board the rename leaves alone', () => {
        const { unregister } = boardOver('Other')
        try {
            conceptRenamed('Old', 'New')
            expect(takeBoardHandover('New')).toBeUndefined()
            expect(takeBoardHandover('Other')).toBeUndefined()
        } finally {
            unregister()
        }
    })

    it('hears the rename before its state is taken, so the handover carries the Task Detail where it now is', () => {
        // A new name the old one scopes (`Old` to `[[Old]] Archive`) would be renamed again if the
        // handover applied the rename to a Task Detail that had already followed it.
        const { board, unregister } = boardOver('Old')
        try {
            conceptRenamed('Old', '[[Old]] Archive')
            expect(board.asked).toEqual(['renamed Old', 'state'])
            expect(takeBoardHandover('[[Old]] Archive')?.detail?.document).toBe('[[Old]] Archive')
        } finally {
            unregister()
        }
    })

    it('carries a Task Detail on a scoped document that an earlier Event of the same rename moved', () => {
        // The Client reports the scoped concepts first and the renamed one last.
        const { unregister } = boardOver('Old', '[[Old]] Child')
        try {
            conceptRenamed('[[Old]] Child', '[[New]] Child')
            conceptRenamed('Old', 'New')
            expect(takeBoardHandover('New')?.detail?.document).toBe('[[New]] Child')
        } finally {
            unregister()
        }
    })
})
