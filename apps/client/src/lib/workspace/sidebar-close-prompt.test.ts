import { describe, expect, it } from 'vitest'

import { closePrompt, reopeningChord } from './sidebar-close-prompt'

const WHERE = 'from Sidebar views, at the foot of the Activity Bar.'

describe('what closing a Sidebar View asks', () => {
    it('names the View and the shortcut that brings it back', () => {
        expect(closePrompt([{ name: 'Backlinks', chord: 'Alt+B' }], 'Close')).toEqual({ title: 'Close Backlinks?', message: 'Re-open it with Alt+B.', confirmLabel: 'Close' })
        expect(closePrompt([{ name: 'Tasks', chord: 'Alt+T' }], 'Hide')).toEqual({ title: 'Hide Tasks?', message: 'Re-open it with Alt+T.', confirmLabel: 'Hide' })
    })

    it('says where to find a View with no shortcut', () => {
        expect(closePrompt([{ name: 'Garden', chord: null }], 'Close').message).toBe(`Re-open it ${WHERE}`)
    })

    it('names every View a row closes, each with its own way back', () => {
        const backlinks = { name: 'Backlinks', chord: 'Alt+B' }
        const chats = { name: 'Agent Chats', chord: 'Alt+C' }
        const garden = { name: 'Garden', chord: null }
        const shed = { name: 'Shed', chord: null }
        expect(closePrompt([backlinks, chats], 'Close')).toEqual({
            title: 'Close Backlinks and Agent Chats?',
            message: 'Re-open Backlinks with Alt+B and Agent Chats with Alt+C.',
            confirmLabel: 'Close',
        })
        expect(closePrompt([backlinks, chats, garden], 'Close')).toEqual({
            title: 'Close Backlinks, Agent Chats and Garden?',
            message: `Re-open Backlinks with Alt+B and Agent Chats with Alt+C. Re-open Garden ${WHERE}`,
            confirmLabel: 'Close',
        })
        expect(closePrompt([garden, shed], 'Close').message).toBe(`Re-open Garden and Shed ${WHERE}`)
    })
})

describe('the shortcut a View is said to re-open with', () => {
    const bindings = [
        { key: 'Alt+B', command: 'backlinks.open' },
        { key: 'Ctrl+Alt+C', command: 'chats.show' },
    ]

    it('is the chord bound to its Command', () => {
        expect(reopeningChord(bindings, 'backlinks.open', false)).toBe('Alt + B')
    })

    it('is none without a Command, or with nothing bound to it', () => {
        expect(reopeningChord(bindings, undefined, false)).toBeNull()
        expect(reopeningChord(bindings, 'garden.show', false)).toBeNull()
    })

    it('is never Option and a letter alone on a Mac, which types a character there', () => {
        expect(reopeningChord(bindings, 'backlinks.open', true)).toBeNull()
        expect(reopeningChord(bindings, 'chats.show', true)).not.toBeNull()
    })
})
