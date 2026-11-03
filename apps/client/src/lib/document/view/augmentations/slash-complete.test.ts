import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, registerCommandMenuItem, setActiveContributionRegistry } from '#lib/surface/index.js'

import { editorAnalysis } from '../analysis/editor-analysis'
import { showsPart } from '../shown-range'
import { commandMenuOpen, slashCompletion } from './slash-complete'

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

    /** `doc` with the caret where `|` is. */
    const at = (doc: string) => EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: doc.indexOf('|') }, extensions: [editorAnalysis(), slashCompletion()] })

    it('is open while a command is typed at the start of a line or after a space', () => {
        expect(commandMenuOpen(at('/|'))).toBe(true)
        expect(commandMenuOpen(at('- /age|'))).toBe(true)
        expect(commandMenuOpen(at('beans /a|'))).toBe(true)
    })

    it('is closed for a slash inside a word, in code, in the frontmatter, and once no row matches', () => {
        expect(commandMenuOpen(at('and/or|'))).toBe(false)
        expect(commandMenuOpen(at('```\n/a|\n```'))).toBe(false)
        expect(commandMenuOpen(at('---\ntitle: /a|\n---'))).toBe(false)
        expect(commandMenuOpen(at('/xyzzy|'))).toBe(false)
    })

    // The Task Editor's description and comments (ADR 0170): the menu reads it off the editor.
    it('offers only the rows that act on the text in an editor showing part of a document', () => {
        const part = (doc: string) => EditorState.create({ doc: doc.replace('|', ''), selection: { anchor: doc.indexOf('|') }, extensions: [editorAnalysis(), slashCompletion(), showsPart()] })
        expect(commandMenuOpen(part('- /age|'))).toBe(false)
        expect(commandMenuOpen(part('- /bo|'))).toBe(true)
        expect(commandMenuOpen(at('- /age|'))).toBe(true)
    })
})
