import { EditorState, type Extension } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, registerCommandMenuItem, setActiveContributionRegistry } from '#lib/surface/index.js'

import { editorAnalysis } from '../analysis/editor-analysis'
import { showsPart } from '../shown-range'
import { commandBeingTyped, commandMenuOpen, resumeCommand, slashCompletion } from './slash-complete'

// Whether the Command Menu is open: a Draft holds the text of a command being typed until it closes
// (draft.ts, ADR 0145 amended 2026-10-16), so this has to agree with the menu itself.
describe('whether the Command Menu is open', () => {
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerCommandMenuItem(registry, { id: 'garden.agent', title: 'Agent', command: 'garden.agent' })
        registerCommandMenuItem(registry, { id: 'garden.bold', title: 'Bold', command: 'garden.bold', actsOnText: true })
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    /** `doc` with what is before the `|` typed a key at a time: only a typed `/` opens the menu. */
    function typed(doc: string, extensions: Extension[] = []): EditorState {
        const caret = doc.indexOf('|')
        let state = EditorState.create({ doc: doc.slice(caret + 1), extensions: [editorAnalysis(), slashCompletion(), ...extensions] })
        for (const key of doc.slice(0, caret)) state = state.update({ ...state.replaceSelection(key), userEvent: 'input.type' }).state
        return state
    }

    it('is open while a command is typed at the start of a line or after a space', () => {
        expect(commandMenuOpen(typed('/|'))).toBe(true)
        expect(commandMenuOpen(typed('- /age|'))).toBe(true)
        expect(commandMenuOpen(typed('beans /a|'))).toBe(true)
    })

    it('is closed for a slash inside a word, in code, in the frontmatter, and once no row matches', () => {
        expect(commandMenuOpen(typed('and/or|'))).toBe(false)
        expect(commandMenuOpen(typed('```\n/a|\n```'))).toBe(false)
        expect(commandMenuOpen(typed('---\ntitle: /a|\n---'))).toBe(false)
        expect(commandMenuOpen(typed('/xyzzy|'))).toBe(false)
    })

    it('is closed for a slash the caret was only placed behind', () => {
        const placed = EditorState.create({ doc: '/age', selection: { anchor: 4 }, extensions: [editorAnalysis(), slashCompletion()] })
        expect(commandMenuOpen(placed)).toBe(false)
    })

    // A Draft's promotion rebuilds the editor around the new page (DocumentView.svelte): a new
    // state starts with the menu closed, so a command being typed has to be carried across.
    describe('a command carried into a new editor', () => {
        const rebuilt = (from: EditorState) =>
            EditorState.create({ doc: from.doc, selection: from.selection, extensions: [editorAnalysis(), slashCompletion()] })

        it('opens the menu in the new editor', () => {
            const before = typed('- /ag|')
            expect(commandBeingTyped(before)).toBe(true)
            const after = rebuilt(before)
            expect(commandMenuOpen(after)).toBe(false)
            expect(commandMenuOpen(after.update(resumeCommand()).state)).toBe(true)
        })

        it('counts a query that matches no row, so deleting a key still brings the rows back', () => {
            const before = typed('- /agx|')
            expect(commandMenuOpen(before)).toBe(false)
            expect(commandBeingTyped(before)).toBe(true)
            const resumed = rebuilt(before).update(resumeCommand()).state
            expect(commandMenuOpen(resumed)).toBe(false)
            const deleted = resumed.update({ changes: { from: 5, to: 6 }, userEvent: 'delete.backward' }).state
            expect(commandMenuOpen(deleted)).toBe(true)
        })

        it('does not count a slash the caret was only placed behind', () => {
            expect(commandBeingTyped(rebuilt(typed('- /ag|')))).toBe(false)
        })

        it('opens nothing where no command can be typed', () => {
            const plain = EditorState.create({ doc: '- beans', selection: { anchor: 7 }, extensions: [editorAnalysis(), slashCompletion()] })
            expect(commandMenuOpen(plain.update(resumeCommand()).state)).toBe(false)
        })
    })

    // The Task Editor's description and comments (ADR 0170): the menu reads it off the editor.
    it('offers only the rows that act on the text in an editor showing part of a document', () => {
        const part = (doc: string) => typed(doc, [showsPart()])
        expect(commandMenuOpen(part('- /age|'))).toBe(false)
        expect(commandMenuOpen(part('- /bo|'))).toBe(true)
        expect(commandMenuOpen(typed('- /age|'))).toBe(true)
    })
})
