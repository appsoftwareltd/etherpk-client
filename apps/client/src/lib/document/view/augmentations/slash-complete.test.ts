import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, registerCommandMenuItem, setActiveContributionRegistry } from '$lib/surface'

import { editorAnalysis } from '../analysis/editor-analysis'
import { commandMenuOpen, slashCompletion } from './slash-complete'

// Whether the Command Menu is open: a Draft holds the text of a command being typed until it closes
// (draft.ts, ADR 0145 amended 2026-10-16), so this has to agree with the menu itself.
describe('whether the Command Menu is open', () => {
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerCommandMenuItem(registry, { id: 'garden.agent', title: 'Agent', command: 'garden.agent' })
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
})
