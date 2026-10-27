import { describe, expect, it } from 'vitest'
import { undo } from '@codemirror/commands'

import { editorFixture } from '../view/testing/editor-state-fixture'
import { type FindQuery, findMatches } from './find-matches'
import { isFindReplace } from './find-edit'
import { planReplace, replaceTransaction } from './find-replace'

function query(search: string, replace: string, options: Partial<FindQuery> = {}): FindQuery {
    return { search, replace, caseSensitive: false, wholeWord: false, regexp: false, ...options }
}

/**
 * Replace in `doc` through the editor's own filters, as the box does, and return the text, the
 * plan and the editor (for undo).
 */
function replace(doc: string, q: FindQuery, options: { one?: number; outsideLinks?: boolean } = {}) {
    const editor = editorFixture(doc + '|')
    const { matches } = findMatches(editor.state, q)
    const plan = planReplace(editor.state, q, matches, {
        scope: options.one === undefined ? { kind: 'all' } : { kind: 'one', index: options.one },
        outsideLinks: options.outsideLinks ?? false,
    })
    editor.dispatch(replaceTransaction(editor.state, plan))
    return { text: editor.text(), plan, editor }
}

describe('replacing text', () => {
    it('replaces every match in one edit, which one undo takes back', () => {
        const doc = '- water the beans\n- pick the beans'
        const { text, plan, editor } = replace(doc, query('beans', 'peas'))
        expect(text).toBe('- water the peas\n- pick the peas')
        expect(plan.replaced).toBe(2)
        undo(editor)
        expect(editor.text()).toBe(doc)
    })

    it('replaces one match, by its index', () => {
        expect(replace('Garden Garden Garden', query('Garden', 'Yard'), { one: 1 }).text).toBe('Garden Yard Garden')
    })

    it("puts a regular expression's groups into the replacement", () => {
        const { text } = replace('- water the beans', query('(\\w+) the (\\w+)', '$2 then $1, $&', { regexp: true }))
        expect(text).toBe('- beans then water, water the beans')
    })

    it('reads \\n in a regular expression replacement as a line break, and a plain one literally', () => {
        expect(replace('Garden Kitchen', query(' ', '\\n', { regexp: true })).text).toBe('Garden\nKitchen')
        expect(replace('Garden Kitchen', query(' ', '\\n')).text).toBe('Garden\\nKitchen')
    })

    it('deletes the matches when the replacement is empty', () => {
        expect(replace('Garden notes', query(' notes', '')).text).toBe('Garden')
    })

    it("leaves the document's names as they are, and counts what it kept", () => {
        const doc = ['---', 'title: Garden', 'aliases: [Garden Shed]', 'status: Garden', '---', 'Garden'].join('\n')
        const { text, plan } = replace(doc, query('Garden', 'Yard'))
        expect(text).toBe(['---', 'title: Garden', 'aliases: [Garden Shed]', 'status: Yard', '---', 'Yard'].join('\n'))
        expect(plan.replaced).toBe(2)
        expect(plan.kept).toBe(2)
    })

    // A key renamed into one of the names (`tags` → `aliases`) gives the page an alias, and one
    // renamed into a key the block has twice leaves the block unreadable: either way the names
    // change, so the replace leaves the frontmatter as it is (ADR 0153 §3).
    it("leaves the frontmatter as it is when the replace would change the page's names by any route", () => {
        const doc = ['---', 'title: Garden', 'tags: [Shed]', '---', '- tags'].join('\n')
        const { text, plan } = replace(doc, query('tags', 'aliases'))
        expect(text).toBe(['---', 'title: Garden', 'tags: [Shed]', '---', '- aliases'].join('\n'))
        expect(plan.replaced).toBe(1)
        expect(plan.keptNames).toBe(1)

        const status = ['---', 'title: Garden', 'status: Garden', '---', 'status'].join('\n')
        expect(replace(status, query('status', 'title')).text).toBe(['---', 'title: Garden', 'status: Garden', '---', 'title'].join('\n'))
    })

    it('still replaces a value in the frontmatter that leaves the names as they are', () => {
        const doc = ['---', 'title: Garden', 'status: draft', '---'].join('\n')
        expect(replace(doc, query('draft', 'done')).text).toBe(['---', 'title: Garden', 'status: done', '---'].join('\n'))
    })

    it('leaves the frontmatter delimiters as they are', () => {
        const doc = ['---', 'status: a', '---', 'text --- here'].join('\n')
        expect(replace(doc, query('---', '...')).text).toBe(['---', 'status: a', '---', 'text ... here'].join('\n'))
    })

    it('replaces nothing for a single replace of a kept match', () => {
        const doc = ['---', 'title: Garden', '---', 'Garden'].join('\n')
        const { text, plan } = replace(doc, query('Garden', 'Yard'), { one: 0 })
        expect(text).toBe(doc)
        expect(plan.replaced).toBe(0)
    })

    it('marks its edit as a replace, the user\'s own editing', () => {
        const editor = editorFixture('Garden|')
        const q = query('Garden', 'Yard')
        const tr = replaceTransaction(editor.state, planReplace(editor.state, q, findMatches(editor.state, q).matches, { scope: { kind: 'all' }, outsideLinks: false }))
        expect(isFindReplace(tr)).toBe(true)
        expect(tr.isUserEvent('input')).toBe(true)
    })
})

describe('what a replace proposes for wikilinks (ADR 0153)', () => {
    it('proposes renaming a concept once, however many links name it', () => {
        const { plan, text } = replace('- [[Garden]] notes\n- [[Garden]] again', query('Garden', 'Gardens'))
        expect(text).toBe('- [[Gardens]] notes\n- [[Gardens]] again')
        expect(plan.edits).toEqual([{ before: 'Garden', after: 'Gardens' }])
    })

    it('proposes the scope, which carries the scoped concept by the cascade', () => {
        const { plan } = replace('- [[[[Garden]] Tools]]', query('Garden', 'Yard'))
        expect(plan.edits).toEqual([{ before: 'Garden', after: 'Yard' }])
    })

    it("proposes the outer link when its own text changes", () => {
        const { plan } = replace('- [[[[Garden]] Tools]]', query('Tools', 'Shed'))
        expect(plan.edits).toEqual([{ before: '[[Garden]] Tools', after: '[[Garden]] Shed' }])
    })

    it('proposes nothing for prose, code or the frontmatter', () => {
        const doc = ['---', 'status: Garden', '---', 'Garden and `[[Garden]]`'].join('\n')
        expect(replace(doc, query('Garden', 'Yard')).plan.edits).toEqual([])
    })

    it('proposes nothing for a replace that unlinks, and counts the links it removed', () => {
        const { plan, text } = replace('- [[Garden]] and [[Kitchen]]', query('[[', ''))
        expect(text).toBe('- Garden]] and Kitchen]]')
        expect(plan.edits).toEqual([])
        expect(plan.linksRemoved).toBe(2)
    })

    it('proposes nothing for a match that runs from one link into the next, as typing it would', () => {
        const { plan, text } = replace('- [[Garden]] [[Kitchen]]', query('n]] [[K', 'n K'))
        expect(text).toBe('- [[Garden Kitchen]]')
        expect(plan.edits).toEqual([])
        expect(plan.linksRemoved).toBe(1)
    })

    it('replaces outside wikilinks only when asked, and counts what it left', () => {
        const { plan, text } = replace('- Garden and [[Garden]], [[Garden Tools]]', query('Garden', 'Yard'), { outsideLinks: true })
        expect(text).toBe('- Yard and [[Garden]], [[Garden Tools]]')
        expect(plan.edits).toEqual([])
        expect(plan.skippedInLinks).toBe(2)
    })

    it("gives the document's text after the replace, for the check of where else a name is used", () => {
        const { plan } = replace('- [[Garden]]', query('Garden', 'Gardens'))
        expect(plan.textAfter).toBe('- [[Gardens]]')
    })
})
