/**
 * The open boards' registry (board-actions.ts): card actions reach the board that raised the menu,
 * and a rename or a removal reaches every board, whatever its own concept.
 */

import { describe, expect, it } from 'vitest'

import { boardActions, type BoardActions, documentRemoved, documentsRenamed, registerBoard } from './board-actions'
import { defaultBoardState } from './board-state'

const actions: BoardActions = { open: () => {}, openInTab: () => {}, copyReference: () => {}, move: () => {} }

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
            documentsRenamed: (renamed: (document: string) => string | undefined) => void heard.push(`${name} renamed Old to ${renamed('Old')}`),
            documentRemoved: (document: string) => void heard.push(`${name} removed ${document}`),
            state: () => defaultBoardState(),
        })
        const unregisterA = registerBoard('board-a', actions, follow('Acme'))
        const unregisterB = registerBoard('board-b', actions, follow('Beta'))
        const unregisterC = registerBoard('board-c', actions) // a board that follows nothing
        try {
            documentsRenamed((document) => (document === 'Old' ? 'New' : undefined))
            documentRemoved('Notes')
            expect(heard).toEqual(['Acme renamed Old to New', 'Beta renamed Old to New', 'Acme removed Notes', 'Beta removed Notes'])
        } finally {
            unregisterA()
            unregisterB()
            unregisterC()
        }
    })
})
