/**
 * What the Kanban Board adds to a graph as it starts (register.ts), through the context the
 * Client builds for it: its View, and the Events that keep open boards right.
 */
import type { ViewContribution } from '@appsoftwareltd/etherpk-extension-api'
import { describe, expect, it } from 'vitest'

import { type BoardActions, registerBoard, takeBoardHandover } from './board-actions'
import { defaultBoardState } from './board-state'
import { registerKanban } from './register'
import { kanbanContext } from './testing'

const board: ViewContribution = { mount: () => ({ destroy: () => {} }) }
const actions: BoardActions = { open: () => {}, openInTab: () => {}, copyReference: () => {}, move: () => {} }

describe('the Kanban Board extension', () => {
    it("supplies the board View for both kinds its manifest declares, a concept's board and the Graph Kanban", () => {
        const { context, views } = kanbanContext()
        registerKanban(context, board)
        expect([...views.keys()]).toEqual(['kanban.board', 'kanban.whole'])
        expect(views.get('kanban.board')).toBe(board)
        expect(views.get('kanban.whole')).toBe(board)
    })

    it('hands nothing to or from the Graph Kanban when a concept is renamed', () => {
        const { context, services } = kanbanContext()
        registerKanban(context, board)
        const heard: string[] = []
        const unregister = registerBoard('board-whole', actions, {
            concept: null,
            documentRenamed: (from, to) => void heard.push(`renamed ${from} to ${to}`),
            documentRemoved: () => {},
            state: () => ({ ...defaultBoardState(), collapsed: [] }),
        })
        try {
            services.events.emit('concept:renamed', { from: 'whole', to: 'Whole Food' })
            // Its Task Detail still follows a renamed document, as on any board.
            expect(heard).toEqual(['renamed whole to Whole Food'])
            expect(takeBoardHandover('Whole Food')).toBeUndefined()
        } finally {
            unregister()
        }
    })

    it('moves a Task Detail and hands a board over when the Client reports a rename', () => {
        const { context, services } = kanbanContext()
        registerKanban(context, board)
        const heard: string[] = []
        const unregister = registerBoard('board-acme', actions, {
            concept: 'Acme',
            documentRenamed: (from, to) => void heard.push(`renamed ${from} to ${to}`),
            documentRemoved: (document) => void heard.push(`removed ${document}`),
            state: () => defaultBoardState(),
        })
        try {
            services.events.emit('concept:renamed', { from: 'Acme', to: 'Acme Corp' })
            services.events.emit('document:deleted', { documentId: 'Notes' })
            expect(heard).toEqual(['renamed Acme to Acme Corp', 'removed Notes'])
            expect(takeBoardHandover('Acme Corp')).toEqual(defaultBoardState())
        } finally {
            unregister()
        }
    })

    it('hears nothing once the extension is stopped', () => {
        const { context, services, dispose } = kanbanContext()
        registerKanban(context, board)
        const heard: string[] = []
        const unregister = registerBoard('board-acme', actions, {
            concept: 'Acme',
            documentRenamed: (from) => void heard.push(`renamed ${from}`),
            documentRemoved: () => {},
            state: () => defaultBoardState(),
        })
        try {
            dispose()
            services.events.emit('concept:renamed', { from: 'Acme', to: 'Acme Corp' })
            expect(heard).toEqual([])
            expect(takeBoardHandover('Acme Corp')).toBeUndefined()
        } finally {
            unregister()
        }
    })
})
